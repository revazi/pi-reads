import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ArticleMode,
  ArticleRecord,
  Citation,
  GeneratedBy,
  IngestedSourceDraft,
  SourceRecord,
  StoredText,
} from '../core/domain.ts';
import { verifyCitationGrounding } from '../core/citation-grounding.ts';
import {
  verifySourceCoverage,
  type SourceCoverageInput,
} from '../core/source-coverage.ts';
import { analyzeMarkdown } from '../core/ingest/text.ts';
import { ingestSource, type IngestSourceDependencies, type SourceInput } from '../core/ingest/index.ts';
import {
  articleContentPath,
  articleDirectory,
  assertArticleInvariants,
  assertSafeLibraryRoot,
  chooseAvailableSlug,
  createImmutableRecordDirectory,
  createRecordId,
  resolveLibraryPath,
  sourceContentPath,
  sourceDirectory,
  sourceStructureIndexPath,
  writeLibraryFileAtomic,
  type RecordIdPrefix,
} from '../core/library.ts';
import { LibraryIndexStore, type LibraryIndexStats } from '../core/library-index.ts';
import { assertSafeSlug } from '../core/slugs.ts';
import {
  createSourceContentIndex,
  verifySourceContentIndex,
  type SourceContentIndex,
} from '../core/source-index.ts';
import {
  readSourceRange as readIndexedSourceRange,
  searchSourceText as searchIndexedSourceText,
  sourceOutline as createSourceOutline,
  type SourceOutline,
  type SourceRangeRead,
  type SourceSearchMatch,
} from '../core/source-retrieval.ts';
import { versionedSha256 } from '../core/text.ts';

const ARTICLE_MODES: readonly ArticleMode[] = ['archive', 'digest', 'synthesis'];
const RECORD_ID_PATTERN = /^(src|art|exp)_[a-z0-9]{16,64}$/;
const CITATION_ID_PATTERN = /^cite_[a-z0-9][a-z0-9_-]{0,63}$/;

export interface LibraryServiceOptions {
  libraryDir: string;
  allowGitWorkingTree?: boolean;
  now?: () => Date;
  createId?: (prefix: RecordIdPrefix) => string;
}

export interface CaptureResult {
  source: SourceRecord;
  archiveArticle: ArticleRecord;
  sourceManifestPath: string;
  sourceContentPath: string;
  articleManifestPath: string;
  articleContentPath: string;
  sourceIndexPath: string;
}

export interface SaveGeneratedArticleInput {
  mode: 'digest' | 'synthesis';
  title: string;
  slug?: string;
  description?: string;
  body: string;
  sourceIds: string[];
  citations: Citation[];
  generatedBy: GeneratedBy;
  coverage: SourceCoverageInput;
}

export interface StoredArticle {
  article: ArticleRecord;
  manifestPath: string;
  contentPath: string;
  content: string;
}

export interface StoredSource {
  source: SourceRecord;
  manifestPath: string;
  contentPath: string;
  content: string;
}

export interface StoredSourceIndex {
  index: SourceContentIndex;
  indexPath: string;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertRecordId(value: string, prefix?: 'src' | 'art' | 'exp'): void {
  const match = RECORD_ID_PATTERN.exec(value);
  if (!match || (prefix && match[1] !== prefix)) {
    throw new Error(`Invalid ${prefix ?? 'record'} ID: ${value}`);
  }
}

function rawCaptureName(mediaType: string | undefined): string {
  switch (mediaType) {
    case 'text/html':
      return 'source.html';
    case 'text/plain':
      return 'source.txt';
    default:
      return 'source.bin';
  }
}

function assertStoredTextIntegrity(content: string, stored: StoredText, label: string): void {
  const analysis = analyzeMarkdown(content);
  if (analysis.contentHash !== stored.contentHash) {
    throw new Error(`${label} content hash mismatch`);
  }
  if (analysis.textHash !== stored.textHash) {
    throw new Error(`${label} text hash mismatch`);
  }
  if (Buffer.byteLength(content) !== stored.byteLength) {
    throw new Error(`${label} byte length mismatch`);
  }
}

function citationMarkers(markdown: string): Set<string> {
  if (/\[\^cite_[a-z0-9_-]+\]:/iu.test(markdown)) {
    throw new Error('Generated article body must not define citation footnotes; exporters generate them from metadata');
  }

  return new Set([...markdown.matchAll(/\[\^(cite_[a-z0-9][a-z0-9_-]{0,63})\](?!:)/giu)].map((match) => match[1]));
}

export class LibraryService {
  readonly libraryDir: string;
  private readonly allowGitWorkingTree: boolean;
  private readonly now: () => Date;
  private readonly createId: (prefix: RecordIdPrefix) => string;
  private readonly index: LibraryIndexStore;

  constructor(options: LibraryServiceOptions) {
    this.libraryDir = path.resolve(options.libraryDir);
    this.allowGitWorkingTree = options.allowGitWorkingTree ?? false;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((prefix) => createRecordId(prefix));
    this.index = new LibraryIndexStore(this.libraryDir, {
      allowGitWorkingTree: this.allowGitWorkingTree,
      now: this.now,
    });
  }

  private async ensureLibrary(): Promise<void> {
    await assertSafeLibraryRoot(this.libraryDir, { allowGitWorkingTree: this.allowGitWorkingTree });
    await mkdir(this.libraryDir, { recursive: true });
  }

  private absolute(relativePath: string): string {
    return resolveLibraryPath(this.libraryDir, relativePath);
  }

  async capture(
    input: SourceInput,
    dependencies: IngestSourceDependencies = {},
    signal?: AbortSignal,
  ): Promise<CaptureResult> {
    await this.ensureLibrary();
    const draft = await ingestSource(input, dependencies, signal);
    signal?.throwIfAborted();
    const { source, archiveArticle } = await this.index.transaction(async (index) => {
      const source = await this.storeSource(draft);
      const archiveArticle = await this.storeArchive(source, draft, index.articles);
      await this.writeSourceIndex(source, draft.content);
      return {
        value: { source, archiveArticle },
        sources: [...index.sources, source],
        articles: [...index.articles, archiveArticle],
      };
    });

    return {
      source,
      archiveArticle,
      sourceManifestPath: this.absolute(path.posix.join(sourceDirectory(source.id), 'manifest.json')),
      sourceContentPath: this.absolute(source.content.path),
      articleManifestPath: this.absolute(path.posix.join(articleDirectory('archive', archiveArticle.id), 'manifest.json')),
      articleContentPath: this.absolute(archiveArticle.body.path),
      sourceIndexPath: this.absolute(sourceStructureIndexPath(source.id)),
    };
  }

  private async storeSource(draft: IngestedSourceDraft): Promise<SourceRecord> {
    const id = this.createId('src');
    assertRecordId(id, 'src');
    const directory = sourceDirectory(id);
    const contentPath = sourceContentPath(id);
    const capturedAt = this.now().toISOString();
    const rawName = draft.rawContent === undefined ? undefined : rawCaptureName(draft.rawMediaType);
    const rawPath = rawName ? path.posix.join(directory, 'raw', rawName) : undefined;

    const source: SourceRecord = {
      schemaVersion: 1,
      id,
      kind: draft.kind,
      ...(draft.title ? { title: draft.title } : {}),
      ...(draft.description ? { description: draft.description } : {}),
      ...(draft.authors ? { authors: draft.authors } : {}),
      ...(draft.publishedAt ? { publishedAt: draft.publishedAt } : {}),
      capturedAt,
      origin: {
        locator: draft.locator,
        ...(draft.canonicalUrl ? { canonicalUrl: draft.canonicalUrl } : {}),
      },
      content: {
        path: contentPath,
        mediaType: 'text/markdown',
        contentHash: draft.contentHash,
        textHash: draft.textHash,
        byteLength: Buffer.byteLength(draft.content),
      },
      ...(rawPath && draft.rawContent !== undefined
        ? {
            rawCapture: {
              path: rawPath,
              mediaType: draft.rawMediaType ?? 'application/octet-stream',
              contentHash: versionedSha256(draft.rawContent),
              byteLength: Buffer.byteLength(draft.rawContent),
            },
          }
        : {}),
      capture: draft.capture,
    };

    await createImmutableRecordDirectory(
      this.libraryDir,
      directory,
      [
        { path: 'content.md', contents: draft.content },
        ...(rawName && draft.rawContent !== undefined
          ? [{ path: path.posix.join('raw', rawName), contents: draft.rawContent }]
          : []),
        { path: 'manifest.json', contents: json(source) },
      ],
      { allowGitWorkingTree: this.allowGitWorkingTree },
    );

    return source;
  }

  private async storeArchive(
    source: SourceRecord,
    draft: IngestedSourceDraft,
    existingArticles: readonly ArticleRecord[],
  ): Promise<ArticleRecord> {
    const id = this.createId('art');
    assertRecordId(id, 'art');
    const slug = chooseAvailableSlug(source.title ?? 'article', existingArticles.map((item) => item.slug));
    const bodyPath = articleContentPath('archive', id);
    const article: ArticleRecord = {
      schemaVersion: 1,
      id,
      mode: 'archive',
      title: source.title ?? 'Untitled article',
      slug,
      ...(source.description ? { description: source.description } : {}),
      ...(source.authors ? { authors: source.authors } : {}),
      sourceIds: [source.id],
      body: {
        path: bodyPath,
        mediaType: 'text/markdown',
        contentHash: draft.contentHash,
        textHash: draft.textHash,
        byteLength: Buffer.byteLength(draft.content),
      },
      citations: [],
      createdAt: this.now().toISOString(),
      archiveVerification: {
        sourceId: source.id,
        sourceTextHash: source.content.textHash,
      },
      ...(draft.sourceFontStyle ? { presentation: { sourceFontStyle: draft.sourceFontStyle } } : {}),
    };
    assertArticleInvariants(article, new Map([[source.id, source]]));

    const directory = articleDirectory('archive', id);
    await createImmutableRecordDirectory(
      this.libraryDir,
      directory,
      [
        { path: 'content.md', contents: draft.content },
        { path: 'manifest.json', contents: json(article) },
      ],
      { allowGitWorkingTree: this.allowGitWorkingTree },
    );
    return article;
  }

  async saveGenerated(input: SaveGeneratedArticleInput): Promise<StoredArticle> {
    await this.ensureLibrary();
    if (!input.title.trim()) {
      throw new Error('Generated article title is required');
    }
    if (input.sourceIds.length === 0) {
      throw new Error('Generated article requires at least one source');
    }

    const analysis = analyzeMarkdown(input.body);
    const markers = citationMarkers(input.body);
    const citationIds = new Set<string>();
    for (const citation of input.citations) {
      if (!CITATION_ID_PATTERN.test(citation.id)) {
        throw new Error(`Invalid citation ID: ${citation.id}`);
      }
      if (citationIds.has(citation.id)) {
        throw new Error(`Duplicate citation ID ${citation.id}`);
      }
      citationIds.add(citation.id);
      if (!markers.has(citation.id)) {
        throw new Error(`Article body does not reference citation ${citation.id}`);
      }
    }
    for (const marker of markers) {
      if (!citationIds.has(marker)) {
        throw new Error(`Article body references unknown citation ${marker}`);
      }
    }

    const sourceIds = [...new Set(input.sourceIds)];
    const storedSources = await Promise.all(sourceIds.map((sourceId) => this.loadSource(sourceId)));
    const sources = new Map(storedSources.map((stored) => [stored.source.id, stored.source] as const));
    const sourceIndexes = new Map(await Promise.all(storedSources.map(async (stored) => [
      stored.source.id,
      (await this.ensureSourceIndex(stored)).index,
    ] as const)));
    const citationDiagnostics = verifyCitationGrounding(
      input.body,
      input.citations,
      new Map(storedSources.map((stored) => [stored.source.id, {
        source: stored.source,
        index: sourceIndexes.get(stored.source.id)!,
        content: stored.content,
      }] as const)),
    );
    const sourceCoverage = verifySourceCoverage(input.mode, sourceIds, sourceIndexes, input.coverage);
    return this.index.transaction(async (index) => {
      const slug = input.slug
        ? assertSafeSlug(input.slug)
        : chooseAvailableSlug(input.title, index.articles.map((item) => item.slug));
      if (index.articles.some((item) => item.slug === slug)) {
        throw new Error(`Article slug already exists: ${slug}`);
      }

      const id = this.createId('art');
      assertRecordId(id, 'art');
      const bodyPath = articleContentPath(input.mode, id);
      const article: ArticleRecord = {
        schemaVersion: 1,
        id,
        mode: input.mode,
        title: input.title.trim(),
        slug,
        ...(input.description ? { description: input.description } : {}),
        sourceIds,
        body: {
          path: bodyPath,
          mediaType: 'text/markdown',
          contentHash: analysis.contentHash,
          textHash: analysis.textHash,
          byteLength: Buffer.byteLength(input.body),
        },
        citations: input.citations,
        createdAt: this.now().toISOString(),
        generatedBy: input.generatedBy,
        sourceCoverage,
        citationDiagnostics,
      };
      assertArticleInvariants(article, sources);

      const directory = articleDirectory(input.mode, id);
      await createImmutableRecordDirectory(
        this.libraryDir,
        directory,
        [
          { path: 'content.md', contents: input.body },
          { path: 'manifest.json', contents: json(article) },
        ],
        { allowGitWorkingTree: this.allowGitWorkingTree },
      );
      const stored = {
        article,
        manifestPath: this.absolute(path.posix.join(directory, 'manifest.json')),
        contentPath: this.absolute(bodyPath),
        content: input.body,
      };
      return {
        value: stored,
        sources: index.sources,
        articles: [...index.articles, article],
      };
    });
  }

  async listArticles(): Promise<ArticleRecord[]> {
    await this.ensureLibrary();
    return [...(await this.index.read()).articles];
  }

  async searchArticles(query: string, limit = 50): Promise<ArticleRecord[]> {
    await this.ensureLibrary();
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Article search limit must be an integer from 1 to 1000');
    }
    const articles = (await this.index.read()).articles;
    return articles.filter((article) => [
      article.id,
      article.mode,
      article.title,
      article.slug,
      article.description ?? '',
      ...(article.authors ?? []),
    ].join('\n').toLowerCase().includes(needle)).slice(0, limit);
  }

  async rebuildIndex(): Promise<LibraryIndexStats> {
    await this.ensureLibrary();
    return this.index.rebuild();
  }

  private async writeSourceIndex(source: SourceRecord, content: string): Promise<StoredSourceIndex> {
    const index = createSourceContentIndex(source, content);
    const relativeIndexPath = sourceStructureIndexPath(source.id);
    await writeLibraryFileAtomic(
      this.libraryDir,
      relativeIndexPath,
      json(index),
      { allowGitWorkingTree: this.allowGitWorkingTree },
    );
    verifySourceContentIndex(source, content, index);
    return { index, indexPath: this.absolute(relativeIndexPath) };
  }

  async rebuildSourceIndex(sourceId: string): Promise<StoredSourceIndex> {
    const stored = await this.loadSource(sourceId);
    return this.writeSourceIndex(stored.source, stored.content);
  }

  private async readSourceIndex(stored: StoredSource): Promise<StoredSourceIndex> {
    const indexPath = this.absolute(sourceStructureIndexPath(stored.source.id));
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as SourceContentIndex;
    verifySourceContentIndex(stored.source, stored.content, index);
    return { index, indexPath };
  }

  async loadSourceIndex(sourceId: string): Promise<StoredSourceIndex> {
    const stored = await this.loadSource(sourceId);
    try {
      return await this.readSourceIndex(stored);
    } catch (error: unknown) {
      throw new Error(`Could not read source content index for ${sourceId}: ${String(error)}`);
    }
  }

  private async ensureSourceIndex(stored: StoredSource): Promise<StoredSourceIndex> {
    try {
      return await this.readSourceIndex(stored);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.writeSourceIndex(stored.source, stored.content);
    }
  }

  async sourceOutline(sourceId: string): Promise<SourceOutline> {
    const stored = await this.loadSource(sourceId);
    const { index } = await this.ensureSourceIndex(stored);
    return createSourceOutline(index);
  }

  async readSourceRange(
    sourceId: string,
    startLocator: string,
    endLocator?: string,
    startByte?: number,
  ): Promise<SourceRangeRead> {
    const stored = await this.loadSource(sourceId);
    const { index } = await this.ensureSourceIndex(stored);
    return readIndexedSourceRange(index, stored.content, startLocator, endLocator, startByte);
  }

  async searchSourceText(
    sourceId: string,
    query: string,
    options: { limit?: number; contextCharacters?: number } = {},
  ): Promise<SourceSearchMatch[]> {
    const stored = await this.loadSource(sourceId);
    const { index } = await this.ensureSourceIndex(stored);
    return searchIndexedSourceText(index, stored.content, query, options);
  }

  async loadSource(sourceId: string): Promise<StoredSource> {
    await this.ensureLibrary();
    assertRecordId(sourceId, 'src');
    const manifestPath = this.absolute(path.posix.join(sourceDirectory(sourceId), 'manifest.json'));
    const source = JSON.parse(await readFile(manifestPath, 'utf8')) as SourceRecord;
    if (source.id !== sourceId) {
      throw new Error(`Source manifest ID mismatch for ${sourceId}`);
    }
    if (source.content.path !== sourceContentPath(sourceId)) {
      throw new Error(`Source content path mismatch for ${sourceId}`);
    }
    const contentPath = this.absolute(source.content.path);
    const content = await readFile(contentPath, 'utf8');
    assertStoredTextIntegrity(content, source.content, `Source ${sourceId}`);
    return { source, manifestPath, contentPath, content };
  }

  async loadArticle(articleId: string): Promise<StoredArticle> {
    await this.ensureLibrary();
    assertRecordId(articleId, 'art');
    for (const mode of ARTICLE_MODES) {
      const manifestPath = this.absolute(path.posix.join(articleDirectory(mode, articleId), 'manifest.json'));
      try {
        const article = JSON.parse(await readFile(manifestPath, 'utf8')) as ArticleRecord;
        if (article.id !== articleId || article.mode !== mode) {
          throw new Error(`Article manifest identity mismatch for ${articleId}`);
        }
        if (article.body.path !== articleContentPath(mode, articleId)) {
          throw new Error(`Article content path mismatch for ${articleId}`);
        }
        const contentPath = this.absolute(article.body.path);
        const content = await readFile(contentPath, 'utf8');
        assertStoredTextIntegrity(content, article.body, `Article ${articleId}`);
        return { article, manifestPath, contentPath, content };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw error;
      }
    }
    throw new Error(`Article not found: ${articleId}`);
  }
}
