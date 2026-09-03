import type { Sha256Digest } from './domain.ts';
import {
  indexedSourceText,
  type IndexedSourceHeading,
  type IndexedSourceParagraph,
  type IndexedSourceRange,
  type SourceContentIndex,
} from './source-index.ts';

export type SourceBlockKind = 'heading' | 'paragraph';

export interface SourceBlockLocator {
  locator: string;
  kind: SourceBlockKind;
  startByte: number;
  endByte: number;
  textHash: Sha256Digest;
}

export interface SourceOutlineHeading extends SourceBlockLocator {
  kind: 'heading';
  level: number;
  text: string;
  parentHeadingLocator?: string;
  paragraphLocators: string[];
}

export interface SourceOutline {
  sourceId: string;
  sourceContentHash: Sha256Digest;
  byteLength: number;
  preambleParagraphLocators: string[];
  headings: SourceOutlineHeading[];
}

export interface SourceRangeRead {
  sourceId: string;
  startLocator: string;
  endLocator: string;
  includedLocators: SourceBlockLocator[];
  startByte: number;
  endByte: number;
  text: string;
}

export interface SourceSearchMatch extends SourceBlockLocator {
  excerpt: string;
  excerptStartsAtBlockStart: boolean;
  excerptEndsAtBlockEnd: boolean;
}

function blockLocator(range: IndexedSourceRange, kind: SourceBlockKind): SourceBlockLocator {
  return {
    locator: range.id,
    kind,
    startByte: range.startByte,
    endByte: range.endByte,
    textHash: range.textHash,
  };
}

function orderedBlocks(index: SourceContentIndex): Array<{
  range: IndexedSourceHeading | IndexedSourceParagraph;
  kind: SourceBlockKind;
}> {
  return [
    ...index.headings.map((range) => ({ range, kind: 'heading' as const })),
    ...index.paragraphs.map((range) => ({ range, kind: 'paragraph' as const })),
  ].sort((left, right) => left.range.startByte - right.range.startByte);
}

export function sourceOutline(index: SourceContentIndex): SourceOutline {
  const paragraphsByHeading = new Map<string, string[]>();
  const preambleParagraphLocators: string[] = [];
  for (const paragraph of index.paragraphs) {
    if (!paragraph.headingId) {
      preambleParagraphLocators.push(paragraph.id);
      continue;
    }
    const locators = paragraphsByHeading.get(paragraph.headingId) ?? [];
    locators.push(paragraph.id);
    paragraphsByHeading.set(paragraph.headingId, locators);
  }
  return {
    sourceId: index.sourceId,
    sourceContentHash: index.sourceContentHash,
    byteLength: index.byteLength,
    preambleParagraphLocators,
    headings: index.headings.map((heading) => ({
      ...blockLocator(heading, 'heading'),
      kind: 'heading',
      level: heading.level,
      text: heading.text,
      ...(heading.parentHeadingId ? { parentHeadingLocator: heading.parentHeadingId } : {}),
      paragraphLocators: paragraphsByHeading.get(heading.id) ?? [],
    })),
  };
}

export function readSourceRange(
  index: SourceContentIndex,
  markdown: string,
  startLocator: string,
  endLocator = startLocator,
  fromByte?: number,
): SourceRangeRead {
  const blocks = orderedBlocks(index);
  const startIndex = blocks.findIndex(({ range }) => range.id === startLocator);
  const endIndex = blocks.findIndex(({ range }) => range.id === endLocator);
  if (startIndex < 0) throw new Error(`Unknown source locator: ${startLocator}`);
  if (endIndex < 0) throw new Error(`Unknown source locator: ${endLocator}`);
  if (endIndex < startIndex) throw new Error('endLocator must not precede startLocator');

  const selected = blocks.slice(startIndex, endIndex + 1);
  for (const { range } of selected) indexedSourceText(markdown, range);
  const rangeStartByte = selected[0]!.range.startByte;
  const endByte = selected.at(-1)!.range.endByte;
  const startByte = fromByte ?? rangeStartByte;
  if (!Number.isSafeInteger(startByte) || startByte < rangeStartByte || startByte >= endByte) {
    throw new Error(`startByte must be an integer from ${rangeStartByte} to ${endByte - 1}`);
  }
  const sourceBytes = Buffer.from(markdown);
  const selectedBytes = sourceBytes.subarray(startByte, endByte);
  const text = selectedBytes.toString('utf8');
  if (!Buffer.from(text).equals(selectedBytes)) throw new Error('startByte must be on a UTF-8 character boundary');
  return {
    sourceId: index.sourceId,
    startLocator,
    endLocator,
    includedLocators: selected
      .filter(({ range }) => range.endByte > startByte)
      .map(({ range, kind }) => blockLocator(range, kind)),
    startByte,
    endByte,
    text,
  };
}

function caseInsensitiveLiteralMatch(text: string, query: string): { index: number; length: number } | undefined {
  const originalStarts = new Map<number, number>();
  const originalEnds = new Map<number, number>();
  let foldedText = '';
  let originalOffset = 0;
  for (const character of text) {
    originalStarts.set(foldedText.length, originalOffset);
    foldedText += character.toLocaleLowerCase('en-US');
    originalOffset += character.length;
    originalEnds.set(foldedText.length, originalOffset);
  }
  const foldedQuery = query.toLocaleLowerCase('en-US');
  let foldedMatch = foldedText.indexOf(foldedQuery);
  while (foldedMatch >= 0) {
    const start = originalStarts.get(foldedMatch);
    const end = originalEnds.get(foldedMatch + foldedQuery.length);
    if (start !== undefined && end !== undefined) return { index: start, length: end - start };
    foldedMatch = foldedText.indexOf(foldedQuery, foldedMatch + 1);
  }
  return undefined;
}

function exactExcerpt(
  text: string,
  matchStart: number,
  matchLength: number,
  contextCharacters: number,
): Pick<SourceSearchMatch, 'excerpt' | 'excerptStartsAtBlockStart' | 'excerptEndsAtBlockEnd'> {
  const before = [...text.slice(0, matchStart)];
  const match = text.slice(matchStart, matchStart + matchLength);
  const after = [...text.slice(matchStart + matchLength)];
  const excerptStartsAtBlockStart = before.length <= contextCharacters;
  const excerptEndsAtBlockEnd = after.length <= contextCharacters;
  return {
    excerpt: `${before.slice(-contextCharacters).join('')}${match}${after.slice(0, contextCharacters).join('')}`,
    excerptStartsAtBlockStart,
    excerptEndsAtBlockEnd,
  };
}

export function searchSourceText(
  index: SourceContentIndex,
  markdown: string,
  query: string,
  options: { limit?: number; contextCharacters?: number } = {},
): SourceSearchMatch[] {
  const needle = query.trim();
  if (!needle) throw new Error('Source search query is required');
  if ([...needle].length > 1_000) throw new Error('Source search query must not exceed 1000 characters');
  const limit = options.limit ?? 20;
  const contextCharacters = options.contextCharacters ?? 160;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('Source search limit must be an integer from 1 to 50');
  }
  if (!Number.isSafeInteger(contextCharacters) || contextCharacters < 0 || contextCharacters > 2_000) {
    throw new Error('Source search context must be an integer from 0 to 2000 characters');
  }

  const matches: SourceSearchMatch[] = [];
  for (const { range, kind } of orderedBlocks(index)) {
    const text = indexedSourceText(markdown, range);
    const match = caseInsensitiveLiteralMatch(text, needle);
    if (!match) continue;
    matches.push({
      ...blockLocator(range, kind),
      ...exactExcerpt(text, match.index, match.length, contextCharacters),
    });
    if (matches.length === limit) break;
  }
  return matches;
}
