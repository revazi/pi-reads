import type { ArticleRecord } from './domain.ts';

const READING_STATUSES = ['unread', 'reading', 'completed', 'archived'] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];
export type ArticleStateSort = 'priority' | 'due' | 'read-later' | 'rating' | 'updated' | 'created' | 'title';

export interface ArticleUserState {
  schemaVersion: 1;
  articleId: string;
  revision: number;
  status: ReadingStatus;
  tags: string[];
  rating?: number;
  priority: number;
  dueAt?: string;
  readLaterAt?: string;
  updatedAt?: string;
}

export interface PersistedArticleUserState extends ArticleUserState {
  updatedAt: string;
}

export interface ArticleUserStatePatch {
  status?: ReadingStatus;
  tags?: string[];
  rating?: number | null;
  priority?: number;
  dueAt?: string | null;
  readLaterAt?: string | null;
}

export interface ArticleStateFilters {
  status?: ReadingStatus;
  tag?: string;
  minimumRating?: number;
  minimumPriority?: number;
  dueBefore?: string;
  readLaterBefore?: string;
}

export interface StatefulArticle {
  article: ArticleRecord;
  state: ArticleUserState;
}

export interface ArticleUserStateSnapshot {
  schemaVersion: 1;
  records: PersistedArticleUserState[];
}

const ARTICLE_ID_PATTERN = /^art_[a-z0-9]{16,64}$/u;
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

function assertArticleId(articleId: string): void {
  if (!ARTICLE_ID_PATTERN.test(articleId)) throw new Error(`Invalid article ID: ${articleId}`);
}

function normalizedTimestamp(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${label} must be an ISO date or timestamp`);
  return new Date(parsed).toISOString();
}

function normalizedTags(tags: readonly string[]): string[] {
  if (tags.length > 50) throw new Error('User state supports at most 50 tags');
  const normalized = tags.map((tag) => tag.trim().normalize('NFKC').toLowerCase());
  for (const tag of normalized) {
    if (!TAG_PATTERN.test(tag)) throw new Error(`Invalid user tag: ${tag || '(empty)'}`);
  }
  return [...new Set(normalized)].sort();
}

function assertRating(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 5)) {
    throw new Error('Rating must be an integer from 1 to 5');
  }
}

function assertPriority(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 5) {
    throw new Error('Priority must be an integer from 0 to 5');
  }
}

export function defaultArticleUserState(articleId: string): ArticleUserState {
  assertArticleId(articleId);
  return { schemaVersion: 1, articleId, revision: 0, status: 'unread', tags: [], priority: 0 };
}

function assertStatus(value: ReadingStatus | undefined): void {
  if (value !== undefined && !READING_STATUSES.includes(value)) {
    throw new Error(`Unsupported reading status: ${String(value)}`);
  }
}

function normalizedOptionalTimestamp(value: string | null | undefined, label: string): string | null | undefined {
  return typeof value === 'string' ? normalizedTimestamp(value, label) : value;
}

function assignScalarPatch(source: ArticleUserStatePatch, target: ArticleUserStatePatch): void {
  if (source.status !== undefined) target.status = source.status;
  if (source.rating !== undefined) target.rating = source.rating;
  if (source.priority !== undefined) target.priority = source.priority;
}

function assignCollectionPatch(source: ArticleUserStatePatch, target: ArticleUserStatePatch): void {
  if (source.tags !== undefined) target.tags = normalizedTags(source.tags);
}

function assignDatePatch(source: ArticleUserStatePatch, target: ArticleUserStatePatch): void {
  if (source.dueAt !== undefined) target.dueAt = normalizedOptionalTimestamp(source.dueAt, 'dueAt');
  if (source.readLaterAt !== undefined) {
    target.readLaterAt = normalizedOptionalTimestamp(source.readLaterAt, 'readLaterAt');
  }
}

function normalizeArticleUserStatePatch(patch: ArticleUserStatePatch): ArticleUserStatePatch {
  if (!Object.values(patch).some((value) => value !== undefined)) {
    throw new Error('User-state update requires at least one field');
  }
  assertStatus(patch.status);
  if (patch.rating !== null) assertRating(patch.rating);
  if (patch.priority !== undefined) assertPriority(patch.priority);
  const normalized: ArticleUserStatePatch = {};
  assignScalarPatch(patch, normalized);
  assignCollectionPatch(patch, normalized);
  assignDatePatch(patch, normalized);
  return normalized;
}

function optionalValue<T>(patchValue: T | null | undefined, current: T | undefined): T | undefined {
  if (patchValue === undefined) return current;
  return patchValue === null ? undefined : patchValue;
}

export function applyArticleUserStatePatch(
  current: ArticleUserState,
  patch: ArticleUserStatePatch,
  updatedAt: string,
): PersistedArticleUserState {
  const normalized = normalizeArticleUserStatePatch(patch);
  const next: PersistedArticleUserState = {
    schemaVersion: 1,
    articleId: current.articleId,
    revision: current.revision + 1,
    status: normalized.status ?? current.status,
    tags: normalized.tags ?? current.tags,
    priority: normalized.priority ?? current.priority,
    ...(optionalValue(normalized.rating, current.rating) === undefined
      ? {}
      : { rating: optionalValue(normalized.rating, current.rating)! }),
    ...(optionalValue(normalized.dueAt, current.dueAt) === undefined
      ? {}
      : { dueAt: optionalValue(normalized.dueAt, current.dueAt)! }),
    ...(optionalValue(normalized.readLaterAt, current.readLaterAt) === undefined
      ? {}
      : { readLaterAt: optionalValue(normalized.readLaterAt, current.readLaterAt)! }),
    updatedAt: normalizedTimestamp(updatedAt, 'updatedAt'),
  };
  return next;
}

const STATE_KEYS = new Set([
  'schemaVersion', 'articleId', 'revision', 'status', 'tags', 'rating', 'priority', 'dueAt', 'readLaterAt', 'updatedAt',
]);

function stateIdentity(value: unknown, expectedArticleId: string | undefined): Partial<PersistedArticleUserState> & { articleId: string } {
  if (!value || typeof value !== 'object') throw new Error('User-state record must be an object');
  if (!Object.keys(value).every((key) => STATE_KEYS.has(key))) throw new Error('User-state record has unsupported properties');
  const state = value as Partial<PersistedArticleUserState>;
  if (state.schemaVersion !== 1 || typeof state.articleId !== 'string') throw new Error('Invalid user-state identity');
  assertArticleId(state.articleId);
  if (expectedArticleId && state.articleId !== expectedArticleId) throw new Error(`User-state article ID mismatch for ${expectedArticleId}`);
  return state as Partial<PersistedArticleUserState> & { articleId: string };
}

function stateRevision(state: Partial<PersistedArticleUserState> & { articleId: string }): number {
  if (!Number.isSafeInteger(state.revision) || (state.revision ?? 0) < 1) {
    throw new Error(`Invalid user-state revision for ${state.articleId}`);
  }
  return state.revision!;
}

function stateStatus(state: Partial<PersistedArticleUserState> & { articleId: string }): ReadingStatus {
  if (!state.status || !READING_STATUSES.includes(state.status)) throw new Error(`Invalid reading status for ${state.articleId}`);
  return state.status;
}

function stateTags(state: Partial<PersistedArticleUserState> & { articleId: string }): string[] {
  if (!Array.isArray(state.tags) || !state.tags.every((tag) => typeof tag === 'string')) {
    throw new Error(`Invalid tags for ${state.articleId}`);
  }
  const tags = normalizedTags(state.tags);
  if (JSON.stringify(tags) !== JSON.stringify(state.tags)) throw new Error(`User-state tags are not canonical for ${state.articleId}`);
  return tags;
}

function statePriority(state: Partial<PersistedArticleUserState> & { articleId: string }): number {
  if (state.priority === undefined) throw new Error(`Missing priority for ${state.articleId}`);
  assertPriority(state.priority);
  return state.priority;
}

export function parsePersistedArticleUserState(value: unknown, expectedArticleId?: string): PersistedArticleUserState {
  const state = stateIdentity(value, expectedArticleId);
  const revision = stateRevision(state);
  const status = stateStatus(state);
  const tags = stateTags(state);
  const priority = statePriority(state);
  assertRating(state.rating);
  const dueAt = state.dueAt === undefined ? undefined : normalizedTimestamp(state.dueAt, 'dueAt');
  const readLaterAt = state.readLaterAt === undefined ? undefined : normalizedTimestamp(state.readLaterAt, 'readLaterAt');
  if (typeof state.updatedAt !== 'string') throw new Error(`Missing updatedAt for ${state.articleId}`);
  const updatedAt = normalizedTimestamp(state.updatedAt, 'updatedAt');
  return {
    schemaVersion: 1,
    articleId: state.articleId,
    revision,
    status,
    tags,
    ...(state.rating === undefined ? {} : { rating: state.rating }),
    priority,
    ...(dueAt ? { dueAt } : {}),
    ...(readLaterAt ? { readLaterAt } : {}),
    updatedAt,
  };
}

function dateOrder(value: string | undefined): string {
  return value ?? '9999-12-31T23:59:59.999Z';
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

const STATE_COMPARATORS: Record<ArticleStateSort, (left: StatefulArticle, right: StatefulArticle) => number> = {
  due: (left, right) => compareText(dateOrder(left.state.dueAt), dateOrder(right.state.dueAt)),
  'read-later': (left, right) => compareText(dateOrder(left.state.readLaterAt), dateOrder(right.state.readLaterAt)),
  rating: (left, right) => (right.state.rating ?? 0) - (left.state.rating ?? 0),
  updated: (left, right) => compareText(right.state.updatedAt ?? '', left.state.updatedAt ?? ''),
  created: (left, right) => compareText(right.article.createdAt, left.article.createdAt),
  title: (left, right) => compareText(left.article.title, right.article.title),
  priority: (left, right) => right.state.priority - left.state.priority,
};

function compareStateful(left: StatefulArticle, right: StatefulArticle, sort: ArticleStateSort): number {
  return STATE_COMPARATORS[sort](left, right);
}

function optionalEqual<T>(filter: T | undefined, value: T): boolean {
  return filter === undefined ? true : filter === value;
}

function optionalMember(filter: string | undefined, values: readonly string[]): boolean {
  return filter === undefined ? true : values.includes(filter);
}

function optionalMinimum(filter: number | undefined, value: number): boolean {
  return filter === undefined ? true : value >= filter;
}

function optionalDateMaximum(filter: string | undefined, value: string | undefined): boolean {
  return filter === undefined ? true : value !== undefined && value <= filter;
}

function matchesStateFilters(item: StatefulArticle, filters: ArticleStateFilters): boolean {
  return [
    optionalEqual(filters.status, item.state.status),
    optionalMember(filters.tag, item.state.tags),
    optionalMinimum(filters.minimumRating, item.state.rating ?? 0),
    optionalMinimum(filters.minimumPriority, item.state.priority),
    optionalDateMaximum(filters.dueBefore, item.state.dueAt),
    optionalDateMaximum(filters.readLaterBefore, item.state.readLaterAt),
  ].every(Boolean);
}

export function filterAndSortStatefulArticles(
  items: readonly StatefulArticle[],
  filters: ArticleStateFilters = {},
  sort: ArticleStateSort = 'priority',
): StatefulArticle[] {
  if (!(sort in STATE_COMPARATORS)) throw new Error(`Unsupported article-state sort: ${String(sort)}`);
  assertStatus(filters.status);
  assertRating(filters.minimumRating);
  if (filters.minimumPriority !== undefined) assertPriority(filters.minimumPriority);
  const normalizedFilters: ArticleStateFilters = {
    ...filters,
    ...(filters.tag ? { tag: normalizedTags([filters.tag])[0] } : {}),
    ...(filters.dueBefore ? { dueBefore: normalizedTimestamp(filters.dueBefore, 'dueBefore') } : {}),
    ...(filters.readLaterBefore
      ? { readLaterBefore: normalizedTimestamp(filters.readLaterBefore, 'readLaterBefore') }
      : {}),
  };
  return items
    .filter((item) => matchesStateFilters(item, normalizedFilters))
    .sort((left, right) =>
      compareStateful(left, right, sort) ||
      compareText(dateOrder(left.state.dueAt), dateOrder(right.state.dueAt)) ||
      compareText(left.article.createdAt, right.article.createdAt) ||
      compareText(left.article.id, right.article.id));
}

export function parseArticleUserStateSnapshot(value: unknown): ArticleUserStateSnapshot {
  if (!value || typeof value !== 'object') throw new Error('User-state snapshot must be an object');
  const snapshot = value as Partial<ArticleUserStateSnapshot>;
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.records)) throw new Error('Invalid user-state snapshot');
  const records = snapshot.records.map((record) => parsePersistedArticleUserState(record));
  const ids = new Set(records.map((record) => record.articleId));
  if (ids.size !== records.length) throw new Error('User-state snapshot contains duplicate article IDs');
  return { schemaVersion: 1, records: records.sort((left, right) => compareText(left.articleId, right.articleId)) };
}
