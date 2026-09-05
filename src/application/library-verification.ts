import { lstat } from 'node:fs/promises';
import { assertNoSymlinkPath } from '../core/maintenance-files.ts';
import type { ArticleRecord, ExportRecord, SourceRecord, StoredFile, StoredText } from '../core/domain.ts';
import { articleDirectory, sourceDirectory, exportDirectory, sourceStructureIndexPath, assertArticleInvariants } from '../core/library.ts';
import { analyzeMarkdown } from '../core/ingest/text.ts';
import { createSourceContentIndex, verifySourceContentIndex, type SourceContentIndex } from '../core/source-index.ts';
import { verifyCitationGrounding } from '../core/citation-grounding.ts';
import { validateRecord } from '../core/record-validation.ts';
import { versionedSha256 } from '../core/text.ts';
import { catalogStamp } from '../core/library-index.ts';
import { defaultArticleUserState, parsePersistedArticleUserState, type ArticleUserState } from '../core/user-state.ts';
import {
  assertFileMatches,
  describeFile,
  parseMaintenanceJson,
  readMaintenanceFile,
  walkMaintenanceFiles,
  MAX_FILES,
  MAX_JSON_BYTES,
  MAX_TOTAL_BYTES,
  type MaintenanceFile,
} from '../core/maintenance-files.ts';
import { createArticleSearchBlocks, createFullTextSearchIndex, type FullTextSearchDocumentInput } from '../core/full-text-search.ts';
import { corpusDocument, sourceBlocks } from './search-service.ts';

export interface VerificationFinding {
  severity: 'error' | 'warning'; code: string; path: string; action: string;
}
export interface VerificationReport {
  ok: boolean; errorCount: number; warningCount: number; findings: VerificationFinding[]; truncated: boolean;
  sourceCount: number; articleCount: number; exportCount: number; fileCount: number;
}
export interface VerifiedLibrary {
  report: VerificationReport; files: MaintenanceFile[]; sources: Map<string, SourceRecord>;
}

const ROOTS = ['sources', 'articles', 'exports', 'assets', 'state/articles'] as const;
const MANIFEST = /^(?:sources\/src_[a-z0-9]{16,64}|articles\/(?:archive|digest|synthesis)\/art_[a-z0-9]{16,64}|exports\/art_[a-z0-9]{16,64}\/exp_[a-z0-9]{16,64})\/manifest\.json$/u;
const STATE = /^state\/articles\/art_[a-z0-9]{16,64}\.json$/u;
const ACTIONS = {
  inventory: 'Stop writers; remove unsafe links or special files, check permissions and maintenance size limits, then retry.',
  manifest: 'Recover the canonical manifest from a known-good backup; never edit archived prose.',
  integrity: 'Recover the referenced file and manifest from a known-good backup.',
  references: 'Recover missing or inconsistent source/article/export records from a known-good backup.',
  state: 'Recover the article and its separate state record from a known-good backup.',
  index: 'Run library:maintain rebuild to regenerate derived indexes.',
  untracked: 'This unreferenced file is excluded from backup; preserve it separately if needed.',
} as const;

class Verification {
  readonly root: string;
  readonly files = new Map<string, MaintenanceFile>();
  private readonly fileBytes = new Map<string, Buffer>();
  readonly sources = new Map<string, SourceRecord>();
  readonly articles = new Map<string, ArticleRecord>();
  readonly exports = new Map<string, ExportRecord>();
  readonly contents = new Map<string, string>();
  readonly indexes = new Map<string, SourceContentIndex>();
  readonly states = new Map<string, ArticleUserState>();
  readonly report: VerificationReport = {
    ok: true, errorCount: 0, warningCount: 0, findings: [], truncated: false,
    sourceCount: 0, articleCount: 0, exportCount: 0, fileCount: 0,
  };
  private totalBytes = 0;
  constructor(root: string) { this.root = root; }

  finding(code: keyof typeof ACTIONS, relative: string, severity: 'error' | 'warning' = 'error'): void {
    if (severity === 'error') { this.report.errorCount++; this.report.ok = false; }
    else this.report.warningCount++;
    if (this.report.findings.length < 50) {
      this.report.findings.push({ severity, code, path: relative.replace(/[\x00-\x1f\x7f]/gu, '?').slice(0, 240), action: ACTIONS[code] });
    } else this.report.truncated = true;
  }

  async check(code: keyof typeof ACTIONS, relative: string, operation: () => Promise<void>, severity: 'error' | 'warning' = 'error'): Promise<void> {
    try { await operation(); } catch { this.finding(code, relative, severity); }
  }

  async track(relative: string, maximum?: number): Promise<Buffer> {
    const cached = this.fileBytes.get(relative);
    if (cached) return cached;
    const bytes = await readMaintenanceFile(this.root, relative, maximum);
    this.totalBytes += bytes.length;
    if (this.totalBytes > MAX_TOTAL_BYTES || this.files.size >= MAX_FILES) throw new Error('Maintenance snapshot size limit exceeded');
    this.files.set(relative, describeFile(relative, bytes));
    this.fileBytes.set(relative, bytes);
    return bytes;
  }

  async stored(file: StoredFile, prefix: string, text = false): Promise<void> {
    if (!file.path.startsWith(`${prefix}/`) || file.path.endsWith('/manifest.json')) throw new Error('Unexpected stored-file path');
    const bytes = await this.track(file.path);
    assertFileMatches(file, bytes);
    if (text) {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (analyzeMarkdown(content).textHash !== (file as StoredText).textHash) throw new Error('Text hash mismatch');
      this.contents.set(file.path, content);
    }
  }

  async manifest(relative: string): Promise<void> {
    const value = parseMaintenanceJson(await this.track(relative, MAX_JSON_BYTES));
    if (relative.startsWith('sources/')) {
      const source = await validateRecord<SourceRecord>('source', value);
      if (relative !== `${sourceDirectory(source.id)}/manifest.json` || this.sources.has(source.id)) throw new Error('Source identity mismatch');
      this.sources.set(source.id, source);
    } else if (relative.startsWith('articles/')) {
      const article = await validateRecord<ArticleRecord>('article', value);
      if (relative !== `${articleDirectory(article.mode, article.id)}/manifest.json` || this.articles.has(article.id)) throw new Error('Article identity collision');
      this.articles.set(article.id, article);
    } else {
      const record = await validateRecord<ExportRecord>('export', value);
      if (relative !== `${exportDirectory(record.articleId, record.id)}/manifest.json` || this.exports.has(record.id)) throw new Error('Export identity collision');
      this.exports.set(record.id, record);
    }
  }

  async source(source: SourceRecord): Promise<void> {
    const prefix = sourceDirectory(source.id);
    if (source.content.path !== `${prefix}/content.md`) throw new Error('Unexpected source content path');
    await this.stored(source.content, prefix, true);
    if (source.rawCapture) await this.stored(source.rawCapture, `${prefix}/raw`);
    for (const asset of source.assets ?? []) await this.stored(asset, `${prefix}/assets`);
    this.indexes.set(source.id, createSourceContentIndex(source, this.contents.get(source.content.path)!));
  }

  sourceLineage(source: SourceRecord): void {
    let current = source;
    const seen = new Set([source.id]);
    while (current.lineage) {
      const predecessor = this.sources.get(current.lineage.predecessorSourceId);
      const root = this.sources.get(current.lineage.rootSourceId);
      if (!predecessor || !root || root.lineage || seen.has(predecessor.id)) throw new Error('Invalid source lineage');
      if ((predecessor.lineage?.rootSourceId ?? predecessor.id) !== root.id) throw new Error('Inconsistent lineage root');
      seen.add(predecessor.id); current = predecessor;
    }
  }

  async article(article: ArticleRecord): Promise<void> {
    await this.stored(article.body, articleDirectory(article.mode, article.id), true);
    if (article.body.path !== `${articleDirectory(article.mode, article.id)}/content.md`) throw new Error('Unexpected article body path');
    this.articleReferences(article);
    // Older generated records legitimately predate coverage and diagnostic metadata.
    if (article.mode !== 'archive') {
      this.citations(article);
      for (const coverage of article.sourceCoverage?.sources ?? []) this.coverageSummary(coverage);
    }
    this.articleLineage(article);
  }

  articleReferences(article: ArticleRecord): void {
    if (article.mode === 'archive' || article.sourceCoverage) assertArticleInvariants(article, this.sources);
    else if (article.sourceIds.some((id) => !this.sources.has(id))) throw new Error('Missing source');
    if (article.citations.some((citation) => !article.sourceIds.includes(citation.sourceId))) throw new Error('Citation outside source set');
  }

  articleLineage(article: ArticleRecord): void {
    const seen = new Set([article.id]);
    let previous: ArticleRecord | undefined = article;
    while (previous.supersedesArticleId) {
      previous = this.articles.get(previous.supersedesArticleId);
      if (!previous || seen.has(previous.id)) throw new Error('Invalid article lineage');
      seen.add(previous.id);
    }
  }

  coverageSummary(coverage: NonNullable<ArticleRecord['sourceCoverage']>['sources'][number]): void {
    const index = this.indexes.get(coverage.sourceId)!;
    const locators = [...index.headings, ...index.paragraphs].sort((a, b) => a.startByte - b.startByte).map(({ id }) => id);
    const missing = new Set(coverage.missingLocators);
    const valid = [
      coverage.totalLocatorCount === locators.length,
      coverage.indexLocatorHash === versionedSha256(locators.join('\n')),
      missing.size === coverage.missingLocators.length,
      coverage.missingLocators.length === Math.min(20, coverage.missingLocatorCount),
      coverage.missingLocatorsTruncated === (coverage.missingLocatorCount > 20),
      coverage.missingLocators.every((locator) => locators.includes(locator)),
    ];
    if (!valid.every(Boolean)) throw new Error('Invalid source coverage summary');
    // Truncated targeted summaries deliberately do not retain every considered locator.
    if (!coverage.missingLocatorsTruncated) {
      const considered = locators.filter((locator) => !missing.has(locator));
      if (versionedSha256(considered.join('\n')) !== coverage.consideredLocatorHash) throw new Error('Invalid considered-locator hash');
    }
  }

  citations(article: ArticleRecord): void {
    const content = this.contents.get(article.body.path)!;
    const markers = new Set([...content.matchAll(/\[\^(cite_[a-z0-9][a-z0-9_-]{0,63})\](?!:)/giu)].map((match) => match[1]));
    const ids = new Set(article.citations.map((citation) => citation.id));
    if (ids.size !== article.citations.length || ids.size !== markers.size || [...ids].some((id) => !markers.has(id)) || /\[\^cite_[a-z0-9_-]+\]:/iu.test(content)) throw new Error('Invalid inline citations');
    if (article.citations.some((citation) => !article.sourceIds.includes(citation.sourceId))) throw new Error('Citation outside source set');
    const sources = new Map(article.sourceIds.map((id) => {
      const source = this.sources.get(id)!;
      return [id, { source, content: this.contents.get(source.content.path)!, index: this.indexes.get(id)! }];
    }));
    const diagnostics = verifyCitationGrounding(content, article.citations, sources);
    if (article.citationDiagnostics && JSON.stringify(diagnostics) !== JSON.stringify(article.citationDiagnostics)) throw new Error('Citation diagnostics mismatch');
  }

  preparedExport(record: ExportRecord): ExportRecord | undefined {
    const id = record.delivery?.preparedExportId;
    if (!id) return undefined;
    const prepared = this.exports.get(id);
    if (!prepared) throw new Error('Missing prepared export');
    const valid = [
      prepared.id !== record.id,
      !prepared.delivery?.preparedExportId,
      prepared.articleId === record.articleId,
      prepared.format === record.format,
      prepared.destination.type === 'local',
      prepared.status === 'prepared',
      JSON.stringify(prepared.artifact) === JSON.stringify(record.artifact),
    ];
    if (!valid.every(Boolean)) throw new Error('Invalid prepared export reference');
    return prepared;
  }

  async exportRecord(record: ExportRecord): Promise<void> {
    if (!this.articles.has(record.articleId)) throw new Error('Unknown exported article');
    const prepared = this.preparedExport(record);
    const prefix = exportDirectory(record.articleId, prepared?.id ?? record.id);
    await this.stored(record.artifact, prefix);
    for (const asset of record.assets ?? []) await this.stored(asset, `${exportDirectory(record.articleId, record.id)}/assets`);
  }

  async state(relative: string): Promise<void> {
    const value = parseMaintenanceJson(await this.track(relative, MAX_JSON_BYTES));
    await validateRecord('article-user-state', value);
    const state = parsePersistedArticleUserState(value);
    if (relative !== `state/articles/${state.articleId}.json` || !this.articles.has(state.articleId)) throw new Error('Orphan user state');
    this.states.set(state.articleId, state);
  }

  async derivedIndexes(): Promise<void> {
    for (const source of this.sources.values()) {
      const relative = sourceStructureIndexPath(source.id);
      await this.check('index', relative, async () => {
        const value = parseMaintenanceJson(await readMaintenanceFile(this.root, relative));
        verifySourceContentIndex(source, this.contents.get(source.content.path)!, value as SourceContentIndex);
      }, 'warning');
    }
    await this.check('index', 'indexes/library.json', async () => {
      const parsed = parseMaintenanceJson(await readMaintenanceFile(this.root, 'indexes/library.json'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid library index');
      const value = parsed as { schemaVersion?: unknown; revision?: unknown; sources?: unknown; articles?: unknown; catalog?: unknown };
      const byId = (records: Array<{ id: string }>) => JSON.stringify([...records].sort((a, b) => a.id.localeCompare(b.id)));
      if (
        value.schemaVersion !== 1
        || typeof value.revision !== 'number'
        || !Number.isSafeInteger(value.revision)
        || value.revision < 1
        || !Array.isArray(value.sources)
        || !Array.isArray(value.articles)
        || byId(value.sources) !== byId([...this.sources.values()])
        || byId(value.articles) !== byId([...this.articles.values()])
      ) throw new Error('Stale library index');
      if (JSON.stringify(value.catalog) !== JSON.stringify(await catalogStamp(this.root))) throw new Error('Stale catalog stamps');
      const dirty = await walkMaintenanceFiles(this.root, 'indexes/dirty');
      if (dirty.length) throw new Error('Dirty library index');
    }, 'warning');
    await this.check('index', 'indexes/search-v1.json', async () => {
      const value = parseMaintenanceJson(await readMaintenanceFile(this.root, 'indexes/search-v1.json'));
      const inputs: FullTextSearchDocumentInput[] = [...this.articles.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).map((article) => {
        const content = this.contents.get(article.body.path)!;
        const index = this.indexes.get(article.sourceIds[0]!);
        const blocks = article.mode === 'archive' ? sourceBlocks([...index!.headings, ...index!.paragraphs]) : createArticleSearchBlocks(content);
        return { ...corpusDocument(article, this.sources, this.states.get(article.id) ?? defaultArticleUserState(article.id)), content, blocks };
      });
      const expected = createFullTextSearchIndex(inputs);
      if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error('Stale search index');
    }, 'warning');
  }

  async canonicalRecords(inventory: readonly string[]): Promise<void> {
    for (const relative of inventory.filter((name) => name.endsWith('/manifest.json'))) {
      if (!MANIFEST.test(relative)) this.finding('manifest', relative);
      else await this.check('manifest', relative, () => this.manifest(relative));
    }
    for (const source of this.sources.values()) {
      await this.check('integrity', source.content.path, () => this.source(source));
      await this.check('references', `${sourceDirectory(source.id)}/manifest.json`, async () => this.sourceLineage(source));
    }
    for (const article of this.articles.values()) {
      await this.check('references', article.body.path, () => this.article(article));
    }
    for (const record of this.exports.values()) await this.check('references', `${exportDirectory(record.articleId, record.id)}/manifest.json`, () => this.exportRecord(record));
  }

  async userState(inventory: readonly string[]): Promise<void> {
    for (const relative of inventory.filter((name) => name.startsWith('state/articles/'))) {
      if (!STATE.test(relative)) this.finding('state', relative);
      else await this.check('state', relative, () => this.state(relative));
    }
  }

  untracked(inventory: readonly string[]): void {
    const paths = new Set(inventory);
    for (const relative of inventory) {
      if (this.files.has(relative)) continue;
      const depth = relative.startsWith('sources/') ? 2 : 3;
      const recordDirectory = relative.split('/').slice(0, depth).join('/');
      if (!relative.startsWith('assets/') && !paths.has(`${recordDirectory}/manifest.json`)) this.finding('manifest', relative);
      else this.finding('untracked', relative, 'warning');
    }
  }

  async run(checkIndexes: boolean): Promise<VerifiedLibrary> {
    const inventory: string[] = [];
    await this.check('inventory', '.', async () => {
      await assertNoSymlinkPath(this.root);
      if (!(await lstat(this.root)).isDirectory()) throw new Error('Library root must exist');
    });
    if (!this.report.ok) return { report: this.report, files: [], sources: this.sources };
    for (const root of ROOTS) await this.check('inventory', root, async () => {
      const files = await walkMaintenanceFiles(this.root, root);
      if (inventory.length + files.length > MAX_FILES) throw new Error('Maintenance file count exceeded');
      inventory.push(...files);
    });
    await this.canonicalRecords(inventory);
    await this.userState(inventory);
    this.untracked(inventory);
    if (checkIndexes) await this.derivedIndexes();
    this.report.sourceCount = this.sources.size; this.report.articleCount = this.articles.size;
    this.report.exportCount = this.exports.size; this.report.fileCount = this.files.size;
    return { report: this.report, files: [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path)), sources: this.sources };
  }
}

/** Read-only: scans canonical records without consulting or repairing caches. */
export async function inspectLibrary(root: string, checkIndexes = true): Promise<VerifiedLibrary> {
  return new Verification(root).run(checkIndexes);
}
