import { readFile } from 'node:fs/promises';
import type { ArticleRecord, SourceRecord } from '../core/domain.ts';
import {
  createArticleSearchBlocks,
  createFullTextSearchIndex,
  FULL_TEXT_SEARCH_ALGORITHM,
  fullTextCorpusHash,
  lexicalTerms,
  scoreFullTextIndex,
  verifyFullTextSearchIndexHash,
  type FullTextCorpusDocument,
  type FullTextSearchBlock,
  type FullTextSearchDocument,
  type FullTextSearchDocumentInput,
  type FullTextSearchFilters,
  type FullTextSearchIndex,
} from '../core/full-text-search.ts';
import type { IndexedSourceRange } from '../core/source-index.ts';
import {
  resolveLibraryPath,
  writeLibraryFileAtomic,
} from '../core/library.ts';
import { versionedSha256 } from '../core/text.ts';
import type { ArticleUserState } from '../core/user-state.ts';
import type { LibraryService } from './library-service.ts';
import type { UserStateService } from './user-state-service.ts';

export const FULL_TEXT_SEARCH_INDEX_PATH = 'indexes/search-v1.json';
const MAX_SNIPPET_BYTES = 320;

export interface FullTextSearchSnippet {
  field: 'title' | 'author' | 'url' | 'tag' | 'status' | 'body';
  locator: string;
  excerpt: string;
  startByte?: number;
  endByte?: number;
  clippedBefore?: boolean;
  clippedAfter?: boolean;
  sourceId?: string;
}

export interface FullTextSearchHit {
  articleId: string;
  mode: ArticleRecord['mode'];
  title: string;
  sourceIds: string[];
  score: number;
  snippet: FullTextSearchSnippet;
}

export interface FullTextSearchResult {
  query: string;
  totalMatches: number;
  hits: FullTextSearchHit[];
  recoveredIndex: boolean;
}

export interface SearchIndexStats {
  indexPath: string;
  documentCount: number;
  corpusHash: string;
}

export interface SearchServiceOptions {
  library: LibraryService;
  userState?: UserStateService;
}

const rebuildTails = new Map<string, Promise<void>>();

async function withSearchRebuild<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = rebuildTails.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  rebuildTails.set(key, tail);
  try {
    return await result;
  } finally {
    if (rebuildTails.get(key) === tail) rebuildTails.delete(key);
  }
}

function corpusDocument(
  article: ArticleRecord,
  sources: ReadonlyMap<string, SourceRecord>,
  state?: ArticleUserState,
): FullTextCorpusDocument {
  const articleSources = article.sourceIds.map((sourceId) => sources.get(sourceId)).filter(Boolean) as SourceRecord[];
  const authors = [...new Set([...(article.authors ?? []), ...articleSources.flatMap((source) => source.authors ?? [])])];
  const canonicalUrls = [...new Set(articleSources.flatMap((source) => source.origin.canonicalUrl ? [source.origin.canonicalUrl] : []))];
  return {
    articleId: article.id,
    mode: article.mode,
    title: article.title,
    authors,
    canonicalUrls,
    sourceIds: article.sourceIds,
    createdAt: article.createdAt,
    contentHash: article.body.contentHash,
    ...(state?.tags.length ? { tags: state.tags } : {}),
    ...(state ? { status: state.status } : {}),
  };
}

function sourceBlocks(ranges: readonly IndexedSourceRange[]): FullTextSearchBlock[] {
  return [...ranges]
    .sort((left, right) => left.startByte - right.startByte)
    .map(({ id, startByte, endByte, textHash }) => ({ locator: id, startByte, endByte, textHash }));
}

function isSearchIndex(value: unknown): value is FullTextSearchIndex {
  if (!value || typeof value !== 'object') return false;
  const index = value as Partial<FullTextSearchIndex>;
  const shapeChecks = [
    index.schemaVersion === 1,
    index.algorithm === FULL_TEXT_SEARCH_ALGORITHM,
    typeof index.corpusHash === 'string',
    typeof index.indexHash === 'string',
    Number.isSafeInteger(index.documentCount),
    typeof index.averageDocumentLength === 'number',
    Array.isArray(index.documents),
    index.documentCount === index.documents?.length,
  ];
  if (!shapeChecks.every(Boolean)) return false;
  return verifyFullTextSearchIndexHash(index as FullTextSearchIndex);
}

function matchingToken(value: string, queryTerms: ReadonlySet<string>): { start: number; end: number } | undefined {
  for (const match of value.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (queryTerms.has(match[0].normalize('NFKC').toLowerCase())) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }
  return undefined;
}

function exactSnippet(value: string, match: { start: number; end: number }): {
  excerpt: string;
  relativeStartByte: number;
  relativeEndByte: number;
  clippedBefore: boolean;
  clippedAfter: boolean;
} {
  const points = [...value];
  const offsets: number[] = [0];
  let codeUnits = 0;
  for (const point of points) {
    codeUnits += point.length;
    offsets.push(codeUnits);
  }
  const startPoint = Math.max(0, offsets.findIndex((offset) => offset >= match.start) - 80);
  const matchEndPoint = offsets.findIndex((offset) => offset >= match.end);
  let endPoint = Math.min(points.length, (matchEndPoint < 0 ? points.length : matchEndPoint) + 80);
  let excerpt = points.slice(startPoint, endPoint).join('');
  while (Buffer.byteLength(excerpt) > MAX_SNIPPET_BYTES && endPoint > startPoint + 1) {
    endPoint -= 1;
    excerpt = points.slice(startPoint, endPoint).join('');
  }
  const prefix = points.slice(0, startPoint).join('');
  return {
    excerpt,
    relativeStartByte: Buffer.byteLength(prefix),
    relativeEndByte: Buffer.byteLength(prefix) + Buffer.byteLength(excerpt),
    clippedBefore: startPoint > 0,
    clippedAfter: endPoint < points.length,
  };
}

function metadataSnippet(
  document: FullTextSearchDocument,
  queryTerms: ReadonlySet<string>,
): FullTextSearchSnippet | undefined {
  const fields: Array<{ field: FullTextSearchSnippet['field']; locator: string; value: string }> = [
    { field: 'title', locator: 'metadata:title', value: document.title },
    ...document.authors.map((value, index) => ({ field: 'author' as const, locator: `metadata:author:${index + 1}`, value })),
    ...document.canonicalUrls.map((value, index) => ({ field: 'url' as const, locator: `metadata:url:${index + 1}`, value })),
    ...(document.tags ?? []).map((value, index) => ({ field: 'tag' as const, locator: `metadata:tag:${index + 1}`, value })),
    ...(document.status ? [{ field: 'status' as const, locator: 'metadata:status', value: document.status }] : []),
  ];
  for (const field of fields) {
    const match = matchingToken(field.value, queryTerms);
    if (!match) continue;
    const snippet = exactSnippet(field.value, match);
    return {
      field: field.field,
      locator: field.locator,
      excerpt: snippet.excerpt,
      ...(snippet.clippedBefore ? { clippedBefore: true } : {}),
      ...(snippet.clippedAfter ? { clippedAfter: true } : {}),
    };
  }
  return undefined;
}

function bodySnippet(
  document: FullTextSearchDocument,
  content: string,
  queryTerms: ReadonlySet<string>,
): FullTextSearchSnippet {
  const bytes = Buffer.from(content);
  for (const block of document.blocks) {
    const blockText = bytes.subarray(block.startByte, block.endByte).toString('utf8');
    if (versionedSha256(blockText) !== block.textHash) throw new Error(`Search block ${block.locator} failed integrity verification`);
    const match = matchingToken(blockText, queryTerms);
    if (!match) continue;
    const snippet = exactSnippet(blockText, match);
    return {
      field: 'body',
      locator: block.locator,
      excerpt: snippet.excerpt,
      startByte: block.startByte + snippet.relativeStartByte,
      endByte: block.startByte + snippet.relativeEndByte,
      ...(snippet.clippedBefore ? { clippedBefore: true } : {}),
      ...(snippet.clippedAfter ? { clippedAfter: true } : {}),
      ...(document.mode === 'archive' ? { sourceId: document.sourceIds[0] } : {}),
    };
  }
  throw new Error(`Search index matched ${document.articleId}, but no exact metadata or body excerpt resolved`);
}

function normalizedDateFilter(value: string | undefined, label: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO date or timestamp`);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
  return new Date(value).toISOString();
}

export class SearchService {
  private readonly library: LibraryService;
  private readonly userState: UserStateService | undefined;
  private readonly indexPath: string;

  constructor(options: SearchServiceOptions) {
    this.library = options.library;
    this.userState = options.userState;
    this.indexPath = resolveLibraryPath(options.library.libraryDir, FULL_TEXT_SEARCH_INDEX_PATH);
  }

  private async corpus(): Promise<{ descriptors: FullTextCorpusDocument[]; sources: Map<string, SourceRecord> }> {
    const [articles, sourceRecords] = await Promise.all([this.library.listArticles(), this.library.listSources()]);
    const sources = new Map(sourceRecords.map((source) => [source.id, source]));
    const stateItems = this.userState ? await this.userState.catalog(articles, {}, 'created') : [];
    const states = new Map(stateItems.map(({ article, state }) => [article.id, state]));
    return { descriptors: articles.map((article) => corpusDocument(article, sources, states.get(article.id))), sources };
  }

  private async buildInputs(
    descriptors: readonly FullTextCorpusDocument[],
  ): Promise<FullTextSearchDocumentInput[]> {
    return Promise.all(descriptors.map(async (descriptor) => {
      const stored = await this.library.loadArticle(descriptor.articleId);
      const blocks = stored.article.mode === 'archive'
        ? await this.library.loadSourceIndex(stored.article.sourceIds[0]!).then(({ index }) =>
            sourceBlocks([...index.headings, ...index.paragraphs]))
        : createArticleSearchBlocks(stored.content);
      return { ...descriptor, content: stored.content, blocks };
    }));
  }

  private async rebuildFrom(descriptors: readonly FullTextCorpusDocument[]): Promise<FullTextSearchIndex> {
    const index = createFullTextSearchIndex(await this.buildInputs(descriptors));
    await writeLibraryFileAtomic(this.library.libraryDir, FULL_TEXT_SEARCH_INDEX_PATH, `${JSON.stringify(index)}\n`);
    return index;
  }

  async rebuild(): Promise<SearchIndexStats> {
    const { descriptors } = await this.corpus();
    const index = await withSearchRebuild(this.indexPath, () => this.rebuildFrom(descriptors));
    return { indexPath: this.indexPath, documentCount: index.documentCount, corpusHash: index.corpusHash };
  }

  private async readCandidate(expectedHash: string): Promise<FullTextSearchIndex | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.indexPath, 'utf8'));
      return isSearchIndex(parsed) && parsed.corpusHash === expectedHash ? parsed : undefined;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  private async load(): Promise<{ index: FullTextSearchIndex; recovered: boolean }> {
    const { descriptors } = await this.corpus();
    const expectedHash = fullTextCorpusHash(descriptors);
    const existing = await this.readCandidate(expectedHash);
    if (existing) return { index: existing, recovered: false };
    const index = await withSearchRebuild(this.indexPath, async () =>
      (await this.readCandidate(expectedHash)) ?? this.rebuildFrom(descriptors));
    return { index, recovered: true };
  }

  async search(
    query: string,
    filters: FullTextSearchFilters = {},
    limit = 20,
  ): Promise<FullTextSearchResult> {
    const from = normalizedDateFilter(filters.from, 'from', false);
    const to = normalizedDateFilter(filters.to, 'to', true);
    if (from && to && from > to) throw new Error('from must not be after to');
    const normalizedFilters = {
      ...filters,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Search limit must be from 1 to 100');
    const { index, recovered } = await this.load();
    const allMatches = scoreFullTextIndex(index, query, normalizedFilters);
    const scored = allMatches.slice(0, limit);
    const queryTerms = new Set(lexicalTerms(query));
    const hits = await Promise.all(scored.map(async ({ document, score }) => {
      const stored = await this.library.loadArticle(document.articleId);
      if (stored.article.body.contentHash !== document.contentHash) throw new Error(`Search result ${document.articleId} is stale`);
      const snippet = metadataSnippet(document, queryTerms) ?? bodySnippet(document, stored.content, queryTerms);
      return {
        articleId: document.articleId,
        mode: document.mode,
        title: document.title,
        sourceIds: document.sourceIds,
        score,
        snippet,
      };
    }));
    return { query, totalMatches: allMatches.length, hits, recoveredIndex: recovered };
  }
}
