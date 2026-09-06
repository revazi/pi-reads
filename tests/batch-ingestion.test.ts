import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { BatchIngestionService, MAX_BATCH_ITEMS, MAX_BATCH_INPUT_BYTES, MAX_BATCH_ITEM_BYTES } from '../src/application/batch-ingestion-service.ts';
import { LibraryService } from '../src/application/library-service.ts';
import { LibraryIndexStore, type LibraryIndex, type LibraryIndexTransactionResult } from '../src/core/library-index.ts';
import { CaptureRecoveryError, ImmutableRecordGroup } from '../src/core/record-group.ts';
import type { RecordIdPrefix } from '../src/core/library.ts';
import type { SourceInput } from '../src/core/ingest/index.ts';

function ids(): (prefix: RecordIdPrefix) => string {
  let count = 0;
  return (prefix) => `${prefix}_${(++count).toString(36).padStart(64, '0')}`;
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = new LibraryService({ libraryDir: root, createId: ids() });
  return { root, library, batch: new BatchIngestionService(library) };
}
async function recordNames(root: string, relative: string): Promise<string[]> {
  return readdir(path.join(root, relative)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
}
async function assertNoRecords(root: string): Promise<void> {
  assert.deepEqual(await recordNames(root, 'sources'), []);
  assert.deepEqual(await recordNames(root, 'articles/archive'), []);
  assert.deepEqual(await recordNames(root, 'indexes/sources'), []);
}

test('mixed batches retain complete successful records and bounded ordered failures without exposing input data', async (t) => {
  const { root, library, batch } = await fixture(t);
  const filename = path.join(root, 'input.md'); await writeFile(filename, '# Local file\n\nLocal file evidence.');
  const inputs: SourceInput[] = [
    { kind: 'text', text: 'First source evidence.' },
    { kind: 'markdown', markdown: '# Other source\n\nIndependent evidence.' },
    { kind: 'file', path: filename },
    { kind: 'file', path: path.join(root, 'private-missing-file.txt') },
    { kind: 'text', text: 'First source evidence.' },
    { kind: 'markdown', markdown: '<script>private-unsafe-prose</script>' },
    { kind: 'text', text: '' },
  ];
  const result = await batch.capture(inputs);
  assert.deepEqual(result.counts, { captured: 3, 'exact-duplicate': 1, 'changed-content': 0, failed: 3, cancelled: 0 });
  assert.deepEqual(result.outcomes.map(({ index }) => index), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(result.outcomes[3]!.status, 'failed');
  assert.doesNotMatch(JSON.stringify(result), /private-|First source evidence|Other source|Local file evidence/u);
  assert.equal((await library.listSources()).length, 3);
  assert.equal((await library.listArticles()).length, 3);
  for (const outcome of result.outcomes) {
    if (!('sourceId' in outcome)) continue;
    const source = await library.loadSource(outcome.sourceId);
    const article = await library.loadArticle(outcome.archiveArticleId);
    assert.equal(source.content, article.content);
    assert.equal(source.source.content.textHash, article.article.body.textHash);
    assert.equal(outcome.sourceContentPath, source.source.content.path);
    await library.loadSourceIndex(outcome.sourceId);
  }
});

test('default batch URL acquisition retains private-network and credential rejection before fetch', async (t) => {
  const { root, batch } = await fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network access'); });
  const result = await batch.capture([
    { kind: 'url', url: 'https://private:secret@127.0.0.1/input' },
    { kind: 'url', url: 'http://127.0.0.1/input' },
    { kind: 'url', url: 'file:///private-source.md' },
  ]);
  assert.equal(result.counts.failed, 3);
  assert.equal(fetch.mock.callCount(), 0);
  assert.doesNotMatch(JSON.stringify(result), /private:secret|127\.0\.0\.1/u);
  await assertNoRecords(root);
});

test('independent URL acquisition uses bounded concurrency while duplicate publication stays serialized', async (t) => {
  const { library } = await fixture(t);
  const html = await readFile(new URL('./fixtures/article.html', import.meta.url), 'utf8');
  const wave = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let active = 0; let maximum = 0; let started = 0;
  const batch = new BatchIngestionService(library, { url: { fetchHtml: async () => {
    active++; started++; maximum = Math.max(maximum, active);
    if (started === 2) wave.resolve();
    await release.promise;
    active--;
    return html;
  } } });
  const task = batch.capture(Array.from({ length: 5 }, (_, index) => ({ kind: 'url', url: `https://example.test/${index}` })), { concurrency: 2 });
  await wave.promise;
  assert.equal(started, 2); release.resolve();
  const result = await task;
  assert.equal(maximum, 2); assert.equal(active, 0);
  assert.equal(result.counts.captured, 1); assert.equal(result.counts['exact-duplicate'], 4);
  assert.equal((await library.listSources()).length, 1);
});

test('changed canonical content is reported without recapture, and independent network failures do not roll back successes', async (t) => {
  const { library } = await fixture(t);
  const html = await readFile(new URL('./fixtures/article.html', import.meta.url), 'utf8');
  const source = await library.capture({ kind: 'url', url: 'https://example.test/original' }, { url: { fetchHtml: async () => html } });
  const before = await readFile(source.sourceContentPath);
  const changed = html.replace('Another sufficiently descriptive paragraph', 'A newly changed sufficiently descriptive paragraph');
  const batch = new BatchIngestionService(library, { url: { fetchHtml: async (url) => {
    if (url.endsWith('/fail')) throw new Error('private-url-token-error');
    return changed;
  } } });
  const result = await batch.capture([
    { kind: 'url', url: 'https://example.test/changed' },
    { kind: 'url', url: 'https://example.test/fail' },
    { kind: 'text', text: 'Independent successful item.' },
  ]);
  assert.equal(result.outcomes[0]!.status, 'changed-content');
  assert.equal(result.outcomes[1]!.status, 'failed');
  assert.equal(result.outcomes[2]!.status, 'captured');
  assert.equal((await library.listSources()).length, 2);
  assert.deepEqual(await readFile(source.sourceContentPath), before);
  assert.doesNotMatch(JSON.stringify(result), /private-url-token-error/u);
});

test('cancellation aborts all in-flight fetches, does not start pending inputs, and reports every item', async (t) => {
  const { root, library } = await fixture(t);
  const controller = new AbortController();
  const wave = Promise.withResolvers<void>();
  let started = 0; let aborted = 0; let active = 0;
  const batch = new BatchIngestionService(library, { url: { fetchHtml: async (_url, signal) => {
    started++; active++;
    return new Promise<string>((_resolve, reject) => {
      signal!.addEventListener('abort', () => { aborted++; active--; reject(signal!.reason); }, { once: true });
      if (started === 3) wave.resolve();
    });
  } } });
  const inputs: SourceInput[] = Array.from({ length: 12 }, (_, index) => ({ kind: 'url', url: `https://example.test/${index}` }));
  const task = batch.capture(inputs, { signal: controller.signal, concurrency: 3 });
  await wave.promise; controller.abort();
  const result = await task;
  assert.equal(started, 3); assert.equal(aborted, 3); assert.equal(active, 0);
  assert.equal(result.counts.cancelled, 12);
  await assertNoRecords(root);
  const alreadyAborted = await batch.capture(inputs, { signal: controller.signal });
  assert.equal(alreadyAborted.counts.cancelled, 12); assert.equal(started, 3);
});

test('cancellation retains completed items while cancelling pending acquisition', async (t) => {
  const { library } = await fixture(t);
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const batch = new BatchIngestionService(library, { url: { fetchHtml: async (_url, signal) => new Promise<string>((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    entered.resolve();
  }) } });
  const pending = batch.capture([
    { kind: 'text', text: 'Retain the completed item.' },
    { kind: 'url', url: 'https://example.test/blocked' },
    { kind: 'text', text: 'Do not capture the pending item.' },
  ], { concurrency: 1, signal: controller.signal });
  await entered.promise; controller.abort();
  const result = await pending;
  assert.deepEqual(result.outcomes.map(({ status }) => status), ['captured', 'cancelled', 'cancelled']);
  assert.equal((await library.listSources()).length, 1);
  assert.equal((await library.listArticles()).length, 1);
});

test('cancellation while queued for publication creates no pair; cancellation during commit retains an honest success', async (t) => {
  const { root, library } = await fixture(t);
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const index = new LibraryIndexStore(root);
  const held = index.transaction(async (current) => {
    entered.resolve(); await release.promise;
    return { value: undefined, sources: current.sources, articles: current.articles };
  });
  await entered.promise;
  const queued = Promise.withResolvers<void>();
  const original = LibraryIndexStore.prototype.transaction;
  const intercepted = t.mock.method(LibraryIndexStore.prototype, 'transaction', function<T>(
    this: LibraryIndexStore, operation: (index: LibraryIndex) => Promise<LibraryIndexTransactionResult<T>>,
  ): Promise<T> {
    const task = original.call(this, operation) as Promise<T>;
    queued.resolve();
    return task;
  });
  const task = new BatchIngestionService(library).capture([{ kind: 'text', text: 'Queued capture.' }], { signal: controller.signal });
  await queued.promise; controller.abort(); release.resolve(); await held;
  intercepted.mock.restore();
  assert.equal((await task).counts.cancelled, 1);
  await assertNoRecords(root);

  const lateAbort = new AbortController(); let clocks = 0;
  const otherRoot = path.join(root, 'late-abort');
  const lateLibrary = new LibraryService({ libraryDir: otherRoot, now: () => {
    if (++clocks === 4) lateAbort.abort();
    return new Date('2026-09-04T00:00:00.000Z');
  } });
  const completed = await new BatchIngestionService(lateLibrary).capture([{ kind: 'text', text: 'Commit survives cancellation.' }], { signal: lateAbort.signal });
  assert.equal(lateAbort.signal.aborted, true);
  assert.equal(completed.counts.captured, 1);
  assert.equal((await lateLibrary.listArticles()).length, 1);
});

test('capture compensates source/archive/index publication and catalog failures without deleting collisions', async (t) => {
  const { root } = await fixture(t);
  const sourceId = `src_${'a'.repeat(16)}`; const articleId = `art_${'a'.repeat(16)}`;
  const collision = path.join(root, `indexes/sources/${sourceId}`);
  await mkdir(collision, { recursive: true }); await writeFile(path.join(collision, 'sentinel'), 'keep');
  const library = new LibraryService({ libraryDir: root, createId: (prefix) => prefix === 'src' ? sourceId : articleId });
  const result = await new BatchIngestionService(library).capture([{ kind: 'text', text: 'Must roll back both records.' }]);
  assert.equal(result.counts.failed, 1);
  assert.deepEqual(await recordNames(root, 'sources'), []);
  assert.deepEqual(await recordNames(root, 'articles/archive'), []);
  assert.equal(await readFile(path.join(collision, 'sentinel'), 'utf8'), 'keep');
  assert.equal((await library.listSources()).length, 0);
  await rm(collision, { recursive: true });

  let clocks = 0;
  const broken = new LibraryService({ libraryDir: path.join(root, 'broken-index'), now: () => {
    if (++clocks === 4) throw new Error('Injected catalog publish failure');
    return new Date('2026-09-04T00:00:00.000Z');
  } });
  const failed = await new BatchIngestionService(broken).capture([{ kind: 'text', text: 'Must compensate catalog failure.' }]);
  assert.equal(failed.counts.failed, 1);
  await assertNoRecords(broken.libraryDir);
  assert.equal((await broken.listArticles()).length, 0);
});

test('an uncompleted compensation is explicit and cancels pending items instead of continuing writes', async (t) => {
  const { library, batch } = await fixture(t);
  const capture = t.mock.method(library, 'capture', async () => { throw new CaptureRecoveryError(); });
  const result = await batch.capture([
    { kind: 'text', text: 'Uncertain storage fixture.' }, { kind: 'text', text: 'Pending fixture.' },
  ], { concurrency: 1 });
  assert.deepEqual(result.outcomes, [
    { index: 0, status: 'failed', error: 'recovery-required' },
    { index: 1, status: 'cancelled', error: 'cancelled' },
  ]);
  assert.equal(capture.mock.callCount(), 1);
});

test('50-item results are bounded and oversized requests fail before acquisition or persistence', async (t) => {
  const { root, batch } = await fixture(t);
  await assert.rejects(() => batch.capture(Array.from({ length: 51 }, () => ({ kind: 'text', text: 'x' }))), /1–50/u);
  await assert.rejects(() => batch.capture([{ kind: 'text', text: 'x' }], { concurrency: 5 }), /1 to 4/u);
  await assert.rejects(() => batch.capture(Array.from({ length: MAX_BATCH_INPUT_BYTES / MAX_BATCH_ITEM_BYTES + 1 }, () => ({ kind: 'text', text: 'x'.repeat(MAX_BATCH_ITEM_BYTES) }))), /1 MiB/u);
  await assertNoRecords(root);
  const result = await batch.capture(Array.from({ length: MAX_BATCH_ITEMS }, (_, index) => ({ kind: 'text', text: `Unique fixture ${index}.` })));
  assert.equal(result.counts.captured, 50);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 24 * 1024);
  assert.equal(result.outcomes.length, 50);
});

test('local file ingestion rejects oversized and non-regular inputs without creating partial records', async (t) => {
  const { root, batch } = await fixture(t);
  const oversized = path.join(root, 'large.md'); await writeFile(oversized, ''); await truncate(oversized, 10 * 1024 * 1024 + 1);
  const directory = path.join(root, 'directory.md'); await mkdir(directory);
  const result = await batch.capture([{ kind: 'file', path: oversized }, { kind: 'file', path: directory }]);
  assert.equal(result.counts.failed, 2);
  await assertNoRecords(root);
});

test('record compensation refuses replaced directories and existing empty collisions', async (t) => {
  const { root } = await fixture(t);
  const group = new ImmutableRecordGroup(root);
  await group.create([{ directory: 'sources/new-record', files: [{ path: 'content.md', contents: 'new bytes' }] }]);
  // A file in place of the owned directory must never be removed by compensation.
  await rm(path.join(root, 'sources/new-record'), { recursive: true });
  await writeFile(path.join(root, 'sources/new-record'), 'replacement');
  await assert.rejects(() => group.rollback(), CaptureRecoveryError);
  assert.equal(await readFile(path.join(root, 'sources/new-record'), 'utf8'), 'replacement');
  const empty = path.join(root, 'sources/existing-empty'); await mkdir(empty);
  await assert.rejects(() => new ImmutableRecordGroup(root).create([{ directory: 'sources/existing-empty', files: [{ path: 'x', contents: 'new' }] }]), /already exists/u);
  assert.deepEqual(await readdir(empty), []);
});
