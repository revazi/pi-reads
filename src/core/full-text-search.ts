import { marked } from 'marked';
import type { ArticleMode, Sha256Digest } from './domain.ts';
import { versionedSha256 } from './text.ts';

export const FULL_TEXT_SEARCH_ALGORITHM = 'bm25-lexical-v1';

export interface FullTextSearchBlock {
  locator: string;
  startByte: number;
  endByte: number;
  textHash: Sha256Digest;
}

export interface FullTextCorpusDocument {
  articleId: string;
  mode: ArticleMode;
  title: string;
  authors: string[];
  canonicalUrls: string[];
  sourceIds: string[];
  createdAt: string;
  contentHash: Sha256Digest;
  tags?: string[];
  status?: string;
}

export interface FullTextSearchDocumentInput extends FullTextCorpusDocument {
  content: string;
  blocks: FullTextSearchBlock[];
}

export interface FullTextSearchDocument extends Omit<FullTextSearchDocumentInput, 'content'> {
  documentLength: number;
  termFrequencies: Array<[term: string, count: number]>;
}

export interface FullTextSearchIndex {
  schemaVersion: 1;
  algorithm: typeof FULL_TEXT_SEARCH_ALGORITHM;
  corpusHash: Sha256Digest;
  indexHash: Sha256Digest;
  documentCount: number;
  averageDocumentLength: number;
  documents: FullTextSearchDocument[];
}

export interface FullTextSearchFilters {
  mode?: ArticleMode;
  from?: string;
  to?: string;
  author?: string;
  sourceId?: string;
  tag?: string;
  status?: string;
}

export interface ScoredSearchDocument {
  document: FullTextSearchDocument;
  score: number;
}

function normalizedTerm(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

export function lexicalTerms(value: string): string[] {
  return [...value.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => normalizedTerm(match[0]));
}

function addTerms(frequencies: Map<string, number>, value: string, weight: number): number {
  const terms = lexicalTerms(value);
  for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + weight);
  return terms.length * weight;
}

function weightedDocumentLength(
  input: FullTextSearchDocumentInput,
  frequencies: Map<string, number>,
): number {
  const fields: Array<{ values: string[]; weight: number }> = [
    { values: [input.content], weight: 1 },
    { values: [input.title], weight: 4 },
    { values: input.authors, weight: 3 },
    { values: input.canonicalUrls, weight: 2 },
    { values: input.tags ?? [], weight: 2 },
    { values: input.status ? [input.status] : [], weight: 1 },
  ];
  return fields.reduce((total, field) =>
    total + field.values.reduce((fieldTotal, value) => fieldTotal + addTerms(frequencies, value, field.weight), 0), 0);
}

function compareTerms([left]: [string, number], [right]: [string, number]): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function optionalDocumentMetadata(input: FullTextSearchDocumentInput): Pick<FullTextSearchDocument, 'tags' | 'status'> {
  return {
    ...(input.tags?.length ? { tags: input.tags } : {}),
    ...(input.status ? { status: input.status } : {}),
  };
}

function searchDocument(input: FullTextSearchDocumentInput): FullTextSearchDocument {
  if (versionedSha256(input.content) !== input.contentHash) {
    throw new Error(`Search document ${input.articleId} content hash mismatch`);
  }
  const frequencies = new Map<string, number>();
  return {
    articleId: input.articleId,
    mode: input.mode,
    title: input.title,
    authors: input.authors,
    canonicalUrls: input.canonicalUrls,
    sourceIds: input.sourceIds,
    createdAt: input.createdAt,
    contentHash: input.contentHash,
    blocks: input.blocks,
    ...optionalDocumentMetadata(input),
    documentLength: weightedDocumentLength(input, frequencies),
    termFrequencies: [...frequencies].sort(compareTerms),
  };
}

export function fullTextCorpusHash(inputs: readonly FullTextCorpusDocument[]): Sha256Digest {
  return versionedSha256(JSON.stringify(inputs.map((input) => ({
    articleId: input.articleId,
    mode: input.mode,
    title: input.title,
    authors: input.authors,
    canonicalUrls: input.canonicalUrls,
    sourceIds: input.sourceIds,
    createdAt: input.createdAt,
    contentHash: input.contentHash,
    tags: input.tags ?? [],
    status: input.status ?? null,
  }))));
}

function searchIndexHash(index: Omit<FullTextSearchIndex, 'indexHash'>): Sha256Digest {
  return versionedSha256(JSON.stringify(index));
}

export function createFullTextSearchIndex(inputs: readonly FullTextSearchDocumentInput[]): FullTextSearchIndex {
  const documents = inputs.map(searchDocument);
  const totalLength = documents.reduce((total, document) => total + document.documentLength, 0);
  const index = {
    schemaVersion: 1 as const,
    algorithm: FULL_TEXT_SEARCH_ALGORITHM as typeof FULL_TEXT_SEARCH_ALGORITHM,
    corpusHash: fullTextCorpusHash(inputs),
    documentCount: documents.length,
    averageDocumentLength: documents.length ? totalLength / documents.length : 0,
    documents,
  };
  return { ...index, indexHash: searchIndexHash(index) };
}

export function verifyFullTextSearchIndexHash(index: FullTextSearchIndex): boolean {
  const { indexHash, ...content } = index;
  return searchIndexHash(content) === indexHash;
}

function optionalEqual<T>(filter: T | undefined, value: T): boolean {
  return filter === undefined ? true : value === filter;
}

function optionalMinimum(filter: string | undefined, value: string): boolean {
  return filter === undefined ? true : value >= filter;
}

function optionalMaximum(filter: string | undefined, value: string): boolean {
  return filter === undefined ? true : value <= filter;
}

function optionalMember(filter: string | undefined, values: readonly string[]): boolean {
  return filter === undefined ? true : values.includes(filter);
}

function optionalText(filter: string | undefined, values: readonly string[]): boolean {
  return filter === undefined ? true : values.some((value) => normalizedTerm(value).includes(normalizedTerm(filter)));
}

function optionalNormalizedMember(filter: string | undefined, values: readonly string[]): boolean {
  return filter === undefined
    ? true
    : values.some((value) => normalizedTerm(value) === normalizedTerm(filter));
}

function matchesFilters(document: FullTextSearchDocument, filters: FullTextSearchFilters): boolean {
  return [
    optionalEqual(filters.mode, document.mode),
    optionalMinimum(filters.from, document.createdAt),
    optionalMaximum(filters.to, document.createdAt),
    optionalText(filters.author, document.authors),
    optionalMember(filters.sourceId, document.sourceIds),
    optionalNormalizedMember(filters.tag, document.tags ?? []),
    optionalNormalizedMember(filters.status, document.status ? [document.status] : []),
  ].every(Boolean);
}

export function scoreFullTextIndex(
  index: FullTextSearchIndex,
  query: string,
  filters: FullTextSearchFilters = {},
): ScoredSearchDocument[] {
  if ([...query].length > 1_000) throw new Error('Full-text search query must not exceed 1000 characters');
  const terms = [...new Set(lexicalTerms(query))];
  if (terms.length === 0) throw new Error('Full-text search query must contain a letter or number');
  const candidates = index.documents.filter((document) => matchesFilters(document, filters));
  const frequencies = candidates.map((document) => new Map(document.termFrequencies));
  const averageLength = candidates.length
    ? candidates.reduce((total, document) => total + document.documentLength, 0) / candidates.length
    : 0;
  const documentFrequencies = new Map(terms.map((term) => [
    term,
    frequencies.reduce((count, frequency) => count + (frequency.has(term) ? 1 : 0), 0),
  ]));
  const k1 = 1.2;
  const b = 0.75;
  const scored = candidates.map((document, documentIndex) => {
    const documentTerms = frequencies[documentIndex]!;
    const score = terms.reduce((total, term) => {
      const termFrequency = documentTerms.get(term) ?? 0;
      if (!termFrequency) return total;
      const documentFrequency = documentFrequencies.get(term)!;
      const inverseDocumentFrequency = Math.log(1 + ((candidates.length - documentFrequency + 0.5) / (documentFrequency + 0.5)));
      const normalization = termFrequency + k1 * (1 - b + b * (document.documentLength / (averageLength || 1)));
      return total + inverseDocumentFrequency * ((termFrequency * (k1 + 1)) / normalization);
    }, 0);
    return { document, score };
  });
  return scored
    .filter(({ score }) => score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      right.document.createdAt.localeCompare(left.document.createdAt) ||
      left.document.articleId.localeCompare(right.document.articleId));
}

export function searchFullTextIndex(
  index: FullTextSearchIndex,
  query: string,
  filters: FullTextSearchFilters = {},
  limit = 20,
): ScoredSearchDocument[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Search limit must be from 1 to 100');
  return scoreFullTextIndex(index, query, filters).slice(0, limit);
}

function stableBlockId(raw: string, occurrences: Map<string, number>): string {
  const digest = versionedSha256(raw).slice('sha256:'.length, 'sha256:'.length + 16);
  const occurrence = (occurrences.get(digest) ?? 0) + 1;
  occurrences.set(digest, occurrence);
  return `b_${digest}_${occurrence}`;
}

export function createArticleSearchBlocks(markdown: string): FullTextSearchBlock[] {
  const blocks: FullTextSearchBlock[] = [];
  const occurrences = new Map<string, number>();
  let characterOffset = 0;
  let byteOffset = 0;
  for (const token of marked.lexer(markdown)) {
    if (markdown.slice(characterOffset, characterOffset + token.raw.length) !== token.raw) {
      throw new Error('Generated article search blocks do not resolve to exact content');
    }
    const startByte = byteOffset;
    characterOffset += token.raw.length;
    byteOffset += Buffer.byteLength(token.raw);
    if (token.type === 'space') continue;
    blocks.push({
      locator: stableBlockId(token.raw, occurrences),
      startByte,
      endByte: byteOffset,
      textHash: versionedSha256(token.raw),
    });
  }
  if (characterOffset !== markdown.length || byteOffset !== Buffer.byteLength(markdown)) {
    throw new Error('Generated article search blocks do not cover exact content');
  }
  return blocks;
}
