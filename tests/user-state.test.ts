import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LibraryService } from '../src/application/library-service.ts';
import { UserStateService } from '../src/application/user-state-service.ts';
import type { RecordIdPrefix } from '../src/core/library.ts';

function deterministicIds(): (prefix: RecordIdPrefix) => string {
  const counts: Record<RecordIdPrefix, number> = { src: 0, art: 0, cite: 0, exp: 0 };
  return (prefix) => `${prefix}_${prefix[0].repeat(15)}${(++counts[prefix]).toString(36)}`;
}

async function captureFixture(library: LibraryService, title: string, body: string) {
  return library.capture({ kind: 'markdown', label: title, markdown: `# ${title}\n\n${body}` });
}

test('reading-state updates are atomic, revisioned, and never modify immutable article/source records', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-user-state-'));
  const library = new LibraryService({ libraryDir, createId: deterministicIds() });
  const state = new UserStateService({ library, now: () => new Date('2026-09-03T12:00:00.000Z') });
  try {
    const capture = await captureFixture(library, 'State fixture', 'Immutable source body.');
    const immutableBefore = await Promise.all([
      readFile(capture.sourceManifestPath),
      readFile(capture.sourceContentPath),
      readFile(capture.articleManifestPath),
      readFile(capture.articleContentPath),
    ]);
    assert.deepEqual(await state.get(capture.archiveArticle.id), {
      schemaVersion: 1,
      articleId: capture.archiveArticle.id,
      revision: 0,
      status: 'unread',
      tags: [],
      priority: 0,
    });

    const updated = await state.update({
      articleId: capture.archiveArticle.id,
      expectedRevision: 0,
      patch: {
        status: 'reading',
        tags: ['Research', 'research', 'TypeScript'],
        rating: 4,
        priority: 5,
        dueAt: '2026-09-10',
        readLaterAt: '2026-09-04T08:30:00Z',
      },
    });
    assert.deepEqual(updated, {
      schemaVersion: 1,
      articleId: capture.archiveArticle.id,
      revision: 1,
      status: 'reading',
      tags: ['research', 'typescript'],
      rating: 4,
      priority: 5,
      dueAt: '2026-09-10T00:00:00.000Z',
      readLaterAt: '2026-09-04T08:30:00.000Z',
      updatedAt: '2026-09-03T12:00:00.000Z',
    });
    assert.deepEqual(await Promise.all([
      readFile(capture.sourceManifestPath),
      readFile(capture.sourceContentPath),
      readFile(capture.articleManifestPath),
      readFile(capture.articleContentPath),
    ]), immutableBefore);

    const cleared = await state.update({
      articleId: capture.archiveArticle.id,
      expectedRevision: 1,
      patch: { rating: null, dueAt: null, status: 'completed' },
    });
    assert.equal(cleared.revision, 2);
    assert.equal(cleared.rating, undefined);
    assert.equal(cleared.dueAt, undefined);
    assert.equal(cleared.status, 'completed');
    await assert.rejects(
      () => state.update({ articleId: capture.archiveArticle.id, expectedRevision: 1, patch: { priority: 1 } }),
      /revision conflict.*expected 1, current 2/u,
    );
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('concurrent stale queue updates allow one deterministic winner without lost updates', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-state-conflict-'));
  const library = new LibraryService({ libraryDir, createId: deterministicIds() });
  const first = new UserStateService({ library });
  const second = new UserStateService({ library });
  try {
    const capture = await captureFixture(library, 'Conflict fixture', 'Conflict-safe body.');
    const articleId = capture.archiveArticle.id;
    const results = await Promise.allSettled([
      first.update({ articleId, expectedRevision: 0, patch: { status: 'reading' } }),
      second.update({ articleId, expectedRevision: 0, patch: { status: 'archived' } }),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
    assert.equal((await first.get(articleId)).revision, 1);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('reading queues filter and sort user state deterministically', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-queue-'));
  let tick = 0;
  const library = new LibraryService({
    libraryDir,
    createId: deterministicIds(),
    now: () => new Date(Date.UTC(2026, 8, 3, 0, 0, tick++)),
  });
  const state = new UserStateService({ library, now: () => new Date('2026-09-03T12:00:00.000Z') });
  try {
    const low = await captureFixture(library, 'Low priority', 'First queue body.');
    const due = await captureFixture(library, 'Due first', 'Second queue body.');
    const reading = await captureFixture(library, 'Reading now', 'Third queue body.');
    const done = await captureFixture(library, 'Already done', 'Fourth queue body.');
    await state.update({ articleId: low.archiveArticle.id, expectedRevision: 0, patch: { priority: 1, tags: ['work'] } });
    await state.update({ articleId: due.archiveArticle.id, expectedRevision: 0, patch: { priority: 5, dueAt: '2026-09-06', rating: 5, tags: ['work'] } });
    await state.update({ articleId: reading.archiveArticle.id, expectedRevision: 0, patch: { status: 'reading', priority: 5, dueAt: '2026-09-05' } });
    await state.update({ articleId: done.archiveArticle.id, expectedRevision: 0, patch: { status: 'completed', priority: 5 } });

    assert.deepEqual((await state.queue()).map(({ article }) => article.id), [
      reading.archiveArticle.id,
      due.archiveArticle.id,
      low.archiveArticle.id,
    ]);
    assert.deepEqual((await state.queue({ tag: 'WORK', minimumRating: 4 })).map(({ article }) => article.id), [due.archiveArticle.id]);
    assert.deepEqual((await state.queue({ status: 'completed' })).map(({ article }) => article.id), [done.archiveArticle.id]);
    assert.deepEqual((await state.queue({}, 'title')).map(({ article }) => article.title), ['Due first', 'Low priority', 'Reading now']);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('portable state snapshots restore exactly and fail closed on collisions', async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-state-backup-source-'));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-state-backup-target-'));
  const sourceLibrary = new LibraryService({ libraryDir: sourceDir, createId: deterministicIds() });
  const targetLibrary = new LibraryService({ libraryDir: targetDir, createId: deterministicIds() });
  const sourceState = new UserStateService({ library: sourceLibrary });
  const targetState = new UserStateService({ library: targetLibrary });
  try {
    const sourceCapture = await captureFixture(sourceLibrary, 'Portable state', 'Backup body.');
    const targetCapture = await captureFixture(targetLibrary, 'Portable state', 'Backup body.');
    assert.equal(sourceCapture.archiveArticle.id, targetCapture.archiveArticle.id);
    await sourceState.update({
      articleId: sourceCapture.archiveArticle.id,
      expectedRevision: 0,
      patch: { status: 'reading', tags: ['portable'], priority: 4, rating: 5 },
    });
    const snapshot = await sourceState.snapshot();
    assert.equal(snapshot.records.length, 1);
    assert.deepEqual(await targetState.restore(snapshot), { restored: 1, unchanged: 0 });
    assert.deepEqual(await targetState.snapshot(), snapshot);
    assert.deepEqual(await targetState.restore(snapshot), { restored: 0, unchanged: 1 });

    await targetState.update({ articleId: targetCapture.archiveArticle.id, expectedRevision: 1, patch: { priority: 1 } });
    const beforeConflict = await targetState.snapshot();
    await assert.rejects(() => targetState.restore(snapshot), /restore collision/u);
    assert.deepEqual(await targetState.snapshot(), beforeConflict);
  } finally {
    await Promise.all([
      rm(sourceDir, { recursive: true, force: true }),
      rm(targetDir, { recursive: true, force: true }),
    ]);
  }
});
