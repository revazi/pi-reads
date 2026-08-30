import { access, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArticleMode, ArticleRecord, SourceRecord } from './domain.ts';
import {
  articleContentPath,
  articleDirectory,
  assertSafeLibraryRoot,
  resolveLibraryPath,
  sourceContentPath,
  sourceDirectory,
} from './library.ts';

const ARTICLE_MODES: readonly ArticleMode[] = ['archive', 'digest', 'synthesis'];
const ARTICLE_ID_PATTERN = /^art_[a-z0-9]{16,64}$/u;
const SOURCE_ID_PATTERN = /^src_[a-z0-9]{16,64}$/u;
const CATALOG_KEYS = ['sources', 'archive', 'digest', 'synthesis'] as const;

export const LIBRARY_INDEX_PATH = 'indexes/library.json';
export const LIBRARY_INDEX_DIRTY_PATH = 'indexes/dirty';

export interface LibraryCatalogStamp {
  sources: string;
  archive: string;
  digest: string;
  synthesis: string;
}

export interface LibraryIndex {
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  catalog: LibraryCatalogStamp;
  sources: SourceRecord[];
  articles: ArticleRecord[];
}

export interface LibraryIndexStats {
  sourceCount: number;
  articleCount: number;
  revision: number;
  indexPath: string;
}

export interface LibraryIndexTransactionResult<T> {
  value: T;
  sources: SourceRecord[];
  articles: ArticleRecord[];
}

export interface LibraryIndexStoreOptions {
  allowGitWorkingTree?: boolean;
  now?: () => Date;
}

const mutationTails = new Map<string, Promise<void>>();

async function withIndexMutation<T>(libraryRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(libraryRoot);
  const previous = mutationTails.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  mutationTails.set(key, tail);
  try {
    return await result;
  } finally {
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  }
}

async function directoryStamp(directory: string): Promise<string> {
  try {
    const metadata = await stat(directory, { bigint: true });
    return `${metadata.mtimeNs}:${metadata.size}`;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function catalogStamp(libraryRoot: string): Promise<LibraryCatalogStamp> {
  const [sources, archive, digest, synthesis] = await Promise.all([
    directoryStamp(resolveLibraryPath(libraryRoot, 'sources')),
    directoryStamp(resolveLibraryPath(libraryRoot, 'articles/archive')),
    directoryStamp(resolveLibraryPath(libraryRoot, 'articles/digest')),
    directoryStamp(resolveLibraryPath(libraryRoot, 'articles/synthesis')),
  ]);
  return { sources, archive, digest, synthesis };
}

function catalogMatches(left: LibraryCatalogStamp, right: LibraryCatalogStamp): boolean {
  return CATALOG_KEYS.every((key) => left[key] === right[key]);
}

function isStoredSource(value: unknown): value is SourceRecord {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<SourceRecord>;
  return source.schemaVersion === 1 &&
    typeof source.id === 'string' && SOURCE_ID_PATTERN.test(source.id) &&
    typeof source.kind === 'string' &&
    typeof source.capturedAt === 'string' &&
    Boolean(source.origin && typeof source.origin === 'object') &&
    Boolean(source.content && typeof source.content === 'object') &&
    source.content?.path === sourceContentPath(source.id) &&
    typeof source.content.contentHash === 'string' &&
    typeof source.content.textHash === 'string';
}

function isStoredArticle(value: unknown): value is ArticleRecord {
  if (!value || typeof value !== 'object') return false;
  const article = value as Partial<ArticleRecord>;
  return article.schemaVersion === 1 &&
    typeof article.id === 'string' && ARTICLE_ID_PATTERN.test(article.id) &&
    typeof article.mode === 'string' && ARTICLE_MODES.includes(article.mode as ArticleMode) &&
    typeof article.title === 'string' &&
    typeof article.slug === 'string' &&
    typeof article.createdAt === 'string' &&
    Array.isArray(article.sourceIds) &&
    Boolean(article.body && typeof article.body === 'object') &&
    article.body?.path === articleContentPath(article.mode as ArticleMode, article.id) &&
    typeof article.body.contentHash === 'string' &&
    typeof article.body.textHash === 'string';
}

function parseLibraryIndex(value: unknown): LibraryIndex | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const index = value as Partial<LibraryIndex>;
  if (
    index.schemaVersion !== 1 ||
    !Number.isSafeInteger(index.revision) ||
    (index.revision ?? 0) < 1 ||
    typeof index.updatedAt !== 'string' ||
    !index.catalog ||
    !CATALOG_KEYS.every((key) => typeof index.catalog?.[key] === 'string') ||
    !Array.isArray(index.sources) ||
    !index.sources.every(isStoredSource) ||
    !Array.isArray(index.articles) ||
    !index.articles.every(isStoredArticle)
  ) {
    return undefined;
  }
  const sourceIds = new Set(index.sources.map((source) => source.id));
  const articleIds = new Set(index.articles.map((article) => article.id));
  const slugs = new Set(index.articles.map((article) => article.slug));
  if (
    sourceIds.size !== index.sources.length ||
    articleIds.size !== index.articles.length ||
    slugs.size !== index.articles.length
  ) {
    return undefined;
  }
  return index as LibraryIndex;
}

async function readCandidate(libraryRoot: string): Promise<LibraryIndex | undefined> {
  try {
    const raw = await readFile(resolveLibraryPath(libraryRoot, LIBRARY_INDEX_PATH), 'utf8');
    return parseLibraryIndex(JSON.parse(raw));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function hasDirtyMarker(libraryRoot: string): Promise<boolean> {
  try {
    await access(resolveLibraryPath(libraryRoot, LIBRARY_INDEX_DIRTY_PATH));
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function atomicWrite(libraryRoot: string, relativePath: string, contents: string): Promise<void> {
  const target = resolveLibraryPath(libraryRoot, relativePath);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const canonicalRoot = await realpath(path.resolve(libraryRoot));
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error(`Library index path crosses a symlink outside its root: ${relativePath}`);
  }
  const canonicalTarget = path.join(canonicalParent, path.basename(target));
  const temporary = path.join(canonicalParent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, canonicalTarget);
    try {
      const directoryHandle = await open(canonicalParent, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Some platforms cannot fsync directories; the file itself is already synced and atomically renamed.
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

async function markDirty(libraryRoot: string): Promise<void> {
  await atomicWrite(libraryRoot, LIBRARY_INDEX_DIRTY_PATH, 'index update in progress\n');
}

async function clearDirty(libraryRoot: string): Promise<void> {
  await rm(resolveLibraryPath(libraryRoot, LIBRARY_INDEX_DIRTY_PATH), { force: true });
}

async function manifestsUnder<T>(
  libraryRoot: string,
  relativeDirectory: string,
  parse: (value: unknown, directoryName: string) => T | undefined,
  label: string,
): Promise<T[]> {
  const directory = resolveLibraryPath(libraryRoot, relativeDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: T[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(directory, entry.name, 'manifest.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error: unknown) {
      throw new Error(`Could not rebuild library index from ${manifestPath}: ${String(error)}`);
    }
    const record = parse(parsed, entry.name);
    if (!record) throw new Error(`Could not rebuild library index: invalid ${label} manifest ${manifestPath}`);
    records.push(record);
  }
  return records;
}

async function scanCanonicalManifests(libraryRoot: string): Promise<{ sources: SourceRecord[]; articles: ArticleRecord[] }> {
  const sources = await manifestsUnder(
    libraryRoot,
    'sources',
    (value, directoryName) => isStoredSource(value) && value.id === directoryName ? value : undefined,
    'source',
  );
  const articleGroups = await Promise.all(ARTICLE_MODES.map((mode) =>
    manifestsUnder(
      libraryRoot,
      path.posix.join('articles', mode),
      (value, directoryName) => isStoredArticle(value) && value.id === directoryName && value.mode === mode ? value : undefined,
      `${mode} article`,
    )));
  const articles = articleGroups.flat().sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  return { sources, articles };
}

function indexStats(libraryRoot: string, index: LibraryIndex): LibraryIndexStats {
  return {
    sourceCount: index.sources.length,
    articleCount: index.articles.length,
    revision: index.revision,
    indexPath: resolveLibraryPath(libraryRoot, LIBRARY_INDEX_PATH),
  };
}

export class LibraryIndexStore {
  private readonly libraryRoot: string;
  private readonly allowGitWorkingTree: boolean;
  private readonly now: () => Date;

  constructor(libraryRoot: string, options: LibraryIndexStoreOptions = {}) {
    this.libraryRoot = path.resolve(libraryRoot);
    this.allowGitWorkingTree = options.allowGitWorkingTree ?? false;
    this.now = options.now ?? (() => new Date());
  }

  private async ensureRoot(): Promise<void> {
    await assertSafeLibraryRoot(this.libraryRoot, { allowGitWorkingTree: this.allowGitWorkingTree });
    await mkdir(this.libraryRoot, { recursive: true });
  }

  private async freshCandidate(): Promise<LibraryIndex | undefined> {
    if (await hasDirtyMarker(this.libraryRoot)) return undefined;
    const candidate = await readCandidate(this.libraryRoot);
    if (!candidate) return undefined;
    return catalogMatches(candidate.catalog, await catalogStamp(this.libraryRoot)) ? candidate : undefined;
  }

  private async rebuildLocked(previous?: LibraryIndex): Promise<LibraryIndex> {
    const records = await scanCanonicalManifests(this.libraryRoot);
    const index: LibraryIndex = {
      schemaVersion: 1,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: this.now().toISOString(),
      catalog: await catalogStamp(this.libraryRoot),
      sources: records.sources,
      articles: records.articles,
    };
    if (!parseLibraryIndex(index)) {
      throw new Error('Could not rebuild library index: canonical manifests contain duplicate or invalid metadata');
    }
    await atomicWrite(this.libraryRoot, LIBRARY_INDEX_PATH, `${JSON.stringify(index)}\n`);
    await clearDirty(this.libraryRoot);
    return index;
  }

  private async loadOrRebuildLocked(): Promise<LibraryIndex> {
    const candidate = await readCandidate(this.libraryRoot);
    if (candidate && !(await hasDirtyMarker(this.libraryRoot)) && catalogMatches(candidate.catalog, await catalogStamp(this.libraryRoot))) {
      return candidate;
    }
    return this.rebuildLocked(candidate);
  }

  async read(): Promise<LibraryIndex> {
    await this.ensureRoot();
    const candidate = await this.freshCandidate();
    if (candidate) return candidate;
    return withIndexMutation(this.libraryRoot, () => this.loadOrRebuildLocked());
  }

  async rebuild(): Promise<LibraryIndexStats> {
    await this.ensureRoot();
    return withIndexMutation(this.libraryRoot, async () => {
      const rebuilt = await this.rebuildLocked(await readCandidate(this.libraryRoot));
      return indexStats(this.libraryRoot, rebuilt);
    });
  }

  async transaction<T>(
    operation: (index: LibraryIndex) => Promise<LibraryIndexTransactionResult<T>>,
  ): Promise<T> {
    await this.ensureRoot();
    return withIndexMutation(this.libraryRoot, async () => {
      const current = await this.loadOrRebuildLocked();
      await markDirty(this.libraryRoot);
      const result = await operation(current);
      const articles = [...result.articles].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
      const next: LibraryIndex = {
        schemaVersion: 1,
        revision: current.revision + 1,
        updatedAt: this.now().toISOString(),
        catalog: await catalogStamp(this.libraryRoot),
        sources: result.sources,
        articles,
      };
      if (!parseLibraryIndex(next)) throw new Error('Refusing to write an invalid library index');
      await atomicWrite(this.libraryRoot, LIBRARY_INDEX_PATH, `${JSON.stringify(next)}\n`);
      await clearDirty(this.libraryRoot);
      return result.value;
    });
  }
}
