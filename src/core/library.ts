import { access, link, mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArticleMode, ArticleRecord, SourceRecord } from './domain.ts';
import { errorMessage } from './errors.ts';
import { slugify } from './extraction/readability.ts';

const ID_PREFIXES = ['src', 'art', 'cite', 'exp'] as const;
type IdPrefix = (typeof ID_PREFIXES)[number];

export function createRecordId(prefix: IdPrefix, uuid = randomUUID()): string {
  const entropy = uuid.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (entropy.length < 16) {
    throw new Error('Record ID entropy must contain at least 16 alphanumeric characters');
  }
  return `${prefix}_${entropy.slice(0, 64)}`;
}

export function sourceDirectory(sourceId: string): string {
  return path.posix.join('sources', sourceId);
}

export function sourceContentPath(sourceId: string): string {
  return path.posix.join(sourceDirectory(sourceId), 'content.md');
}

export function articleDirectory(mode: ArticleMode, articleId: string): string {
  return path.posix.join('articles', mode, articleId);
}

export function articleContentPath(mode: ArticleMode, articleId: string): string {
  return path.posix.join(articleDirectory(mode, articleId), 'content.md');
}

export function exportDirectory(articleId: string, exportId: string): string {
  return path.posix.join('exports', articleId, exportId);
}

export function chooseAvailableSlug(value: string, existingSlugs: Iterable<string>): string {
  const base = slugify(value);
  const existing = new Set(existingSlugs);
  if (!existing.has(base)) {
    return base;
  }

  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

export function resolveLibraryPath(libraryRoot: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
    throw new Error(`Library path must be relative: ${relativePath}`);
  }
  if (relativePath.includes('\\')) {
    throw new Error(`Library path must use forward slashes: ${relativePath}`);
  }

  const segments = relativePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe library path: ${relativePath}`);
  }

  const root = path.resolve(libraryRoot);
  const resolved = path.resolve(root, ...segments);
  const prefix = `${root}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    throw new Error(`Library path escapes its root: ${relativePath}`);
  }
  return resolved;
}

async function containsGitDirectory(start: string): Promise<string | undefined> {
  let current = path.resolve(start);
  while (true) {
    try {
      await access(path.join(current, '.git'));
      return current;
    } catch {
      // Keep walking toward the filesystem root.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function assertSafeLibraryRoot(
  libraryRoot: string,
  options: { allowGitWorkingTree?: boolean } = {},
): Promise<void> {
  if (options.allowGitWorkingTree) {
    return;
  }

  const gitRoot = await containsGitDirectory(libraryRoot);
  if (gitRoot) {
    throw new Error(`Refusing to store the Pi Reads library inside Git working tree ${gitRoot}`);
  }
}

export async function writeLibraryFileCreateOnly(
  libraryRoot: string,
  relativePath: string,
  contents: string | NodeJS.ArrayBufferView,
): Promise<string> {
  const target = resolveLibraryPath(libraryRoot, relativePath);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });

  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  await writeFile(temporary, contents, { flag: 'wx' });

  try {
    await link(temporary, target);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Immutable library file already exists: ${relativePath}`);
    }
    throw new Error(`Could not create ${relativePath}: ${errorMessage(error)}`);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }

  return target;
}

export function assertArticleInvariants(article: ArticleRecord, sources: ReadonlyMap<string, SourceRecord>): void {
  if (article.sourceIds.length === 0) {
    throw new Error('Article must reference at least one source');
  }
  if (article.body.path !== articleContentPath(article.mode, article.id)) {
    throw new Error(`Article body path does not match ${article.mode} storage`);
  }

  for (const sourceId of article.sourceIds) {
    if (!sources.has(sourceId)) {
      throw new Error(`Article references unknown source ${sourceId}`);
    }
  }

  if (article.mode === 'archive') {
    if (article.sourceIds.length !== 1 || !article.archiveVerification || article.generatedBy) {
      throw new Error('Archive article requires one source and archive verification without generation metadata');
    }

    const sourceId = article.sourceIds[0];
    const source = sources.get(sourceId);
    if (!source) {
      throw new Error(`Archive article references unknown source ${sourceId}`);
    }
    if (article.archiveVerification.sourceId !== sourceId) {
      throw new Error('Archive verification source does not match the article source');
    }
    if (
      article.archiveVerification.sourceTextHash !== source.content.textHash ||
      article.body.textHash !== source.content.textHash
    ) {
      throw new Error('Archive article text hash does not match its source');
    }
    return;
  }

  if (!article.generatedBy || article.archiveVerification) {
    throw new Error(`${article.mode} article requires generation metadata without archive verification`);
  }
  if (article.citations.length === 0) {
    throw new Error(`${article.mode} article requires at least one citation`);
  }

  const sourceIds = new Set(article.sourceIds);
  const citationIds = new Set<string>();
  for (const citation of article.citations) {
    if (!sourceIds.has(citation.sourceId)) {
      throw new Error(`Citation ${citation.id} references a source outside the article`);
    }
    if (citationIds.has(citation.id)) {
      throw new Error(`Duplicate citation ID ${citation.id}`);
    }
    citationIds.add(citation.id);
  }
}
