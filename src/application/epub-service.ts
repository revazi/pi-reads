import path from 'node:path';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { ArticleRecord, Citation, ExportRecord, SourceRecord } from '../core/domain.ts';
import {
  createImmutableRecordDirectory,
  createRecordId,
  exportDirectory,
  resolveLibraryPath,
  type RecordIdPrefix,
} from '../core/library.ts';
import { versionedSha256 } from '../core/text.ts';
import type { DownloadedAsset } from '../adapters/destinations/obsidian.ts';
import { prepareArticleAssets } from './obsidian-service.ts';
import { LibraryService } from './library-service.ts';

const EPUB_MIMETYPE = 'application/epub+zip';
const CONTAINER_PATH = 'META-INF/container.xml';
const PACKAGE_PATH = 'EPUB/package.opf';
const ARTICLE_PATH = 'EPUB/article.xhtml';
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
.article-citations { border-top: 1px solid #bbb; margin-top: 2em; padding-top: 1em; }
`;

export interface EpubServiceOptions {
  library: LibraryService;
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

function navXhtml(article: ArticleRecord): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(article.language ?? 'en')}">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol><li><a href="article.xhtml">${escapeXml(article.title)}</a></li></ol></nav></body>
</html>`;
}

function articleXhtml(article: ArticleRecord, sources: readonly SourceRecord[], body: string): string {
  const authors = article.authors ?? [...new Set(sources.flatMap((source) => source.authors ?? []))];
  const sourceLinks = sources
    .map((source) => source.origin.canonicalUrl
      ? `<a href="${escapeXml(source.origin.canonicalUrl)}">${escapeXml(sourceLabel(source))}</a>`
      : escapeXml(sourceLabel(source)))
    .join(' · ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(article.language ?? 'en')}">
<head><meta charset="utf-8"/><title>${escapeXml(article.title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body><article><header><h1>${escapeXml(article.title)}</h1>${authors.length ? `<p class="article-meta">${escapeXml(authors.join(', '))}</p>` : ''}${sourceLinks ? `<p class="article-source">Sources: ${sourceLinks}</p>` : ''}</header><main>${body}</main></article></body>
</html>`;
}

function packageOpf(
  article: ArticleRecord,
  sources: readonly SourceRecord[],
  assets: readonly { vaultRelativePath: string; mediaType: string }[],
  modifiedAt: string,
): string {
  const creators = (article.authors ?? [...new Set(sources.flatMap((source) => source.authors ?? []))])
    .map((author) => `<dc:creator>${escapeXml(author)}</dc:creator>`)
    .join('');
  const canonicalUrl = sources.map((source) => source.origin.canonicalUrl).find(Boolean);
  const assetItems = assets
    .map((asset, index) => `<item id="asset-${index + 1}" href="${escapeXml(asset.vaultRelativePath.replace(/^assets\//u, 'assets/'))}" media-type="${escapeXml(asset.mediaType)}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id" xml:lang="${escapeXml(article.language ?? 'en')}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="publication-id">urn:pi-reads:${escapeXml(article.id)}</dc:identifier><dc:title>${escapeXml(article.title)}</dc:title><dc:language>${escapeXml(article.language ?? 'en')}</dc:language>${creators}${article.description ? `<dc:description>${escapeXml(article.description)}</dc:description>` : ''}${canonicalUrl ? `<dc:source>${escapeXml(canonicalUrl)}</dc:source>` : ''}<meta property="dcterms:modified">${modifiedTimestamp(modifiedAt)}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="article" href="article.xhtml" media-type="application/xhtml+xml"/><item id="css" href="styles.css" media-type="text/css"/>${assetItems}</manifest>
<spine><itemref idref="article"/></spine>
</package>`;
}

function assertXml(value: string, label: string): Document {
  const dom = new JSDOM(value, { contentType: 'application/xml' });
  if (dom.window.document.querySelector('parsererror')) {
    throw new Error(`Invalid EPUB ${label} XML`);
  }
  return dom.window.document;
}

export function validateEpub(bytes: Uint8Array): EpubValidation {
  if (bytes.byteLength < 38 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== 0x04034b50) {
    throw new Error('EPUB does not start with a ZIP local file header');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compressionMethod = view.getUint16(8, true);
  const filenameLength = view.getUint16(26, true);
  const firstFilename = new TextDecoder().decode(bytes.subarray(30, 30 + filenameLength));
  if (firstFilename !== 'mimetype' || compressionMethod !== 0) {
    throw new Error('EPUB mimetype must be the first uncompressed ZIP entry');
  }

  const files = unzipSync(bytes);
  for (const required of ['mimetype', CONTAINER_PATH, PACKAGE_PATH, ARTICLE_PATH, NAV_PATH, CSS_PATH]) {
    if (!files[required]) throw new Error(`EPUB is missing ${required}`);
  }
  if (strFromU8(files.mimetype) !== EPUB_MIMETYPE) {
    throw new Error('EPUB mimetype entry is invalid');
  }

  const container = assertXml(strFromU8(files[CONTAINER_PATH]), 'container');
  const packagePath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (packagePath !== PACKAGE_PATH) throw new Error('EPUB container points to an unexpected package document');
  const opf = assertXml(strFromU8(files[PACKAGE_PATH]), 'package');
  assertXml(strFromU8(files[ARTICLE_PATH]), 'article');
  assertXml(strFromU8(files[NAV_PATH]), 'navigation');
  const manifestItems = [...opf.querySelectorAll('manifest item')];
  const manifestIds = new Set(manifestItems.map((item) => item.getAttribute('id')));
  const spineItems = [...opf.querySelectorAll('spine itemref')];
  if (['metadata identifier', 'metadata title', 'metadata language'].some((selector) => !opf.querySelector(selector))) {
    throw new Error('EPUB package is missing required publication metadata');
  }
  if (!manifestItems.some((item) => item.getAttribute('properties')?.split(/\s+/u).includes('nav'))) {
    throw new Error('EPUB manifest has no navigation document');
  }
  if (spineItems.length === 0) {
    throw new Error('EPUB spine has no readable content');
  }
  for (const item of manifestItems) {
    const href = item.getAttribute('href');
    if (!href || !files[path.posix.join('EPUB', href)]) {
      throw new Error(`EPUB manifest references missing file ${href ?? '(empty)'}`);
    }
  }
  for (const item of spineItems) {
    const idref = item.getAttribute('idref');
    if (!idref || !manifestIds.has(idref)) throw new Error(`EPUB spine references unknown item ${idref ?? '(empty)'}`);
  }

  return {
    files: Object.keys(files).sort(),
    manifestItems: manifestItems.length,
    spineItems: spineItems.length,
    embeddedAssets: manifestItems.filter((item) => item.getAttribute('id')?.startsWith('asset-')).length,
  };
}

export class EpubService {
  private readonly library: LibraryService;
  private readonly now: () => Date;
  private readonly createId: (prefix: RecordIdPrefix) => string;
  private readonly fetchAsset?: (url: string, signal?: AbortSignal) => Promise<DownloadedAsset>;

  constructor(options: EpubServiceOptions) {
    this.library = options.library;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((prefix) => createRecordId(prefix));
    this.fetchAsset = options.fetchAsset;
  }

  private async render(articleId: string, signal?: AbortSignal): Promise<RenderedEpub> {
    signal?.throwIfAborted();
    const stored = await this.library.loadArticle(articleId);
    const sources = await Promise.all(stored.article.sourceIds.map(async (sourceId) => (await this.library.loadSource(sourceId)).source));
    const prepared = await prepareArticleAssets(stored.content, stored.article, sources, {
      attachmentFolder: 'assets',
      documentRelativePath: 'article.xhtml',
      ...(this.fetchAsset ? { fetchAsset: this.fetchAsset } : {}),
      signal,
    });
    const sourceMap = new Map(sources.map((source) => [source.id, source]));
    const withCitations = replaceCitationMarkers(prepared.markdown, stored.article.citations);
    const bodyHtml = `${marked.parse(withCitations, { async: false })}${citationSection(stored.article, sourceMap)}`;
    const body = xhtmlBody(bodyHtml);
    const createdAt = this.now().toISOString();
    const entries: Zippable = {
      mimetype: [strToU8(EPUB_MIMETYPE), { level: 0, mtime: new Date(createdAt) }],
      [CONTAINER_PATH]: strToU8(containerXml()),
      [PACKAGE_PATH]: strToU8(packageOpf(stored.article, sources, prepared.assets, createdAt)),
      [NAV_PATH]: strToU8(navXhtml(stored.article)),
      [ARTICLE_PATH]: strToU8(articleXhtml(stored.article, sources, body)),
      [CSS_PATH]: strToU8(EPUB_CSS),
    };
    for (const asset of prepared.assets) {
      entries[path.posix.join('EPUB', asset.vaultRelativePath)] = asset.contents;
    }
    const bytes = zipSync(entries, { level: 6, mtime: new Date(createdAt) });
    return { bytes, validation: validateEpub(bytes) };
  }

  async prepare(articleId: string, signal?: AbortSignal): Promise<PreparedEpubExport> {
    const rendered = await this.render(articleId, signal);
    signal?.throwIfAborted();
    const exportId = this.createId('exp');
    const directory = exportDirectory(articleId, exportId);
    const artifactRelativePath = path.posix.join(directory, 'article.epub');
    const createdAt = this.now().toISOString();
    const record: ExportRecord = {
      schemaVersion: 1,
      id: exportId,
      articleId,
      format: 'epub',
      destination: { type: 'local' },
      status: 'prepared',
      artifact: {
        path: artifactRelativePath,
        mediaType: EPUB_MIMETYPE,
        contentHash: versionedSha256(rendered.bytes),
        byteLength: rendered.bytes.byteLength,
      },
      createdAt,
    };
    await createImmutableRecordDirectory(
      this.library.libraryDir,
      directory,
      [
        { path: 'article.epub', contents: rendered.bytes },
        { path: 'manifest.json', contents: `${JSON.stringify(record, null, 2)}\n` },
      ],
    );
    return {
      record,
      manifestPath: resolveLibraryPath(this.library.libraryDir, path.posix.join(directory, 'manifest.json')),
      artifactPath: resolveLibraryPath(this.library.libraryDir, artifactRelativePath),
      validation: rendered.validation,
    };
  }
}
