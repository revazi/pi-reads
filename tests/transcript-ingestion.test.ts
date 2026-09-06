import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LibraryService } from '../src/application/library-service.ts';
import { verifyCitationGrounding } from '../src/core/citation-grounding.ts';
import { ingestClipboard } from '../src/core/ingest/clipboard.ts';
import { ingestTranscriptFile, parseTranscript } from '../src/core/ingest/transcript.ts';
import { validateRecord } from '../src/core/record-validation.ts';

const srtPath = path.resolve('tests/fixtures/transcript.srt');
const vttPath = path.resolve('tests/fixtures/transcript.vtt');

test('SRT and WebVTT adapters create immutable Markdown with stable timestamp headings', async () => {
  const srt = await ingestTranscriptFile(srtPath);
  assert.equal(srt.kind, 'transcript');
  assert.equal(srt.capture.adapter, 'srt-transcript');
  assert.equal(srt.rawMediaType, 'application/x-subrip');
  assert.deepEqual(Buffer.from(srt.rawContent!), await readFile(srtPath));
  assert.match(srt.content, /## 00:00:01\.250 --> 00:00:04\.500 · segment 1/u);
  assert.match(srt.content, /Second timestamped segment/u);
  assert.doesNotMatch(srt.content, /<v|<i>/u);

  const vtt = await ingestTranscriptFile(vttPath);
  assert.equal(vtt.rawMediaType, 'text/vtt');
  assert.match(vtt.content, /00:00:00\.500 --> 00:00:02\.000 · segment 1/u);
  assert.doesNotMatch(vtt.content, /note is not a cue|color: lime/iu);
  assert.match(vtt.content, /Second WebVTT segment &amp; evidence/u);

  assert.throws(() => parseTranscript('1\n00:00:03,000 --> 00:00:01,000\nBad', 'srt'), /end after it starts/u);
  assert.throws(() => parseTranscript('WEBVTT\n\nNo timing', 'vtt'), /no readable timestamped/u);
  await assert.rejects(() => ingestTranscriptFile(path.resolve('tests/fixtures/article.html')), /local \.srt or \.vtt/u);
});

test('timestamp headings resolve citations to the exact immutable transcript segment', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-transcript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let id = 0;
  const library = new LibraryService({
    libraryDir: path.join(root, 'library'), allowGitWorkingTree: true,
    now: () => new Date('2025-04-05T00:00:00.000Z'),
    createId: (prefix) => `${prefix}_${String(++id).padStart(16, '0')}`,
  });
  const captured = await library.capture({ kind: 'transcript', path: srtPath });
  assert.equal(captured.source.kind, 'transcript');
  await assert.doesNotReject(() => validateRecord('source', captured.source));
  const [stored, indexed] = await Promise.all([
    library.loadSource(captured.source.id),
    library.loadSourceIndex(captured.source.id),
  ]);
  const heading = '00:01:02.000 --> 00:01:05.000 · segment 3';
  const diagnostics = verifyCitationGrounding(
    'Timestamped claim.[^cite_segment]',
    [{ id: 'cite_segment', sourceId: captured.source.id, locator: { heading }, quote: 'Final segment with exact citation evidence' }],
    new Map([[captured.source.id, { source: stored.source, index: indexed.index, content: stored.content }]]),
  );
  assert.equal(diagnostics.locatedCitationCount, 1);
  assert.equal(diagnostics.verifiedQuoteCount, 1);
  await assert.rejects(async () => verifyCitationGrounding(
    'Bad.[^cite_bad]',
    [{ id: 'cite_bad', sourceId: captured.source.id, locator: { heading: '00:09:00.000 --> 00:09:01.000 · segment 9' } }],
    new Map([[captured.source.id, { source: stored.source, index: indexed.index, content: stored.content }]]),
  ), /unknown source heading/u);
});

test('clipboard adapter accepts only caller-provided content and records explicit provenance', () => {
  const text = ingestClipboard('Literal *clipboard* evidence.', 'text', 'Explicit clipboard capture');
  assert.equal(text.kind, 'clipboard');
  assert.equal(text.capture.adapter, 'clipboard-text');
  assert.equal(text.rawContent, 'Literal *clipboard* evidence.');
  assert.match(text.content, /\\\*clipboard\\\*/u);
  const markdown = ingestClipboard('# Clipboard\n\nEvidence.', 'markdown');
  assert.equal(markdown.capture.adapter, 'clipboard-markdown');
  assert.equal(markdown.content, '# Clipboard\n\nEvidence.');
  assert.throws(() => ingestClipboard('  '), /empty text/u);
});
