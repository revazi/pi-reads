import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LibraryService } from '../src/application/library-service.ts';
import { FULL_TEXT_SEARCH_INDEX_PATH, SearchService } from '../src/application/search-service.ts';
import { UserStateService } from '../src/application/user-state-service.ts';
import {
  createArticleSearchBlocks,
  createFullTextSearchIndex,
  searchFullTextIndex,
} from '../src/core/full-text-search.ts';
import { resolveLibraryPath, type RecordIdPrefix } from '../src/core/library.ts';
import { versionedSha256 } from '../src/core/text.ts';

function deterministicIds(): (prefix: RecordIdPrefix) => string {
  const counts: Record<RecordIdPrefix, number> = { src: 0, art: 0, cite: 0, exp: 0 };
  return (prefix) => `${prefix}_${prefix[0].repeat(15)}${(++counts[prefix]).toString(36)}`;
}

test('private full-text search labels archive/generated exact excerpts and applies filters offline', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-full-text-'));
  const library = new LibraryService({
    libraryDir,
    createId: deterministicIds(),
    now: () => new Date('2026-09-03T12:00:00.000Z'),
  });
  try {
    const fixtureHtml = await readFile(new URL('./fixtures/article.html', import.meta.url), 'utf8');
    const capture = await library.capture(
      { kind: 'url', url: 'https://example.test/input' },
      { url: { fetchHtml: async () => fixtureHtml } },
    );
    const { index } = await library.loadSourceIndex(capture.source.id);
    const generated = await library.saveGenerated({
      mode: 'synthesis',
      title: 'Generated Search Note',
      body: '# Quasar analysis\n\nA unique quasar synthesis insight.[^cite_search]',
      sourceIds: [capture.source.id],
      citations: [{
        id: 'cite_search',
        sourceId: capture.source.id,
        locator: { paragraph: 1 },
      }],
      coverage: {
        policy: 'complete',
        sources: [{
          sourceId: capture.source.id,
          sourceContentHash: index.sourceContentHash,
          consideredLocators: [...index.headings, ...index.paragraphs].map(({ id }) => id),
        }],
      },
      generatedBy: { provider: 'fixture', model: 'fixture', generatedAt: '2026-09-03T12:00:00.000Z' },
    });
    const userState = new UserStateService({ library });
    await userState.update({
      articleId: generated.article.id,
      expectedRevision: 0,
      patch: { status: 'reading', tags: ['research'] },
    });
    const search = new SearchService({ library, userState });

    const archiveResult = await search.search('meaningful prose', { mode: 'archive' });
    assert.equal(archiveResult.hits[0]?.mode, 'archive');
    assert.equal(archiveResult.hits[0]?.articleId, capture.archiveArticle.id);
    assert.equal(archiveResult.hits[0]?.snippet.field, 'body');
    assert.equal(archiveResult.hits[0]?.snippet.sourceId, capture.source.id);
    assert.match(archiveResult.hits[0]?.snippet.locator ?? '', /^[hp]_/u);
    const archiveContent = (await library.loadArticle(capture.archiveArticle.id)).content;
    const archiveSnippet = archiveResult.hits[0]!.snippet;
    assert.equal(
      Buffer.from(archiveContent).subarray(archiveSnippet.startByte, archiveSnippet.endByte).toString('utf8'),
      archiveSnippet.excerpt,
    );

    const generatedResult = await search.search('quasar', {
      mode: 'synthesis',
      sourceId: capture.source.id,
      status: 'reading',
      tag: 'research',
    });
    assert.equal(generatedResult.hits[0]?.mode, 'synthesis');
    assert.equal(generatedResult.hits[0]?.articleId, generated.article.id);
    assert.match(generatedResult.hits[0]?.snippet.locator ?? '', /^(metadata:title|b_)/u);
    assert.match(generatedResult.hits[0]?.snippet.excerpt ?? '', /[Qq]uasar/u);
    const generatedProse = await search.search('unique synthesis insight', { mode: 'synthesis' });
    assert.equal(generatedProse.hits[0]?.snippet.field, 'body');
    assert.match(generatedProse.hits[0]?.snippet.locator ?? '', /^b_/u);
    const generatedContent = (await library.loadArticle(generated.article.id)).content;
    const generatedSnippet = generatedProse.hits[0]!.snippet;
    assert.equal(
      Buffer.from(generatedContent).subarray(generatedSnippet.startByte, generatedSnippet.endByte).toString('utf8'),
      generatedSnippet.excerpt,
    );

    const authorResult = await search.search('Ada', { author: 'ada example', mode: 'archive' });
    assert.equal(authorResult.hits[0]?.snippet.field, 'author');
    const urlResult = await search.search('core library', { sourceId: capture.source.id });
    assert.ok(urlResult.hits.some(({ snippet }) => snippet.field === 'url'));
    const dateResult = await search.search('quasar', { from: '2026-09-03', to: '2026-09-03' });
    assert.equal(dateResult.hits[0]?.articleId, generated.article.id);
    await userState.update({
      articleId: generated.article.id,
      expectedRevision: 1,
      patch: { status: 'completed' },
    });
    const changedStateResult = await search.search('quasar', { status: 'completed' });
    assert.equal(changedStateResult.recoveredIndex, true);
    assert.equal(changedStateResult.hits[0]?.articleId, generated.article.id);
    assert.deepEqual((await search.search('quasar', { status: 'reading' })).hits, []);
    assert.deepEqual((await search.search('quasar', { mode: 'digest' })).hits, []);
    await assert.rejects(() => search.search('quasar', { from: '2026-09-04', to: '2026-09-03' }), /from must not be after to/u);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('search index deletion and corruption recover to deterministic equivalent results', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-search-rebuild-'));
  const library = new LibraryService({ libraryDir, createId: deterministicIds() });
  try {
    await library.capture({ kind: 'markdown', label: 'Rebuild fixture', markdown: '# Rebuild\n\nDeterministic lexical evidence.' });
    const search = new SearchService({ library });
    const stats = await search.rebuild();
    assert.equal(stats.documentCount, 1);
    const indexPath = resolveLibraryPath(libraryDir, FULL_TEXT_SEARCH_INDEX_PATH);
    const originalBytes = await readFile(indexPath);
    const expected = await search.search('lexical evidence');
    assert.equal(expected.recoveredIndex, false);

    await rm(indexPath);
    const afterDeletion = await search.search('lexical evidence');
    assert.equal(afterDeletion.recoveredIndex, true);
    assert.deepEqual(afterDeletion.hits, expected.hits);
    assert.deepEqual(await readFile(indexPath), originalBytes);

    const corrupted = JSON.parse(originalBytes.toString('utf8')) as { documents: Array<{ termFrequencies: unknown[] }> };
    corrupted.documents[0]!.termFrequencies = [];
    await writeFile(indexPath, `${JSON.stringify(corrupted)}\n`);
    const afterCorruption = await search.search('lexical evidence');
    assert.equal(afterCorruption.recoveredIndex, true);
    assert.deepEqual(afterCorruption.hits, expected.hits);
    assert.deepEqual(await readFile(indexPath), originalBytes);

    await library.capture({ kind: 'text', label: 'New corpus record', text: 'Freshly indexed offline phrase.' });
    const afterCorpusChange = await search.search('freshly indexed');
    assert.equal(afterCorpusChange.recoveredIndex, true);
    assert.equal(afterCorpusChange.hits[0]?.mode, 'archive');
    assert.notDeepEqual(await readFile(indexPath), originalBytes);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('BM25-style core supports forward-compatible tag and status filters', () => {
  const content = '# Queue\n\nPrivate searchable text.';
  const index = createFullTextSearchIndex([{
    articleId: 'art_aaaaaaaaaaaaaaaa',
    mode: 'digest',
    title: 'Queued reading',
    authors: ['Ada Example'],
    canonicalUrls: [],
    sourceIds: ['src_bbbbbbbbbbbbbbbb'],
    createdAt: '2026-09-03T00:00:00.000Z',
    contentHash: versionedSha256(content),
    content,
    blocks: createArticleSearchBlocks(content),
    tags: ['research'],
    status: 'reading',
  }]);
  assert.equal(searchFullTextIndex(index, 'private', { tag: 'RESEARCH', status: 'READING' }).length, 1);
  assert.equal(searchFullTextIndex(index, 'private', { tag: 'other' }).length, 0);
});
