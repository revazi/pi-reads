import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ArticleRecord,
  ExportRecord,
  FrontmatterValue,
  SourceRecord,
  StoredFile,
} from '../core/domain.ts';
import type { ResolvedObsidianConfig } from '../core/config.ts';
import {
  createImmutableRecordDirectory,
  createRecordId,
  exportDirectory,
  resolveLibraryPath,
  type RecordIdPrefix,
} from '../core/library.ts';
import { versionedSha256 } from '../core/text.ts';
import {
  downloadImageAsset,
  inspectObsidianVault,
  obsidianOpenUri,
  validateVaultRelativePath,
  writeObsidianVault,
  type DownloadedAsset,
  type ObsidianVaultFile,
  type ObsidianVaultInspection,
} from '../adapters/destinations/obsidian.ts';
import { ExportService } from './export-service.ts';
import { LibraryService } from './library-service.ts';

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const FRONTMATTER_RESERVED_KEYS = new Set([
  'piReadsArticleId',
  'mode',
  'title',
  'slug',
  'canonicalUrl',
  'sourceIds',
  'sourceUrls',
  'authors',
  'createdAt',
  'publishedAt',
  'generatedBy',
  'tags',
]);
const IMAGE_MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
};
const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(IMAGE_MEDIA_EXTENSIONS).flatMap(([mediaType, extension]) =>
    extension === '.jpg' ? [[extension, mediaType], ['.jpeg', mediaType]] : [[extension, mediaType]],
  ),
);

interface ImageReference {
  start: number;
  end: number;
  target: string;
}

export interface PreparedArticleAsset {
  vaultRelativePath: string;
  exportName: string;
  contents: Uint8Array;
  mediaType: string;
}

export interface ObsidianServiceOptions {
  library: LibraryService;
  exports: ExportService;
  now?: () => Date;
  createId?: (prefix: RecordIdPrefix) => string;
  fetchAsset?: (url: string, signal?: AbortSignal) => Promise<DownloadedAsset>;
}

export interface ObsidianExportPlan {
  article: ArticleRecord;
  config: ResolvedObsidianConfig;
  noteRelativePath: string;
  notePath: string;
  noteContents: string;
  openUri: string;
  inspection: ObsidianVaultInspection;
  vaultFiles: ObsidianVaultFile[];
  assets: PreparedArticleAsset[];
}

export interface DeliveredObsidianExport {
  record: ExportRecord;
  manifestPath: string;
  artifactPath: string;
  notePath: string;
  noteRelativePath: string;
  assetPaths: string[];
  changedPaths: string[];
  openUri: string;
}

export class ObsidianConflictError extends Error {
  readonly conflicts: string[];

  constructor(conflicts: string[]) {
    super(`Obsidian export would overwrite ${conflicts.join(', ')}`);
    this.name = 'ObsidianConflictError';
    this.conflicts = conflicts;
  }
}

function sanitizeFilename(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-')
    .replace(/\s+/gu, ' ')
    .replace(/[. ]+$/gu, '')
    .trim();
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Obsidian note naming template produced an empty filename');
  }
  return sanitized;
}

function renderNoteName(template: string, article: ArticleRecord): string {
  const values: Record<string, string> = {
    title: article.title,
    slug: article.slug,
    id: article.id,
    mode: article.mode,
    date: article.createdAt.slice(0, 10),
  };
  const unknown = [...template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/gu)]
    .map((match) => match[1])
    .find((key) => !(key in values));
  if (unknown) {
    throw new Error(`Unsupported Obsidian note template variable: ${unknown}`);
  }
  const rendered = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (_match, key: string) => values[key] ?? '');
  if (/\{\{|\}\}/u.test(rendered)) {
    throw new Error('Malformed Obsidian note naming template');
  }
  return sanitizeFilename(rendered);
}

function yamlLine(key: string, value: FrontmatterValue): string {
  return `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
}

function renderFrontmatter(
  article: ArticleRecord,
  sources: readonly SourceRecord[],
  config: ResolvedObsidianConfig,
): string {
  for (const key of Object.keys(config.frontmatter)) {
    if (FRONTMATTER_RESERVED_KEYS.has(key)) {
      throw new Error(`Obsidian custom frontmatter cannot replace reserved property ${key}`);
    }
  }

  const sourceUrls = sources
    .map((source) => source.origin.canonicalUrl)
    .filter((url): url is string => Boolean(url));
  const authors = article.authors ?? [...new Set(sources.flatMap((source) => source.authors ?? []))];
  const publishedAt = [...new Set(sources.map((source) => source.publishedAt).filter((date): date is string => Boolean(date)))];
  const tags = [...new Set(config.tags.map((tag) => tag.trim().replace(/^#+/u, '')).filter(Boolean))];
  const properties: Array<[string, FrontmatterValue | undefined]> = [
    ...Object.entries(config.frontmatter),
    ['piReadsArticleId', article.id],
    ['mode', article.mode],
    ['title', article.title],
    ['slug', article.slug],
    ['canonicalUrl', sourceUrls[0]],
    ['sourceIds', article.sourceIds],
    ['sourceUrls', sourceUrls.length ? sourceUrls : undefined],
    ['authors', authors.length ? authors : undefined],
    ['createdAt', article.createdAt],
    ['publishedAt', publishedAt.length === 1 ? publishedAt[0] : publishedAt.length ? publishedAt : undefined],
    ['generatedBy', article.generatedBy ? `${article.generatedBy.provider}/${article.generatedBy.model}` : undefined],
    ['tags', tags.length ? tags : undefined],
  ];

  return `---\n${properties
    .filter((entry): entry is [string, FrontmatterValue] => entry[1] !== undefined)
    .map(([key, value]) => yamlLine(key, value))
    .join('\n')}\n---\n\n`;
}

function codeRanges(markdown: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const lines = markdown.matchAll(/.*(?:\n|$)/gu);
  let fence: { character: string; length: number; start: number } | undefined;
  for (const match of lines) {
    const line = match[0];
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (!fence && marker) {
      fence = { character: marker[0], length: marker.length, start: match.index };
      continue;
    }
    if (fence && marker?.[0] === fence.character && marker.length >= fence.length) {
      ranges.push({ start: fence.start, end: match.index + line.length });
      fence = undefined;
    }
  }
  if (fence) {
    ranges.push({ start: fence.start, end: markdown.length });
  }
  return ranges;
}

function imageReferences(markdown: string): ImageReference[] {
  const ranges = codeRanges(markdown);
  const references: ImageReference[] = [];
  const patterns = [
    /!\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\r\n)]*\)))?\s*\)/gu,
    /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/giu,
  ];

  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const isMarkdownImage = pattern === patterns[0];
      const target = isMarkdownImage ? (match[1] ?? match[2]) : match[2];
      if (!target) continue;
      const searchFrom = isMarkdownImage ? match[0].indexOf('](') + 2 : match[0].toLowerCase().indexOf('src');
      const targetOffset = match[0].indexOf(target, searchFrom);
      const start = match.index + targetOffset;
      const end = start + target.length;
      if (ranges.some((range) => start >= range.start && start < range.end)) {
        continue;
      }
      references.push({ start, end, target });
    }
  }

  return references.sort((left, right) => left.start - right.start);
}

function encodeMarkdownPath(relativePath: string): string {
  return relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function safeAssetStem(target: string): string {
  let pathname = target;
  try {
    pathname = new URL(target).pathname;
  } catch {
    // Local path.
  }
  const basename = path.basename(pathname);
  let decoded = basename;
  try {
    decoded = decodeURIComponent(basename);
  } catch {
    // Keep the encoded basename when the source contains malformed escapes.
  }
  decoded = decoded.replace(/\.[^.]+$/u, '');
  const sanitized = decoded
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return sanitized || 'image';
}

function extensionFor(mediaType: string): string {
  const extension = IMAGE_MEDIA_EXTENSIONS[mediaType.toLowerCase()];
  if (!extension) {
    throw new Error(`Unsupported image media type: ${mediaType}`);
  }
  return extension;
}

async function readLocalImage(target: string, sources: readonly SourceRecord[]): Promise<DownloadedAsset> {
  const fileSources = sources.filter((source) => source.kind === 'file' && path.isAbsolute(source.origin.locator));
  if (fileSources.length !== 1) {
    throw new Error(`Local image paths require exactly one captured local file source: ${target}`);
  }

  let localPath: string;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(target) && !target.startsWith('file:')) {
    throw new Error(`Unsupported image protocol: ${target.split(':', 1)[0]}:`);
  }
  if (target.startsWith('file:')) {
    localPath = fileURLToPath(target);
  } else {
    const decoded = decodeURIComponent(target);
    localPath = path.isAbsolute(decoded)
      ? decoded
      : path.resolve(path.dirname(fileSources[0].origin.locator), decoded);
  }

  const info = await stat(localPath);
  if (!info.isFile()) {
    throw new Error(`Obsidian image asset is not a file: ${localPath}`);
  }
  if (info.size > MAX_ASSET_BYTES) {
    throw new Error(`Image exceeds the ${MAX_ASSET_BYTES} byte limit: ${localPath}`);
  }
  const extension = path.extname(localPath).toLowerCase();
  const mediaType = EXTENSION_MEDIA_TYPES[extension];
  if (!mediaType) {
    throw new Error(`Unsupported local image type: ${extension || '(none)'}`);
  }
  return { contents: await readFile(localPath), mediaType };
}

export async function prepareArticleAssets(
  markdown: string,
  article: ArticleRecord,
  sources: readonly SourceRecord[],
  options: {
    attachmentFolder: string;
    documentRelativePath: string;
    fetchAsset?: (url: string, signal?: AbortSignal) => Promise<DownloadedAsset>;
    signal?: AbortSignal;
  },
): Promise<{ markdown: string; assets: PreparedArticleAsset[] }> {
  const references = imageReferences(markdown);
  if (references.length === 0) {
    return { markdown, assets: [] };
  }

  const attachmentFolder = validateVaultRelativePath(options.attachmentFolder, 'Attachment folder');
  const fetchAsset = options.fetchAsset ?? ((url: string, signal?: AbortSignal) => downloadImageAsset(url, { signal }));
  const resolved = new Map<string, PreparedArticleAsset>();
  const replacements = new Map<string, string>();
  for (const reference of references) {
    options.signal?.throwIfAborted();
    if (resolved.has(reference.target)) continue;
    const asset = /^https?:\/\//iu.test(reference.target)
      ? await fetchAsset(reference.target, options.signal)
      : await readLocalImage(reference.target, sources);
    if (asset.contents.byteLength > MAX_ASSET_BYTES) {
      throw new Error(`Image exceeds the ${MAX_ASSET_BYTES} byte limit: ${reference.target}`);
    }
    const extension = extensionFor(asset.mediaType);
    const index = resolved.size + 1;
    const exportName = `${String(index).padStart(3, '0')}-${safeAssetStem(reference.target)}${extension}`;
    const vaultRelativePath = path.posix.join(attachmentFolder, article.slug, exportName);
    const relativeLink = path.posix.relative(path.posix.dirname(options.documentRelativePath), vaultRelativePath);
    resolved.set(reference.target, {
      vaultRelativePath,
      exportName,
      contents: asset.contents,
      mediaType: asset.mediaType,
    });
    replacements.set(reference.target, encodeMarkdownPath(relativeLink));
  }

  let cursor = 0;
  let rewritten = '';
  for (const reference of references) {
    rewritten += markdown.slice(cursor, reference.start);
    rewritten += replacements.get(reference.target) ?? reference.target;
    cursor = reference.end;
  }
  rewritten += markdown.slice(cursor);
  return { markdown: rewritten, assets: [...resolved.values()] };
}

export class ObsidianService {
  private readonly library: LibraryService;
  private readonly exports: ExportService;
  private readonly now: () => Date;
  private readonly createId: (prefix: RecordIdPrefix) => string;
  private readonly fetchAsset: (url: string, signal?: AbortSignal) => Promise<DownloadedAsset>;

  constructor(options: ObsidianServiceOptions) {
    this.library = options.library;
    this.exports = options.exports;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((prefix) => createRecordId(prefix));
    this.fetchAsset = options.fetchAsset ?? ((url, signal) => downloadImageAsset(url, { signal }));
  }

  async plan(
    articleId: string,
    config: ResolvedObsidianConfig,
    signal?: AbortSignal,
  ): Promise<ObsidianExportPlan> {
    signal?.throwIfAborted();
    const inboxFolder = validateVaultRelativePath(config.inboxFolder, 'Obsidian inbox folder');
    validateVaultRelativePath(config.attachmentFolder, 'Obsidian attachment folder');
    const stored = await this.library.loadArticle(articleId);
    const sources = await Promise.all(stored.article.sourceIds.map(async (id) => (await this.library.loadSource(id)).source));
    const noteName = renderNoteName(config.noteNameTemplate, stored.article);
    const noteRelativePath = path.posix.join(inboxFolder, `${noteName}.md`);
    const markdown = await this.exports.renderMarkdown(articleId, { includeMetadata: false });
    const prepared = await prepareArticleAssets(markdown, stored.article, sources, {
      attachmentFolder: config.attachmentFolder,
      documentRelativePath: noteRelativePath,
      fetchAsset: this.fetchAsset,
      signal,
    });
    const noteContents = `${renderFrontmatter(stored.article, sources, config)}${prepared.markdown}`;
    const vaultFiles: ObsidianVaultFile[] = [
      ...prepared.assets.map((asset) => ({ relativePath: asset.vaultRelativePath, contents: asset.contents })),
      { relativePath: noteRelativePath, contents: noteContents },
    ];
    const inspection = await inspectObsidianVault(config.vaultPath, vaultFiles);

    return {
      article: stored.article,
      config,
      noteRelativePath,
      notePath: path.resolve(config.vaultPath, ...noteRelativePath.split('/')),
      noteContents,
      openUri: obsidianOpenUri(config.vaultName, noteRelativePath),
      inspection,
      vaultFiles,
      assets: prepared.assets,
    };
  }

  async deliver(
    plan: ObsidianExportPlan,
    options: { overwrite?: boolean; confirmedAt?: string } = {},
  ): Promise<DeliveredObsidianExport> {
    if (plan.inspection.conflicts.length > 0 && !options.overwrite) {
      throw new ObsidianConflictError(plan.inspection.conflicts);
    }

    const attemptedAt = this.now().toISOString();
    const vaultWrite = await writeObsidianVault(plan.config.vaultPath, plan.vaultFiles, {
      overwrite: options.overwrite,
    });
    try {
      const exportId = this.createId('exp');
      const directory = exportDirectory(plan.article.id, exportId);
      const artifactRelativePath = path.posix.join(directory, 'article.md');
      const storedAssets: StoredFile[] = plan.assets.map((asset) => ({
        path: path.posix.join(directory, 'assets', asset.exportName),
        mediaType: asset.mediaType,
        contentHash: versionedSha256(asset.contents),
        byteLength: asset.contents.byteLength,
      }));
      const record: ExportRecord = {
        schemaVersion: 1,
        id: exportId,
        articleId: plan.article.id,
        format: 'markdown',
        destination: {
          type: 'obsidian',
          vaultName: plan.config.vaultName,
          notePath: plan.noteRelativePath,
        },
        status: 'delivered',
        artifact: {
          path: artifactRelativePath,
          mediaType: 'text/markdown',
          contentHash: versionedSha256(plan.noteContents),
          byteLength: Buffer.byteLength(plan.noteContents),
        },
        ...(storedAssets.length ? { assets: storedAssets } : {}),
        createdAt: attemptedAt,
        delivery: {
          attemptedAt,
          ...(options.confirmedAt ? { confirmedAt: options.confirmedAt, confirmationMethod: 'interactive' as const } : {}),
          deliveredAt: this.now().toISOString(),
        },
      };

      await createImmutableRecordDirectory(
        this.library.libraryDir,
        directory,
        [
          { path: 'article.md', contents: plan.noteContents },
          ...plan.assets.map((asset) => ({ path: path.posix.join('assets', asset.exportName), contents: asset.contents })),
          { path: 'manifest.json', contents: `${JSON.stringify(record, null, 2)}\n` },
        ],
      );
      await vaultWrite.commit();

      return {
        record,
        manifestPath: resolveLibraryPath(this.library.libraryDir, path.posix.join(directory, 'manifest.json')),
        artifactPath: resolveLibraryPath(this.library.libraryDir, artifactRelativePath),
        notePath: plan.notePath,
        noteRelativePath: plan.noteRelativePath,
        assetPaths: plan.assets.map((asset) => path.resolve(plan.config.vaultPath, ...asset.vaultRelativePath.split('/'))),
        changedPaths: vaultWrite.changedPaths,
        openUri: plan.openUri,
      };
    } catch (error: unknown) {
      await vaultWrite.rollback();
      throw error;
    }
  }
}
