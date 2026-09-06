import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CollectionIngestionService } from '../src/application/collection-ingestion-service.ts';
import { LibraryService } from '../src/application/library-service.ts';
import { fetchFeedXml } from '../src/core/ingest/feed-fetch.ts';
import { parseFeed } from '../src/core/ingest/feed.ts';
import { ingestNewsletterFile } from '../src/core/ingest/newsletter.ts';
import { validateRecord } from '../src/core/record-validation.ts';

const fixtures = path.resolve('tests/fixtures');
const rssPath = path.join(fixtures, 'feed-rss.xml');
const atomPath = path.join(fixtures, 'feed-atom.xml');
const newsletterPath = path.join(fixtures, 'newsletter.eml');

async function fixture(name: string): Promise<string> {
  return readFile(path.join(fixtures, name), 'utf8');
}

function libraryAt(root: string): LibraryService {
  let id = 0;
  return new LibraryService({
    libraryDir: path.join(root, 'library'),
    allowGitWorkingTree: true,
    now: () => new Date('2025-04-04T00:00:00.000Z'),
    createId: (prefix) => `${prefix}_${String(++id).padStart(16, '0')}`,
  });
}

test('RSS and Atom adapters produce bounded canonical source drafts from local fixtures', async () => {
  const rss = parseFeed(await fixture('feed-rss.xml'), 'https://feed.example.test/rss.xml');
  assert.equal(rss.format, 'rss');
  assert.equal(rss.title, 'Synthetic Reading Feed');
  assert.equal(rss.totalEntryCount, 4);
  assert.equal(rss.entriesTruncated, false);
  assert.equal(rss.drafts[0]!.kind, 'feed');
  assert.equal(rss.drafts[0]!.canonicalUrl, 'https://articles.example.test/one');
  assert.equal(rss.drafts[0]!.publishedAt, '2025-04-01T10:00:00.000Z');
  assert.deepEqual(rss.drafts[0]!.authors, ['Fixture Author']);
  assert.equal(rss.drafts[0]!.content, 'First synthetic feed paragraph.');
  assert.doesNotMatch(rss.drafts[0]!.content, /not evidence|script/iu);
  assert.equal(rss.drafts[0]!.contentHash, rss.drafts[1]!.contentHash);

  const atom = parseFeed(await fixture('feed-atom.xml'), 'https://atom.example.test/feed.xml');
  assert.equal(atom.format, 'atom');
  assert.equal(atom.drafts.length, 2);
  assert.equal(atom.drafts[0]!.canonicalUrl, 'https://atom.example.test/article');
  assert.deepEqual(atom.drafts[0]!.authors, ['Atom Fixture']);
  assert.match(atom.drafts[0]!.content, /Synthetic \*\*Atom\*\* evidence/u);
  assert.equal(atom.drafts[1]!.content, 'Literal \\*Atom\\* text\\.');
  assert.throws(() => parseFeed('<!DOCTYPE rss><rss/>', 'https://feed.example.test'), /declarations/u);
  assert.throws(() => parseFeed('<html/>', 'https://feed.example.test'), /not an RSS or Atom/u);
});

test('maximum feed previews are truncated and remain below the model-visible result budget', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-feed-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const items = Array.from({ length: 60 }, (_, index) => `
    <item><title>${'T'.repeat(300)} ${index}</title><link>https://articles.example.test/${index}/${'u'.repeat(300)}</link><pubDate>2025-04-01T00:00:00Z</pubDate><description>Fixture ${index}</description></item>`).join('');
  const xml = `<rss version="2.0"><channel><title>Limit feed</title>${items}</channel></rss>`;
  const service = new CollectionIngestionService(libraryAt(root), { fetchFeedXml: async () => xml });
  const preview = await service.preview({ kind: 'feed', url: 'https://feed.example.test/limit.xml' });
  assert.equal(preview.entryCount, 50);
  assert.equal(preview.totalEntryCount, 60);
  assert.equal(preview.entriesTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 32 * 1024);
});

test('local newsletter adapter parses MIME without mailbox access and preserves the .eml evidence', async () => {
  const draft = await ingestNewsletterFile(newsletterPath);
  assert.equal(draft.kind, 'newsletter');
  assert.equal(draft.title, 'Synthetic Weekly Newsletter');
  assert.equal(draft.canonicalUrl, 'https://news.example.test/issues/weekly');
  assert.deepEqual(draft.authors, ['Fixture Editor']);
  assert.equal(draft.publishedAt, '2025-04-03T09:30:00.000Z');
  assert.match(draft.content, /# Synthetic Weekly/u);
  assert.match(draft.content, /Newsletter \*\*fixture\*\* evidence/u);
  assert.doesNotMatch(draft.content, /ignore this|script/iu);
  assert.match(draft.rawContent!, /multipart\/alternative/u);
  assert.deepEqual(Buffer.from(draft.rawContent!), await readFile(newsletterPath));
  assert.equal(draft.rawMediaType, 'message/rfc822');
  await assert.rejects(() => ingestNewsletterFile(rssPath), /local \.eml/u);
});

test('collection preview is no-write, duplicate-aware, token-bound, and captures only selected entries', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-collection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = libraryAt(root);
  let xml = await fixture('feed-rss.xml');
  const service = new CollectionIngestionService(library, { fetchFeedXml: async () => xml });
  const input = { kind: 'feed' as const, url: 'https://feed.example.test/rss.xml' };

  const preview = await service.preview(input);
  assert.equal(preview.entryCount, 4);
  assert.deepEqual(preview.entries.map((entry) => entry.status), [
    'new', 'duplicate-in-preview', 'changed-in-preview', 'new',
  ]);
  assert.equal(preview.entries[1]!.duplicateOfIndex, 0);
  assert.equal(preview.entries[2]!.duplicateOfIndex, 0);
  assert.deepEqual(await library.listSources(), []);
  assert.deepEqual(await library.listArticles(), []);
  await assert.rejects(() => service.capture(input, [], preview.previewToken), /explicit selection/u);
  await assert.rejects(
    () => service.capture(input, [0], 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    /changed after preview/u,
  );
  assert.deepEqual(await library.listSources(), []);

  const captured = await service.capture(input, [0, 3], preview.previewToken);
  assert.deepEqual(captured.selectedIndexes, [0, 3]);
  assert.deepEqual(captured.outcomes.map((outcome) => outcome.index), [0, 3]);
  assert.equal(captured.counts.captured, 2);
  assert.equal((await library.listSources()).length, 2);
  const records = await library.listSources();
  assert.deepEqual(records.map((source) => source.kind), ['feed', 'feed']);
  for (const source of records) await assert.doesNotReject(() => validateRecord('source', source));

  const repeated = await service.preview(input);
  assert.deepEqual(repeated.entries.map((entry) => entry.status), [
    'exact-duplicate', 'exact-duplicate', 'changed-content', 'exact-duplicate',
  ]);
  const reused = await service.capture(input, [0], repeated.previewToken);
  assert.equal(reused.counts['exact-duplicate'], 1);

  xml = xml.replace('Second synthetic feed paragraph.', 'Updated feed bytes after review.');
  await assert.rejects(() => service.capture(input, [3], repeated.previewToken), /changed after preview/u);
  assert.equal((await library.listSources()).length, 2);
});

test('newsletter collection requires preview selection and persists one faithful source/archive pair', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-newsletter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = libraryAt(root);
  const service = new CollectionIngestionService(library);
  const input = { kind: 'newsletter' as const, path: newsletterPath };
  const preview = await service.preview(input);
  assert.equal(preview.entryCount, 1);
  assert.equal(preview.entries[0]!.status, 'new');
  assert.equal((await library.listSources()).length, 0);
  const captured = await service.capture(input, [0], preview.previewToken);
  assert.equal(captured.counts.captured, 1);
  const [source] = await library.listSources();
  assert.equal(source!.kind, 'newsletter');
  assert.equal(source!.rawCapture!.mediaType, 'message/rfc822');
  assert.match(source!.rawCapture!.path, /raw\/source\.eml$/u);
  const [article] = await library.listArticles();
  await assert.doesNotReject(() => validateRecord('article', article));
});

test('remote feed fetch enforces network, redirect, media-type, and byte boundaries with fake transport', async () => {
  const xml = await fixture('feed-atom.xml');
  const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
  const fetched = await fetchFeedXml('https://feed.example.test/atom', undefined, {
    resolveHostname: publicDns,
    fetch: async () => new Response(xml, { headers: { 'content-type': 'application/atom+xml' } }),
  });
  assert.equal(fetched, xml);
  await assert.rejects(() => fetchFeedXml('https://feed.example.test/html', undefined, {
    resolveHostname: publicDns,
    fetch: async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }),
  }), /Unsupported feed content type/u);
  await assert.rejects(() => fetchFeedXml('https://feed.example.test/large', undefined, {
    resolveHostname: publicDns,
    maxBytes: 10,
    fetch: async () => new Response(xml, { headers: { 'content-type': 'application/xml' } }),
  }), /exceeds the 10 byte limit/u);

  let requests = 0;
  await assert.rejects(() => fetchFeedXml('https://feed.example.test/redirect', undefined, {
    resolveHostname: async (hostname) => hostname === 'feed.example.test'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }],
    fetch: async () => {
      requests += 1;
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    },
  }), /private or non-routable/u);
  assert.equal(requests, 1);
});
