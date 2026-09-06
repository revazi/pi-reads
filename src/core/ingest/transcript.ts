import path from 'node:path';
import { JSDOM } from 'jsdom';
import type { IngestedSourceDraft } from '../domain.ts';
import { normalizeText } from '../text.ts';
import { readBoundedRegularFile } from './filesystem.ts';
import { analyzeMarkdown, plainTextToMarkdown } from './text.ts';

const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;
const MAX_TRANSCRIPT_SEGMENTS = 20_000;
const TIMING = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+(?:(\d{1,3}):)?(\d{2}):(\d{2})[,.](\d{3})(?:\s+.*)?$/u;

export interface TranscriptSegment {
  index: number;
  locator: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface ParsedTranscript {
  format: 'srt' | 'vtt';
  segments: TranscriptSegment[];
  content: string;
}

function milliseconds(hours: string | undefined, minutes: string, seconds: string, millis: string): number {
  const minuteValue = Number(minutes);
  const secondValue = Number(seconds);
  if (minuteValue > 59 || secondValue > 59) throw new Error('Transcript timestamp component is out of range');
  return Number(hours ?? 0) * 3_600_000 + minuteValue * 60_000 + secondValue * 1000 + Number(millis);
}

function timestamp(value: number): string {
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  const millis = value % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function visibleCueText(lines: readonly string[]): string {
  const html = lines.join('\n').replace(/<v(?:\.[^ >]+)*(?:\s+[^>]*)?>/giu, '<span>');
  const document = new JSDOM(`<!doctype html><main>${html}</main>`).window.document;
  for (const unsafe of document.querySelectorAll('script,style,iframe,object,embed')) unsafe.remove();
  return normalizeText(document.querySelector('main')?.textContent ?? '');
}

function blocks(value: string, format: 'srt' | 'vtt'): string[][] {
  const normalized = value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const body = format === 'vtt' ? normalized.replace(/^WEBVTT[^\n]*\n/u, '') : normalized;
  return body.split(/\n{2,}/u).map((block) => block.split('\n')).filter((lines) => {
    const first = lines[0]?.trim() ?? '';
    return first && !/^(NOTE|STYLE|REGION)(?:\s|$)/u.test(first);
  });
}

function segment(lines: readonly string[], index: number): TranscriptSegment | undefined {
  const timingIndex = lines.findIndex((line) => line.includes('-->'));
  if (timingIndex < 0) return undefined;
  const match = TIMING.exec(lines[timingIndex]!.trim());
  if (!match) throw new Error(`Transcript segment ${index + 1} has invalid timestamps`);
  const startMs = milliseconds(match[1], match[2]!, match[3]!, match[4]!);
  const endMs = milliseconds(match[5], match[6]!, match[7]!, match[8]!);
  if (endMs <= startMs) throw new Error(`Transcript segment ${index + 1} must end after it starts`);
  const text = visibleCueText(lines.slice(timingIndex + 1));
  if (!text) return undefined;
  return {
    index,
    locator: `${timestamp(startMs)} --> ${timestamp(endMs)} · segment ${index + 1}`,
    startMs,
    endMs,
    text,
  };
}

export function parseTranscript(value: string, format: 'srt' | 'vtt'): ParsedTranscript {
  const parsed = blocks(value, format).map(segment).filter((item): item is TranscriptSegment => Boolean(item));
  if (parsed.length === 0) throw new Error('Transcript contains no readable timestamped segments');
  if (parsed.length > MAX_TRANSCRIPT_SEGMENTS) throw new Error(`Transcript exceeds ${MAX_TRANSCRIPT_SEGMENTS} segments`);
  const segments = parsed.map((item, index) => ({ ...item, index, locator: `${timestamp(item.startMs)} --> ${timestamp(item.endMs)} · segment ${index + 1}` }));
  const content = ['# Transcript', ...segments.flatMap((item) => [
    `## ${item.locator}`,
    plainTextToMarkdown(item.text),
  ])].join('\n\n');
  return { format, segments, content };
}

export async function ingestTranscriptFile(
  filePath: string,
  cwd = process.cwd(),
  signal?: AbortSignal,
): Promise<IngestedSourceDraft> {
  if (!filePath.trim()) throw new Error('Transcript file path is required');
  const absolutePath = path.resolve(cwd, filePath);
  const extension = path.extname(absolutePath).toLowerCase();
  const format = extension === '.srt' ? 'srt' : extension === '.vtt' ? 'vtt' : undefined;
  if (!format) throw new Error('Transcript input must be a local .srt or .vtt file');
  const bytes = await readBoundedRegularFile(absolutePath, MAX_TRANSCRIPT_BYTES, 'Transcript', signal);
  let raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`Transcript is not valid UTF-8: ${filePath}`); }
  const transcript = parseTranscript(raw, format);
  const analysis = analyzeMarkdown(transcript.content);
  return {
    kind: 'transcript', locator: absolutePath, title: path.basename(absolutePath, extension),
    content: transcript.content, mediaType: 'text/markdown',
    contentHash: analysis.contentHash, textHash: analysis.textHash,
    rawContent: raw, rawMediaType: format === 'srt' ? 'application/x-subrip' : 'text/vtt',
    capture: { adapter: `${format}-transcript`, adapterVersion: '1' },
  };
}
