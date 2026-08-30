import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { LibraryService } from '../src/application/library-service.ts';
import type { ArticleRecord, Sha256Digest, SourceRecord } from '../src/core/domain.ts';
import { LIBRARY_INDEX_DIRTY_PATH, LIBRARY_INDEX_PATH, type LibraryIndex } from '../src/core/library-index.ts';
import { articleContentPath, sourceContentPath, type RecordIdPrefix } from '../src/core/library.ts';

const hash = `sha256:${'a'.repeat(64)}` as Sha256Digest;

function deterministicIds(): (prefix: RecordIdPrefix) => string {
  const counts: Record<RecordIdPrefix, number> = { src: 0, art: 0, cite: 0, exp: 0 };
  return (prefix) => {
    counts[prefix] += 1;
    return `${prefix}_${prefix[0].repeat(15)}${counts[prefix].toString(36)}`;
  };
}

function indexedArticle(index: number, sourceId: string): ArticleRecord {
  const id = `art_${index.toString(36).padStart(16, '0')}`;
  return {
    schemaVersion: 1,
    id,
    mode: 'archive',
    title: `Indexed Fixture ${index}`,
    slug: `indexed-fixture-${index}`,
    sourceIds: [sourceId],
    body: {
      path: articleContentPath('archive', id),
      mediaType: 'text/markdown',
      contentHash: hash,
      textHash: hash,
      byteLength: 7,
    },
    citations: [],
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
    archiveVerification: { sourceId, sourceTextHash: hash },
  };
}

async function readIndex(libraryDir: string): Promise<LibraryIndex> {
  return JSON.parse(await readFile(path.join(libraryDir, LIBRARY_INDEX_PATH), 'utf8')) as LibraryIndex;
}

test('library index serves listing and slug allocation without reopening article manifests', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-index-normal-'));
  const library = new LibraryService({ libraryDir, createId: deterministicIds() });
  try {
    const first = await library.capture({ kind: 'markdown', label: 'Indexed Article', markdown: '# One\n\nBody.' });
    const second = await library.capture({ kind: 'markdown', label: 'Indexed Article', markdown: '# Two\n\nBody.' });
    assert.equal(first.archiveArticle.slug, 'indexed-article');
    assert.equal(second.archiveArticle.slug, 'indexed-article-2');

    const index = await readIndex(libraryDir);
    assert.equal(index.sources.length, 2);
    assert.equal(index.articles.length, 2);
    assert.equal(index.sources[0].content.contentHash, first.source.content.contentHash);
    assert.equal(index.sources[0].capturedAt, first.source.capturedAt);
    assert.equal(index.articles[0].mode, 'archive');

    const manifestPath = first.articleManifestPath;
    const hiddenManifestPath = `${manifestPath}.hidden`;
    await rename(manifestPath, hiddenManifestPath);
    try {
      assert.equal((await library.listArticles()).length, 2);
      assert.equal((await library.searchArticles('indexed-article-2'))[0]?.id, second.archiveArticle.id);
      const third = await library.capture({ kind: 'markdown', label: 'Indexed Article', markdown: '# Three\n\nBody.' });
      assert.equal(third.archiveArticle.slug, 'indexed-article-3');
    } finally {
      await rename(hiddenManifestPath, manifestPath);
    }
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('library index rebuilds from canonical manifests when missing, malformed, stale, or dirty', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-index-recovery-'));
  const library = new LibraryService({ libraryDir, createId: deterministicIds() });
  try {
    const capture = await library.capture({ kind: 'markdown', label: 'Recovery', markdown: '# Recovery\n\nBody.' });
    const indexPath = path.join(libraryDir, LIBRARY_INDEX_PATH);

    await rm(indexPath);
    assert.equal((await library.listArticles()).length, 1);
    assert.equal((await readIndex(libraryDir)).articles[0].id, capture.archiveArticle.id);

    await writeFile(indexPath, '{ malformed');
    assert.equal((await library.listArticles()).length, 1);
    await assert.doesNotReject(() => readIndex(libraryDir));

    const extra = indexedArticle(999, capture.source.id);
    const extraDirectory = path.join(libraryDir, 'articles', 'archive', extra.id);
    await mkdir(extraDirectory);
    await writeFile(path.join(extraDirectory, 'manifest.json'), `${JSON.stringify(extra)}\n`);
    assert.deepEqual(new Set((await library.listArticles()).map((article) => article.id)), new Set([
      capture.archiveArticle.id,
      extra.id,
    ]));

    const stale = await readIndex(libraryDir);
    stale.articles = [];
    await writeFile(indexPath, `${JSON.stringify(stale)}\n`);
    const dirtyPath = path.join(libraryDir, LIBRARY_INDEX_DIRTY_PATH);
    await writeFile(dirtyPath, 'interrupted update\n');
    assert.equal((await library.listArticles()).length, 2);
    await assert.rejects(() => readFile(dirtyPath), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');

    await writeFile(path.join(path.dirname(indexPath), '.library.json.interrupted.tmp'), 'partial');
    assert.equal((await library.listArticles()).length, 2);
    assert.equal((await library.loadArticle(capture.archiveArticle.id)).article.id, capture.archiveArticle.id);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('concurrent library instances serialize index updates and allocate unique slugs', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-index-concurrent-'));
  const createId = deterministicIds();
  const first = new LibraryService({ libraryDir, createId });
  const second = new LibraryService({ libraryDir, createId });
  try {
    const captures = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 === 0 ? first : second).capture({
        kind: 'markdown',
        label: 'Concurrent Article',
        markdown: `# Concurrent ${index}\n\nBody.`,
      })));
    assert.equal(new Set(captures.map((capture) => capture.source.id)).size, 20);
    assert.equal(new Set(captures.map((capture) => capture.archiveArticle.id)).size, 20);
    assert.equal(new Set(captures.map((capture) => capture.archiveArticle.slug)).size, 20);
    assert.equal((await first.listArticles()).length, 20);
    const index = await readIndex(libraryDir);
    assert.equal(index.sources.length, 20);
    assert.equal(index.articles.length, 20);
    assert.equal(await readdir(path.join(libraryDir, 'indexes')).then((entries) => entries.includes('dirty')), false);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('10,000-record index meets the documented 500 ms list and search budgets', { timeout: 30_000 }, async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-index-scale-'));
  const sourceId = 'src_0000000000000001';
  const source: SourceRecord = {
    schemaVersion: 1,
    id: sourceId,
    kind: 'text',
    title: 'Scale fixture source',
    capturedAt: '2026-01-01T00:00:00.000Z',
    origin: { locator: 'fixture://scale', canonicalUrl: 'https://example.test/scale' },
    content: {
      path: sourceContentPath(sourceId),
      mediaType: 'text/markdown',
      contentHash: hash,
      textHash: hash,
      byteLength: 7,
    },
    capture: { adapter: 'fixture' },
  };
  try {
    const sourceDirectory = path.join(libraryDir, 'sources', sourceId);
    const articlesDirectory = path.join(libraryDir, 'articles', 'archive');
    await Promise.all([mkdir(sourceDirectory, { recursive: true }), mkdir(articlesDirectory, { recursive: true })]);
    await writeFile(path.join(sourceDirectory, 'manifest.json'), `${JSON.stringify(source)}\n`);

    const count = 10_000;
    const batchSize = 250;
    for (let start = 0; start < count; start += batchSize) {
      await Promise.all(Array.from({ length: Math.min(batchSize, count - start) }, async (_, offset) => {
        const article = indexedArticle(start + offset, sourceId);
        const directory = path.join(articlesDirectory, article.id);
        await mkdir(directory);
        await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(article)}\n`);
      }));
    }

    const library = new LibraryService({ libraryDir });
    const rebuilt = await library.rebuildIndex();
    assert.equal(rebuilt.sourceCount, 1);
    assert.equal(rebuilt.articleCount, count);
    const scaleIndex = await readIndex(libraryDir);
    assert.equal(scaleIndex.sources[0].origin.canonicalUrl, 'https://example.test/scale');
    assert.equal(scaleIndex.articles[0].body.contentHash, hash);

    const listStarted = performance.now();
    const articles = await library.listArticles();
    const listMs = performance.now() - listStarted;
    const searchStarted = performance.now();
    const matches = await library.searchArticles('Indexed Fixture 9999', 10);
    const searchMs = performance.now() - searchStarted;

    assert.equal(articles.length, count);
    assert.equal(matches[0]?.slug, 'indexed-fixture-9999');
    assert.ok(listMs <= 500, `10,000-record listing took ${listMs.toFixed(1)} ms`);
    assert.ok(searchMs <= 500, `10,000-record search took ${searchMs.toFixed(1)} ms`);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});
