import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LibraryService } from '../src/application/library-service.ts';
import type { RecordIdPrefix } from '../src/core/library.ts';

function deterministicIds(): (prefix: RecordIdPrefix) => string {
  const counts: Record<RecordIdPrefix, number> = { src: 0, art: 0, cite: 0, exp: 0 };
  return (prefix) => `${prefix}_${prefix[0].repeat(15)}${(++counts[prefix]).toString(36)}`;
}

function monotonicNow(): () => Date {
  let seconds = 0;
  return () => new Date(Date.UTC(2026, 8, 3, 0, 0, seconds++));
}

async function immutableBytes(capture: Awaited<ReturnType<LibraryService['capture']>>): Promise<Buffer[]> {
  return Promise.all([
    readFile(capture.sourceManifestPath),
    readFile(capture.sourceContentPath),
    readFile(capture.articleManifestPath),
    readFile(capture.articleContentPath),
  ]);
}

test('exact duplicate capture deterministically reuses records unless recapture is explicit', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-duplicate-capture-'));
  const library = new LibraryService({ libraryDir, createId: deterministicIds(), now: monotonicNow() });
  try {
    const input = { kind: 'markdown' as const, label: 'Duplicate fixture', markdown: '# Same\n\nImmutable body.' };
    const first = await library.capture(input);
    const before = await immutableBytes(first);
    const duplicate = await library.capture({ ...input, label: 'Ignored duplicate title' });

    assert.equal(first.status, 'captured');
    assert.equal(first.persisted, true);
    assert.equal(duplicate.status, 'exact-duplicate');
    assert.equal(duplicate.persisted, false);
    assert.equal(duplicate.match?.matchedBy, 'content-hash');
    assert.equal(duplicate.source.id, first.source.id);
    assert.equal(duplicate.archiveArticle.id, first.archiveArticle.id);
    assert.deepEqual(await immutableBytes(first), before);
    assert.equal((await library.listArticles()).length, 1);

    const recaptured = await library.capture(input, {}, undefined, { recapture: true });
    assert.equal(recaptured.status, 'recaptured');
    assert.equal(recaptured.persisted, true);
    assert.notEqual(recaptured.source.id, first.source.id);
    assert.notEqual(recaptured.archiveArticle.id, first.archiveArticle.id);
    assert.deepEqual(recaptured.source.lineage, {
      predecessorSourceId: first.source.id,
      rootSourceId: first.source.id,
      reason: 'explicit-duplicate',
      matchedBy: 'content-hash',
    });
    assert.equal(recaptured.archiveArticle.supersedesArticleId, first.archiveArticle.id);
    assert.deepEqual(await immutableBytes(first), before);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('canonical URL content changes require explicit immutable recapture with source/article lineage', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-changed-capture-'));
  const library = new LibraryService({ libraryDir, createId: deterministicIds(), now: monotonicNow() });
  const fixtureHtml = await readFile(new URL('./fixtures/article.html', import.meta.url), 'utf8');
  const changedHtml = fixtureHtml.replace(
    'Another sufficiently descriptive paragraph confirms that headings, links, code, and prose survive deterministic cleanup without any model-authored rewriting of the source material.',
    'A changed but still sufficiently descriptive paragraph proves that a canonical source can publish new immutable content without altering its previously captured version.',
  );
  const input = { kind: 'url' as const, url: 'https://example.test/input?utm_source=first' };
  try {
    const first = await library.capture(input, { url: { fetchHtml: async () => fixtureHtml } });
    const before = await immutableBytes(first);
    const changed = await library.capture(
      { ...input, url: 'https://example.test/another-entry?utm_source=second' },
      { url: { fetchHtml: async () => changedHtml } },
    );

    assert.equal(changed.status, 'changed-content');
    assert.equal(changed.persisted, false);
    assert.equal(changed.source.id, first.source.id);
    assert.equal(changed.match?.matchedBy, 'canonical-url');
    assert.equal(changed.match?.canonicalUrl, 'https://example.test/writing/core-library?keep=yes');
    assert.notEqual(changed.match?.incomingContentHash, first.source.content.contentHash);
    assert.equal((await library.listArticles()).length, 1);
    assert.deepEqual(await immutableBytes(first), before);

    const recaptured = await library.capture(
      input,
      { url: { fetchHtml: async () => changedHtml } },
      undefined,
      { recapture: true },
    );
    assert.equal(recaptured.status, 'recaptured');
    assert.deepEqual(recaptured.source.lineage, {
      predecessorSourceId: first.source.id,
      rootSourceId: first.source.id,
      reason: 'content-changed',
      matchedBy: 'canonical-url',
    });
    assert.equal(recaptured.archiveArticle.supersedesArticleId, first.archiveArticle.id);
    assert.equal(recaptured.match?.existingSourceId, first.source.id);
    assert.equal(recaptured.match?.existingArchiveArticleId, first.archiveArticle.id);
    assert.deepEqual(await immutableBytes(first), before);

    const currentDuplicate = await library.capture(input, { url: { fetchHtml: async () => changedHtml } });
    assert.equal(currentDuplicate.status, 'exact-duplicate');
    assert.equal(currentDuplicate.source.id, recaptured.source.id);
    assert.equal(currentDuplicate.match?.matchedBy, 'canonical-url');
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('concurrent identical captures create only one source/archive pair', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-concurrent-duplicate-'));
  const library = new LibraryService({ libraryDir, createId: deterministicIds(), now: monotonicNow() });
  try {
    const input = { kind: 'text' as const, label: 'Concurrent', text: 'One immutable input.' };
    const results = await Promise.all([library.capture(input), library.capture(input)]);
    assert.deepEqual(results.map(({ status }) => status).sort(), ['captured', 'exact-duplicate']);
    assert.equal(new Set(results.map(({ source }) => source.id)).size, 1);
    assert.equal(new Set(results.map(({ archiveArticle }) => archiveArticle.id)).size, 1);
    assert.equal((await library.listArticles()).length, 1);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});
