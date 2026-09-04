import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ArticleRecord } from '../core/domain.ts';
import {
  applyArticleUserStatePatch,
  defaultArticleUserState,
  filterAndSortStatefulArticles,
  parseArticleUserStateSnapshot,
  parsePersistedArticleUserState,
  type ArticleStateFilters,
  type ArticleStateSort,
  type ArticleUserState,
  type ArticleUserStatePatch,
  type ArticleUserStateSnapshot,
  type PersistedArticleUserState,
  type StatefulArticle,
} from '../core/user-state.ts';
import { resolveLibraryPath, writeLibraryFileAtomic } from '../core/library.ts';
import type { LibraryService } from './library-service.ts';

const ARTICLE_USER_STATE_DIRECTORY = 'state/articles';
const ARTICLE_USER_STATE_LOCK_PATH = 'state/mutation.lock';
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const ARTICLE_ID_PATTERN = /^art_[a-z0-9]{16,64}$/u;

export interface UserStateServiceOptions {
  library: LibraryService;
  now?: () => Date;
}

export interface UpdateArticleUserStateInput {
  articleId: string;
  expectedRevision: number;
  patch: ArticleUserStatePatch;
}

export interface RestoreArticleUserStateResult {
  restored: number;
  unchanged: number;
}

function stateRelativePath(articleId: string): string {
  if (!ARTICLE_ID_PATTERN.test(articleId)) throw new Error(`Invalid article ID: ${articleId}`);
  return path.posix.join(ARTICLE_USER_STATE_DIRECTORY, `${articleId}.json`);
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const metadata = await stat(lockPath);
    if (Date.now() - metadata.mtimeMs <= STALE_LOCK_MS) return false;
    await rm(lockPath, { force: true });
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function withFileLock<T>(libraryDir: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = resolveLibraryPath(libraryDir, ARTICLE_USER_STATE_LOCK_PATH);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${process.pid}:${randomUUID()}\n`);
        return await operation();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await removeStaleLock(lockPath)) continue;
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) throw new Error('Timed out waiting for the user-state mutation lock');
      await delay(20);
    }
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export class UserStateService {
  private readonly library: LibraryService;
  private readonly now: () => Date;

  constructor(options: UserStateServiceOptions) {
    this.library = options.library;
    this.now = options.now ?? (() => new Date());
  }

  private async readPersisted(articleId: string): Promise<PersistedArticleUserState | undefined> {
    const statePath = resolveLibraryPath(this.library.libraryDir, stateRelativePath(articleId));
    try {
      return parsePersistedArticleUserState(JSON.parse(await readFile(statePath, 'utf8')), articleId);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(`Could not read user state for ${articleId}: ${String(error)}`);
    }
  }

  async get(articleId: string): Promise<ArticleUserState> {
    await this.library.loadArticle(articleId);
    return (await this.readPersisted(articleId)) ?? defaultArticleUserState(articleId);
  }

  async update(input: UpdateArticleUserStateInput): Promise<PersistedArticleUserState> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error('expectedRevision must be a non-negative integer');
    }
    await this.library.loadArticle(input.articleId);
    return withFileLock(this.library.libraryDir, async () => {
      const current = (await this.readPersisted(input.articleId)) ?? defaultArticleUserState(input.articleId);
      if (current.revision !== input.expectedRevision) {
        throw new Error(
          `User-state revision conflict for ${input.articleId}: expected ${input.expectedRevision}, current ${current.revision}`,
        );
      }
      const next = applyArticleUserStatePatch(current, input.patch, this.now().toISOString());
      await writeLibraryFileAtomic(
        this.library.libraryDir,
        stateRelativePath(input.articleId),
        json(next),
      );
      return next;
    });
  }

  private async statesFor(articles: readonly ArticleRecord[]): Promise<StatefulArticle[]> {
    return Promise.all(articles.map(async (article) => ({
      article,
      state: (await this.readPersisted(article.id)) ?? defaultArticleUserState(article.id),
    })));
  }

  async catalog(
    articles: readonly ArticleRecord[],
    filters: ArticleStateFilters = {},
    sort: ArticleStateSort = 'priority',
  ): Promise<StatefulArticle[]> {
    return filterAndSortStatefulArticles(await this.statesFor(articles), filters, sort);
  }

  async queue(
    filters: ArticleStateFilters = {},
    sort: ArticleStateSort = 'priority',
  ): Promise<StatefulArticle[]> {
    const articles = await this.library.listArticles();
    const items = await this.statesFor(articles);
    const queueItems = filters.status
      ? items
      : items.filter(({ state }) => state.status === 'unread' || state.status === 'reading');
    return filterAndSortStatefulArticles(queueItems, filters, sort);
  }

  private async persistedRecords(): Promise<PersistedArticleUserState[]> {
    const directory = resolveLibraryPath(this.library.libraryDir, ARTICLE_USER_STATE_DIRECTORY);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = await Promise.all(names
      .filter((name) => /^art_[a-z0-9]{16,64}\.json$/u.test(name))
      .sort()
      .map(async (name) => {
        const articleId = name.slice(0, -'.json'.length);
        return parsePersistedArticleUserState(
          JSON.parse(await readFile(resolveLibraryPath(this.library.libraryDir, stateRelativePath(articleId)), 'utf8')),
          articleId,
        );
      }));
    return records;
  }

  async snapshot(): Promise<ArticleUserStateSnapshot> {
    return withFileLock(this.library.libraryDir, async () => ({
      schemaVersion: 1,
      records: await this.persistedRecords(),
    }));
  }

  async restore(snapshotInput: unknown): Promise<RestoreArticleUserStateResult> {
    const snapshot = parseArticleUserStateSnapshot(snapshotInput);
    await Promise.all(snapshot.records.map((record) => this.library.loadArticle(record.articleId)));
    return withFileLock(this.library.libraryDir, async () => {
      const existing = new Map<string, PersistedArticleUserState | undefined>();
      for (const record of snapshot.records) existing.set(record.articleId, await this.readPersisted(record.articleId));
      for (const record of snapshot.records) {
        const current = existing.get(record.articleId);
        if (current && JSON.stringify(current) !== JSON.stringify(record)) {
          throw new Error(`User-state restore collision for ${record.articleId}`);
        }
      }
      let restored = 0;
      for (const record of snapshot.records) {
        if (existing.get(record.articleId)) continue;
        await writeLibraryFileAtomic(this.library.libraryDir, stateRelativePath(record.articleId), json(record));
        restored += 1;
      }
      return { restored, unchanged: snapshot.records.length - restored };
    });
  }
}
