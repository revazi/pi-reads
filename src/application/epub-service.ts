import path from 'node:path';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type {
  ArticleRecord,
  Citation,
  ExportRecord,
  ReadingCollectionRecord,
  SourceRecord,
} from '../core/domain.ts';
import {
  createImmutableRecordDirectory,
  createRecordId,
  exportDirectory,
  resolveLibraryPath,
  type RecordIdPrefix,
} from '../core/library.ts';
import { versionedSha256 } from '../core/text.ts';
import type { DownloadedAsset } from '../adapters/destinations/obsidian.ts';
import { prepareArticleAssets, type PreparedArticleAsset } from './obsidian-service.ts';
import { LibraryService } from './library-service.ts';
import { ReadingCollectionService } from './reading-collection-service.ts';

const EPUB_MIMETYPE = 'application/epub+zip';
const CONTAINER_PATH = 'META-INF/container.xml';
const PACKAGE_PATH = 'EPUB/package.opf';
const NAV_PATH = 'EPUB/nav.xhtml';
const CSS_PATH = 'EPUB/styles.css';

const EPUB_CSS = `body {
  color: #111;
  background: #fff;
  font-family: serif;
  line-height: 1.55;
  margin: 5%;
}
h1, h2, h3, h4 { line-height: 1.2; }
img { display: block; max-width: 100%; height: auto; margin: 1em auto; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
code { font-family: monospace; }
a { color: inherit; }
blockquote { border-left: 0.2em solid #999; margin-left: 0; padding-left: 1em; }
.article-meta, .article-source { color: #555; font-size: 0.9em; }
.article-coverage-warning { border-left: 0.2em solid #9a6700; padding-left: 0.75em; }
.article-citations { border-top: 1px solid #bbb; margin-top: 2em; padding-top: 1em; }
`;

export interface EpubServiceOptions {
  library: LibraryService;
  collections?: ReadingCollectionService;
  now?: () => Date;
  createId?: (prefix: RecordIdPrefix) => string;
  fetchAsset?: (url: string, signal?: AbortSignal) => Promise<DownloadedAsset>;
}

export interface PreparedEpubExport {
  record: ExportRecord;
  manifestPath: string;
  artifactPath: string;
  validation: EpubValidation;
}

export interface EpubValidation {
  files: string[];
  manifestItems: number;
  spineItems: number;
  embeddedAssets: number;
}

interface RenderedEpub {
  bytes: Uint8Array;
  validation: EpubValidation;
}

interface RenderedChapter {
  article: ArticleRecord;
  sources: SourceRecord[];
  href: string;
  xhtml: string;
  assets: PreparedArticleAsset[];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function sourceLabel(source: SourceRecord): string {
  return source.title || source.origin.canonicalUrl || source.id;
}

function replaceCitationMarkers(markdown: string, citations: readonly Citation[]): string {
  return citations.reduce((current, citation, index) => {
    const marker = `[^${citation.id}]`;
    const replacement = `<sup><a epub:type="noteref" href="#${escapeXml(citation.id)}">[${index + 1}]</a></sup>`;
    return current.split(marker).join(replacement);
  }, markdown);
}

function citationSection(article: ArticleRecord, sources: ReadonlyMap<string, SourceRecord>): string {
  if (article.citations.length === 0) return '';
  const items = article.citations.map((citation, index) => {
    const source = sources.get(citation.sourceId);
    if (!source) throw new Error(`Citation ${citation.id} references unavailable source ${citation.sourceId}`);
    const label = escapeXml(sourceLabel(source));
    const url = source.origin.canonicalUrl;
    const linked = url ? `<a href="${escapeXml(url)}">${label}</a>` : label;
    const locator = citation.locator?.heading ? `, ${escapeXml(citation.locator.heading)}` : '';
    const quote = citation.quote ? `<blockquote>${escapeXml(citation.quote)}</blockquote>` : '';
    return `<li id="${escapeXml(citation.id)}"><span>[${index + 1}] ${linked}${locator}</span>${quote}</li>`;
  });
  return `<section class="article-citations" epub:type="bibliography"><h2>Sources</h2><ol>${items.join('')}</ol></section>`;
}

function xhtmlBody(html: string): string {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const serializer = new dom.window.XMLSerializer();
  return [...dom.window.document.body.childNodes].map((node) => serializer.serializeToString(node)).join('');
}

function modifiedTimestamp(value: string): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="${PACKAGE_PATH}" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
}

function navXhtml(title: string, language: string, chapters: readonly RenderedChapter[]): string {
  const items = chapters.map((chapter) => `<li><a href="${escapeXml(chapter.href)}">${escapeXml(chapter.article.title)}</a></li>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(language)}">
<head><meta charset="utf-8"/><title>${escapeXml(title)} — Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>${escapeXml(title)}</h1><ol>${items}</ol></nav></body>
</html>`;
}

function articleXhtml(
  article: ArticleRecord,
  sources: readonly SourceRecord[],
  body: string,
  stylesheetHref: string,
  showMode: boolean,
): string {
  const authors = article.authors ?? [...new Set(sources.flatMap((source) => source.authors ?? []))];
  const sourceLinks = sources
    .map((source) => source.origin.canonicalUrl
      ? `<a href="${escapeXml(source.origin.canonicalUrl)}">${escapeXml(sourceLabel(source))}</a>`
      : escapeXml(sourceLabel(source)))
    .join(' · ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(article.language ?? 'en')}">
<head><meta charset="utf-8"/><title>${escapeXml(article.title)}</title><link rel="stylesheet" type="text/css" href="${escapeXml(stylesheetHref)}"/></head>
<body><article><header><h1>${escapeXml(article.title)}</h1>${showMode ? `<p class="article-meta">Mode: ${escapeXml(article.mode)}</p>` : ''}${authors.length ? `<p class="article-meta">${escapeXml(authors.join(', '))}</p>` : ''}${sourceLinks ? `<p class="article-source">Sources: ${sourceLinks}</p>` : ''}${article.sourceCoverage?.warning ? `<p class="article-coverage-warning">${escapeXml(article.sourceCoverage.warning)}</p>` : ''}</header><main>${body}</main></article></body>
</html>`;
}

function packageOpf(
  publication: { id: string; title: string; language: string; description?: string },
  chapters: readonly RenderedChapter[],
  modifiedAt: string,
): string {
  const creators = [...new Set(chapters.flatMap(({ article, sources }) =>
    article.authors ?? sources.flatMap((source) => source.authors ?? [])))]
    .map((author) => `<dc:creator>${escapeXml(author)}</dc:creator>`)
    .join('');
  const canonicalUrls = [...new Set(chapters.flatMap(({ sources }) => sources
    .map((source) => source.origin.canonicalUrl)
    .filter((value): value is string => Boolean(value))))];
  const sourceMetadata = canonicalUrls.map((url) => `<dc:source>${escapeXml(url)}</dc:source>`).join('');
  const chapterItems = chapters.map((chapter, index) =>
    `<item id="chapter-${index + 1}" href="${escapeXml(chapter.href)}" media-type="application/xhtml+xml"/>`).join('');
  const assetItems = chapters.flatMap((chapter) => chapter.assets).map((asset, index) =>
    `<item id="asset-${index + 1}" href="${escapeXml(asset.vaultRelativePath)}" media-type="${escapeXml(asset.mediaType)}"/>`).join('');
  const spine = chapters.map((_chapter, index) => `<itemref idref="chapter-${index + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id" xml:lang="${escapeXml(publication.language)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="publication-id">urn:pi-reads:${escapeXml(publication.id)}</dc:identifier><dc:title>${escapeXml(publication.title)}</dc:title><dc:language>${escapeXml(publication.language)}</dc:language>${creators}${publication.description ? `<dc:description>${escapeXml(publication.description)}</dc:description>` : ''}${sourceMetadata}<meta property="dcterms:modified">${modifiedTimestamp(modifiedAt)}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="styles.css" media-type="text/css"/>${chapterItems}${assetItems}</manifest>
<spine>${spine}</spine>
</package>`;
}

function assertXml(value: string, label: string): Document {
  const dom = new JSDOM(value, { contentType: 'application/xml' });
  if (dom.window.document.querySelector('parsererror')) throw new Error(`Invalid EPUB ${label} XML`);
  return dom.window.document;
}

type EpubFiles = ReturnType<typeof unzipSync>;

function assertEpubHeader(bytes: Uint8Array): void {
  if (bytes.byteLength < 38 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== 0x04034b50) {
    throw new Error('EPUB does not start with a ZIP local file header');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const filenameLength = view.getUint16(26, true);
  const firstFilename = new TextDecoder().decode(bytes.subarray(30, 30 + filenameLength));
  if (firstFilename !== 'mimetype' || view.getUint16(8, true) !== 0) {
    throw new Error('EPUB mimetype must be the first uncompressed ZIP entry');
  }
}

function requiredEpubFiles(files: EpubFiles): void {
  for (const required of ['mimetype', CONTAINER_PATH, PACKAGE_PATH, NAV_PATH, CSS_PATH]) {
    if (!files[required]) throw new Error(`EPUB is missing ${required}`);
  }
  if (strFromU8(files.mimetype!) !== EPUB_MIMETYPE) throw new Error('EPUB mimetype entry is invalid');
}

function validateManifestFiles(files: EpubFiles, items: readonly Element[]): Map<string | null, Element> {
  const byId = new Map(items.map((item) => [item.getAttribute('id'), item]));
  for (const item of items) {
    const href = item.getAttribute('href');
    const entry = href ? files[path.posix.join('EPUB', href)] : undefined;
    if (!href || !entry) throw new Error(`EPUB manifest references missing file ${href ?? '(empty)'}`);
    if (item.getAttribute('media-type') === 'application/xhtml+xml') assertXml(strFromU8(entry), href);
  }
  return byId;
}

function validateSpine(items: readonly Element[], manifestById: ReadonlyMap<string | null, Element>): void {
  if (items.length === 0) throw new Error('EPUB spine has no readable content');
  for (const item of items) {
    const idref = item.getAttribute('idref');
    const manifestItem = idref ? manifestById.get(idref) : undefined;
    if (!manifestItem || manifestItem.getAttribute('media-type') !== 'application/xhtml+xml') {
      throw new Error(`EPUB spine references unknown readable item ${idref ?? '(empty)'}`);
    }
  }
}

function validateNavigation(files: EpubFiles, navigation: Document): void {
  for (const link of [...navigation.querySelectorAll('nav a')]) {
    const href = link.getAttribute('href')?.split('#')[0];
    if (!href || !files[path.posix.join('EPUB', href)]) {
      throw new Error(`EPUB navigation references missing file ${href ?? '(empty)'}`);
    }
  }
}

export function validateEpub(bytes: Uint8Array): EpubValidation {
  assertEpubHeader(bytes);
  const files = unzipSync(bytes);
  requiredEpubFiles(files);
  const container = assertXml(strFromU8(files[CONTAINER_PATH]!), 'container');
  if (container.querySelector('rootfile')?.getAttribute('full-path') !== PACKAGE_PATH) {
    throw new Error('EPUB container points to an unexpected package document');
  }
  const opf = assertXml(strFromU8(files[PACKAGE_PATH]!), 'package');
  const navigation = assertXml(strFromU8(files[NAV_PATH]!), 'navigation');
  const manifestItems = [...opf.querySelectorAll('manifest item')];
  const spineItems = [...opf.querySelectorAll('spine itemref')];
  if (['metadata identifier', 'metadata title', 'metadata language'].some((selector) => !opf.querySelector(selector))) {
    throw new Error('EPUB package is missing required publication metadata');
  }
  if (!manifestItems.some((item) => item.getAttribute('properties')?.split(/\s+/u).includes('nav'))) {
    throw new Error('EPUB manifest has no navigation document');
  }
  validateSpine(spineItems, validateManifestFiles(files, manifestItems));
  validateNavigation(files, navigation);
  return {
    files: Object.keys(files).sort(),
    manifestItems: manifestItems.length,
    spineItems: spineItems.length,
    embeddedAssets: manifestItems.filter((item) => item.getAttribute('id')?.startsWith('asset-')).length,
  };
}

export class EpubService {
  private readonly library: LibraryService;
  private readonly collections: ReadingCollectionService;
  private readonly now: () => Date;
  private readonly createId: (prefix: RecordIdPrefix) => string;
  private readonly fetchAsset?: (url: string, signal?: AbortSignal) => Promise<DownloadedAsset>;

  constructor(options: EpubServiceOptions) {
    this.library = options.library;
    this.collections = options.collections ?? new ReadingCollectionService({ library: options.library });
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((prefix) => createRecordId(prefix));
    this.fetchAsset = options.fetchAsset;
  }

  private async chapter(articleId: string, href: string, showMode: boolean, signal?: AbortSignal): Promise<RenderedChapter> {
    signal?.throwIfAborted();
    const stored = await this.library.loadArticle(articleId);
    const sources = await Promise.all(stored.article.sourceIds.map(async (sourceId) => (await this.library.loadSource(sourceId)).source));
    const prepared = await prepareArticleAssets(stored.content, stored.article, sources, {
      attachmentFolder: 'assets',
      documentRelativePath: href,
      ...(this.fetchAsset ? { fetchAsset: this.fetchAsset } : {}),
      signal,
    });
    const sourceMap = new Map(sources.map((source) => [source.id, source]));
    const withCitations = replaceCitationMarkers(prepared.markdown, stored.article.citations);
    const bodyHtml = `${marked.parse(withCitations, { async: false })}${citationSection(stored.article, sourceMap)}`;
    const stylesheetHref = path.posix.relative(path.posix.dirname(href), 'styles.css');
    return {
      article: stored.article,
      sources,
      href,
      xhtml: articleXhtml(stored.article, sources, xhtmlBody(bodyHtml), stylesheetHref, showMode),
      assets: prepared.assets,
    };
  }

  private build(publication: { id: string; title: string; language: string; description?: string }, chapters: readonly RenderedChapter[]): RenderedEpub {
    const createdAt = this.now().toISOString();
    const entries: Zippable = {
      mimetype: [strToU8(EPUB_MIMETYPE), { level: 0, mtime: new Date(createdAt) }],
      [CONTAINER_PATH]: strToU8(containerXml()),
      [PACKAGE_PATH]: strToU8(packageOpf(publication, chapters, createdAt)),
      [NAV_PATH]: strToU8(navXhtml(publication.title, publication.language, chapters)),
      [CSS_PATH]: strToU8(EPUB_CSS),
    };
    for (const chapter of chapters) {
      entries[path.posix.join('EPUB', chapter.href)] = strToU8(chapter.xhtml);
      for (const asset of chapter.assets) entries[path.posix.join('EPUB', asset.vaultRelativePath)] = asset.contents;
    }
    const bytes = zipSync(entries, { level: 6, mtime: new Date(createdAt) });
    return { bytes, validation: validateEpub(bytes) };
  }

  private async render(articleId: string, signal?: AbortSignal): Promise<RenderedEpub> {
    const chapter = await this.chapter(articleId, 'article.xhtml', false, signal);
    return this.build({
      id: chapter.article.id,
      title: chapter.article.title,
      language: chapter.article.language ?? 'en',
      ...(chapter.article.description ? { description: chapter.article.description } : {}),
    }, [chapter]);
  }

  private async renderCollection(collection: ReadingCollectionRecord, signal?: AbortSignal): Promise<RenderedEpub> {
    const chapters: RenderedChapter[] = [];
    for (const [index, articleId] of collection.articleIds.entries()) {
      const name = `${String(index + 1).padStart(3, '0')}-${collection.articles[index]!.articleId.slice(4, 16)}.xhtml`;
      chapters.push(await this.chapter(articleId, path.posix.join('chapters', name), true, signal));
    }
    return this.build({
      id: collection.id,
      title: collection.title,
      language: chapters.find(({ article }) => article.language)?.article.language ?? 'en',
      description: `${chapters.length} articles prepared by Pi Reads`,
    }, chapters);
  }

  private async persist(
    target: { articleId: string } | { collectionId: string },
    filename: 'article.epub' | 'collection.epub',
    rendered: RenderedEpub,
    signal?: AbortSignal,
  ): Promise<PreparedEpubExport> {
    signal?.throwIfAborted();
    const exportId = this.createId('exp');
    const targetId = 'articleId' in target ? target.articleId : target.collectionId;
    const directory = exportDirectory(targetId, exportId);
    const artifactRelativePath = path.posix.join(directory, filename);
    const record: ExportRecord = {
      schemaVersion: 1,
      id: exportId,
      ...target,
      format: 'epub',
      destination: { type: 'local' },
      status: 'prepared',
      artifact: {
        path: artifactRelativePath,
        mediaType: EPUB_MIMETYPE,
        contentHash: versionedSha256(rendered.bytes),
        byteLength: rendered.bytes.byteLength,
      },
      createdAt: this.now().toISOString(),
    };
    await createImmutableRecordDirectory(this.library.libraryDir, directory, [
      { path: filename, contents: rendered.bytes },
      { path: 'manifest.json', contents: `${JSON.stringify(record, null, 2)}\n` },
    ]);
    return {
      record,
      manifestPath: resolveLibraryPath(this.library.libraryDir, path.posix.join(directory, 'manifest.json')),
      artifactPath: resolveLibraryPath(this.library.libraryDir, artifactRelativePath),
      validation: rendered.validation,
    };
  }

  async prepare(articleId: string, signal?: AbortSignal): Promise<PreparedEpubExport> {
    return this.persist({ articleId }, 'article.epub', await this.render(articleId, signal), signal);
  }

  async prepareCollection(collectionId: string, signal?: AbortSignal): Promise<PreparedEpubExport> {
    const { collection } = await this.collections.load(collectionId);
    const rendered = await this.renderCollection(collection, signal);
    if (rendered.validation.spineItems !== collection.articleIds.length) {
      throw new Error('Collection EPUB spine does not match its ordered article count');
    }
    return this.persist({ collectionId }, 'collection.epub', rendered, signal);
  }
}
