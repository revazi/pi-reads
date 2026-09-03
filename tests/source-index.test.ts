import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LibraryService } from '../src/application/library-service.ts';
import type { SourceRecord } from '../src/core/domain.ts';
import { analyzeMarkdown } from '../src/core/ingest/text.ts';
import { sourceContentPath, type RecordIdPrefix } from '../src/core/library.ts';
import {
  createSourceContentIndex,
  indexedSourceText,
  verifySourceContentIndex,
  type SourceContentIndex,
} from '../src/core/source-index.ts';

function deterministicIds(): (prefix: RecordIdPrefix) => string {
  const counts: Record<RecordIdPrefix, number> = { src: 0, art: 0, cite: 0, exp: 0 };
  return (prefix) => {
    counts[prefix] += 1;
    return `${prefix}_${prefix[0].repeat(15)}${counts[prefix].toString(36)}`;
  };
}

function sourceFixture(markdown: string): SourceRecord {
  const analysis = analyzeMarkdown(markdown);
  const id = 'src_sssssssssssssss1';
  return {
    schemaVersion: 1,
    id,
    kind: 'markdown',
    title: 'Structure fixture',
    capturedAt: '2026-09-03T00:00:00.000Z',
    origin: { locator: 'fixture' },
    content: {
      path: sourceContentPath(id),
      mediaType: 'text/markdown',
      contentHash: analysis.contentHash,
      textHash: analysis.textHash,
      byteLength: Buffer.byteLength(markdown),
    },
    capture: { adapter: 'fixture' },
  };
}

const markdown = [
  '# Résumé preparation',
  '',
  'First café paragraph with Unicode.',
  '',
  '## Python',
  '',
  'Use generators for bounded iteration.',
  '',
  '### Details',
  '',
  '- Preserve exact bytes.',
  '- Keep stable locators.',
  '',
  '## Python',
  '',
  'Use generators for bounded iteration.',
  '',
].join('\n');

test('source structure indexes are deterministic and every range resolves to exact UTF-8 source text', () => {
  const source = sourceFixture(markdown);
  const first = createSourceContentIndex(source, markdown);
  const second = createSourceContentIndex(source, markdown);
  assert.deepEqual(first, second);
  assert.equal(first.sourceContentHash, source.content.contentHash);
  assert.equal(first.sourceTextHash, source.content.textHash);
  assert.equal(first.byteLength, Buffer.byteLength(markdown));
  assert.equal(first.headings.length, 4);
  assert.equal(first.paragraphs.length, 4);
  assert.equal(new Set(first.headings.map((heading) => heading.id)).size, first.headings.length);
  assert.equal(new Set(first.paragraphs.map((paragraph) => paragraph.id)).size, first.paragraphs.length);
  assert.equal(first.headings[1].parentHeadingId, first.headings[0].id);
  assert.equal(first.headings[2].parentHeadingId, first.headings[1].id);
  assert.equal(first.paragraphs[1].headingId, first.headings[1].id);

  const bytes = Buffer.from(markdown);
  for (const range of [...first.headings, ...first.paragraphs]) {
    const expected = bytes.subarray(range.startByte, range.endByte).toString('utf8');
    assert.equal(indexedSourceText(markdown, range), expected);
    assert.ok(range.characterCount > 0);
    assert.ok(range.approximateTokenCount > 0);
  }
  assert.doesNotThrow(() => verifySourceContentIndex(source, markdown, first));
});

test('source structure index integrity fails closed for changed source bytes or index metadata', () => {
  const source = sourceFixture(markdown);
  const index = createSourceContentIndex(source, markdown);
  assert.throws(
    () => createSourceContentIndex(source, `${markdown}changed`),
    /content hash does not match/u,
  );

  const tampered = structuredClone(index);
  tampered.paragraphs[0].endByte += 1;
  assert.throws(
    () => verifySourceContentIndex(source, markdown, tampered),
    /deterministic integrity verification/u,
  );

  const invalidRange = { ...index.paragraphs[0], startByte: -1 };
  assert.throws(() => indexedSourceText(markdown, invalidRange), /Invalid indexed source byte range/u);
});

test('existing sources can rebuild deterministic indexes without rewriting source or archive prose', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-source-index-'));
  const library = new LibraryService({ libraryDir, createId: deterministicIds() });
  try {
    const capture = await library.capture({ kind: 'markdown', label: 'Existing source', markdown });
    const originalIndexBytes = await readFile(capture.sourceIndexPath, 'utf8');
    const sourceBytes = await readFile(capture.sourceContentPath);
    const archiveBytes = await readFile(capture.articleContentPath);
    const sourceManifestBytes = await readFile(capture.sourceManifestPath);
    const archiveManifestBytes = await readFile(capture.articleManifestPath);

    await rm(capture.sourceIndexPath);
    await assert.rejects(
      () => library.loadSourceIndex(capture.source.id),
      /Could not read source content index/u,
    );
    const rebuilt = await library.rebuildSourceIndex(capture.source.id);
    assert.equal(rebuilt.indexPath, capture.sourceIndexPath);
    assert.equal(await readFile(capture.sourceIndexPath, 'utf8'), originalIndexBytes);
    assert.deepEqual(await readFile(capture.sourceContentPath), sourceBytes);
    assert.deepEqual(await readFile(capture.articleContentPath), archiveBytes);
    assert.deepEqual(await readFile(capture.sourceManifestPath), sourceManifestBytes);
    assert.deepEqual(await readFile(capture.articleManifestPath), archiveManifestBytes);

    await writeFile(capture.sourceIndexPath, '{ tampered');
    await assert.rejects(() => library.loadSourceIndex(capture.source.id), /deterministic integrity|Could not read/u);
    await library.rebuildSourceIndex(capture.source.id);
    const loaded = await library.loadSourceIndex(capture.source.id);
    assert.equal(loaded.index.sourceId, capture.source.id);
    assert.equal(await readFile(capture.sourceIndexPath, 'utf8'), originalIndexBytes);
    assert.deepEqual(
      (await readdir(path.dirname(capture.sourceIndexPath))).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('source index JSON shape remains serializable without generated timestamps', () => {
  const index: SourceContentIndex = createSourceContentIndex(sourceFixture(markdown), markdown);
  const serialized = JSON.stringify(index);
  assert.doesNotMatch(serialized, /generatedAt|indexedAt/u);
  assert.deepEqual(JSON.parse(serialized), index);
});
