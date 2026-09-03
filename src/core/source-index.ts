import { marked } from 'marked';
import type { Sha256Digest, SourceRecord } from './domain.ts';
import { versionedSha256 } from './text.ts';

const SOURCE_CONTENT_INDEX_ALGORITHM = 'markdown-blocks-v1';

export interface IndexedSourceRange {
  id: string;
  startByte: number;
  endByte: number;
  textHash: Sha256Digest;
  characterCount: number;
  approximateTokenCount: number;
}

export interface IndexedSourceHeading extends IndexedSourceRange {
  level: number;
  text: string;
  parentHeadingId?: string;
}

export interface IndexedSourceParagraph extends IndexedSourceRange {
  headingId?: string;
}

export interface SourceContentIndex {
  schemaVersion: 1;
  algorithm: typeof SOURCE_CONTENT_INDEX_ALGORITHM;
  sourceId: string;
  sourceContentHash: Sha256Digest;
  sourceTextHash: Sha256Digest;
  byteLength: number;
  characterCount: number;
  approximateTokenCount: number;
  headings: IndexedSourceHeading[];
  paragraphs: IndexedSourceParagraph[];
}

function approximateTokenCount(characterCount: number): number {
  return Math.max(1, Math.ceil(characterCount / 4));
}

function stableRangeId(
  prefix: 'h' | 'p',
  raw: string,
  occurrences: Map<string, number>,
): string {
  const digest = versionedSha256(raw).slice('sha256:'.length, 'sha256:'.length + 16);
  const key = `${prefix}_${digest}`;
  const occurrence = (occurrences.get(key) ?? 0) + 1;
  occurrences.set(key, occurrence);
  return `${key}_${occurrence}`;
}

function indexedRange(
  id: string,
  raw: string,
  startByte: number,
): IndexedSourceRange {
  const characterCount = [...raw].length;
  return {
    id,
    startByte,
    endByte: startByte + Buffer.byteLength(raw),
    textHash: versionedSha256(raw),
    characterCount,
    approximateTokenCount: approximateTokenCount(characterCount),
  };
}

export function createSourceContentIndex(source: SourceRecord, markdown: string): SourceContentIndex {
  const contentHash = versionedSha256(markdown);
  if (contentHash !== source.content.contentHash) {
    throw new Error(`Source ${source.id} content hash does not match its manifest`);
  }
  if (Buffer.byteLength(markdown) !== source.content.byteLength) {
    throw new Error(`Source ${source.id} byte length does not match its manifest`);
  }

  const headings: IndexedSourceHeading[] = [];
  const paragraphs: IndexedSourceParagraph[] = [];
  const headingStack: IndexedSourceHeading[] = [];
  const occurrences = new Map<string, number>();
  let characterOffset = 0;
  let byteOffset = 0;

  for (const token of marked.lexer(markdown)) {
    const raw = token.raw;
    if (markdown.slice(characterOffset, characterOffset + raw.length) !== raw) {
      throw new Error(`Source ${source.id} Markdown tokens do not resolve to exact source bytes`);
    }
    const range = indexedRange(
      stableRangeId(token.type === 'heading' ? 'h' : 'p', raw, occurrences),
      raw,
      byteOffset,
    );
    characterOffset += raw.length;
    byteOffset = range.endByte;

    if (token.type === 'space') continue;
    if (token.type === 'heading') {
      while (headingStack.length && headingStack.at(-1)!.level >= token.depth) headingStack.pop();
      const parentHeadingId = headingStack.at(-1)?.id;
      const heading: IndexedSourceHeading = {
        ...range,
        level: token.depth,
        text: token.text,
        ...(parentHeadingId ? { parentHeadingId } : {}),
      };
      headings.push(heading);
      headingStack.push(heading);
      continue;
    }
    const headingId = headingStack.at(-1)?.id;
    paragraphs.push({ ...range, ...(headingId ? { headingId } : {}) });
  }

  if (characterOffset !== markdown.length || byteOffset !== Buffer.byteLength(markdown)) {
    throw new Error(`Source ${source.id} Markdown index does not cover the complete source`);
  }
  const characterCount = [...markdown].length;
  return {
    schemaVersion: 1,
    algorithm: SOURCE_CONTENT_INDEX_ALGORITHM,
    sourceId: source.id,
    sourceContentHash: source.content.contentHash,
    sourceTextHash: source.content.textHash,
    byteLength: source.content.byteLength,
    characterCount,
    approximateTokenCount: approximateTokenCount(characterCount),
    headings,
    paragraphs,
  };
}

export function indexedSourceText(markdown: string, range: IndexedSourceRange): string {
  if (
    !Number.isSafeInteger(range.startByte) ||
    !Number.isSafeInteger(range.endByte) ||
    range.startByte < 0 ||
    range.endByte <= range.startByte
  ) {
    throw new Error(`Invalid indexed source byte range ${range.id}`);
  }
  const bytes = Buffer.from(markdown);
  if (range.endByte > bytes.byteLength) throw new Error(`Indexed source byte range ${range.id} exceeds source content`);
  const text = bytes.subarray(range.startByte, range.endByte).toString('utf8');
  if (versionedSha256(text) !== range.textHash) {
    throw new Error(`Indexed source byte range ${range.id} failed text hash verification`);
  }
  return text;
}

export function verifySourceContentIndex(
  source: SourceRecord,
  markdown: string,
  index: SourceContentIndex,
): void {
  const expected = createSourceContentIndex(source, markdown);
  if (JSON.stringify(index) !== JSON.stringify(expected)) {
    throw new Error(`Source ${source.id} content index failed deterministic integrity verification`);
  }
  for (const range of [...index.headings, ...index.paragraphs]) indexedSourceText(markdown, range);
}
