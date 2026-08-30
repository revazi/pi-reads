import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  classifyFontFamily,
  chooseSourceFontStyle,
  detectSourceFontStyle,
  inferSourceFontStyle,
} from '../src/core/extraction/fonts.ts';
import { extractWebArticle } from '../src/core/extraction/readability.ts';
import { assertHttpUrl, cleanUrl } from '../src/core/extraction/urls.ts';
import { ingestSource } from '../src/core/ingest/index.ts';
import { ingestUrl } from '../src/core/ingest/url.ts';
import { renderLegacyArticleMarkdown } from '../src/core/render/legacy-markdown.ts';

const fixtureUrl = 'https://example.test/input?utm_source=test';
const fixtureHtml = await readFile(new URL('./fixtures/article.html', import.meta.url), 'utf8');
const expectedMarkdown = await readFile(new URL('./fixtures/article.expected.md', import.meta.url), 'utf8');

test('cleanUrl resolves relative links and removes tracking parameters and text fragments', () => {
  assert.equal(
    cleanUrl('/path?utm_source=feed&Ref=partner&keep=yes#:~:text=ignored', 'https://example.test/base'),
    'https://example.test/path?keep=yes',
  );
  assert.equal(cleanUrl('javascript:alert(1)', fixtureUrl), '');
  assert.equal(cleanUrl('#section', fixtureUrl), '#section');
});

test('assertHttpUrl rejects malformed and unsupported URL input', () => {
  assert.equal(assertHttpUrl(fixtureUrl).protocol, 'https:');
  assert.throws(() => assertHttpUrl('not a URL'), /Invalid article URL/);
  assert.throws(() => assertHttpUrl('file:///tmp/article.html'), /Unsupported article URL protocol/);
  assert.throws(() => assertHttpUrl('https://user:secret@example.test/article'), /must not contain credentials/);
});

test('fixture extraction preserves deterministic metadata, cleanup, and Markdown output', () => {
  const article = extractWebArticle(fixtureUrl, fixtureHtml);

  assert.equal(article.title, 'Fixture Article');
  assert.equal(article.author, 'Ada Example');
  assert.equal(article.sourceUrl, 'https://example.test/writing/core-library?keep=yes');
  assert.equal(article.date, '2026-08-20T10:30:00Z');
  assert.equal(article.description, 'A deterministic fixture used to verify extraction behavior.');
  assert.doesNotMatch(article.body, /Site navigation|Table of contents|By Ada Example|Related content/);
  assert.match(article.body, /https:\/\/example\.test\/reference\?keep=1/);
  assert.match(article.body, /```typescript\nconst answer = 42;\n```/);
  assert.match(article.body, /<table><thead>/);

  const markdown = renderLegacyArticleMarkdown(article, {
    slug: 'phase1-fixture',
    sourceFontStyle: 'serif',
  });
  assert.equal(markdown, expectedMarkdown);
});

test('URL ingestion uses one fetch and deterministic captured-CSS font inference', async () => {
  const calls: string[] = [];
  const styledHtml = fixtureHtml.replace('</head>', '<style>article { font-family: Inter, sans-serif; }</style></head>');
  const article = await ingestUrl(fixtureUrl, {
    fetchHtml: async (url) => {
      calls.push(`fetch:${url}`);
      return styledHtml;
    },
  });

  assert.deepEqual(calls, [`fetch:${fixtureUrl}`]);
  assert.equal(article.sourceFontStyle, 'sans-serif');

  const source = await ingestSource(
    { kind: 'url', url: fixtureUrl },
    { url: { fetchHtml: async () => fixtureHtml } },
  );
  assert.equal(source.kind, 'url');
  assert.equal(source.canonicalUrl, 'https://example.test/writing/core-library?keep=yes');
  assert.match(source.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(source.textHash, /^sha256:[0-9a-f]{64}$/);
});

test('legacy font detection wrapper performs deterministic local inference', async () => {
  const paragraph = 'This deliberately long paragraph supplies enough deterministic text to be selected as an article font sample for inference.';
  assert.equal(
    await detectSourceFontStyle(
      fixtureUrl,
      `<article><p>${paragraph}</p></article>`,
      `<style>article { font-family: Inter, sans-serif; }</style><article><p>${paragraph}</p></article>`,
    ),
    'sans-serif',
  );
});

test('URL ingestion honors cancellation before side effects', async () => {
  const controller = new AbortController();
  controller.abort();
  let fetched = false;
  await assert.rejects(
    () =>
      ingestUrl(
        fixtureUrl,
        {
          fetchHtml: async () => {
            fetched = true;
            return fixtureHtml;
          },
        },
        controller.signal,
      ),
    { name: 'AbortError' },
  );
  assert.equal(fetched, false);
});

test('font inference uses captured styles and safely defaults to serif', () => {
  const extracted = extractWebArticle(fixtureUrl, fixtureHtml);
  assert.equal(inferSourceFontStyle(extracted.readableContentHtml, fixtureHtml), 'serif');
  assert.equal(
    inferSourceFontStyle(
      '<article><p>This deliberately long paragraph supplies enough deterministic text to be selected as an article font sample for inference.</p></article>',
      '<style>article { font-family: Inter, sans-serif; }</style><article><p>This deliberately long paragraph supplies enough deterministic text to be selected as an article font sample for inference.</p></article>',
    ),
    'sans-serif',
  );
  assert.equal(inferSourceFontStyle('<p>Too short.</p>', '<style>not valid {</style><p>Too short.</p>'), 'serif');
  assert.equal(classifyFontFamily('Inter, system-ui, sans-serif'), 'sans-serif');
  assert.equal(classifyFontFamily('Georgia, serif'), 'serif');
  assert.equal(classifyFontFamily('Custom Display'), null);
  assert.equal(
    chooseSourceFontStyle([
      { fontFamily: 'Georgia, serif', textLength: 80 },
      { fontFamily: 'Inter, sans-serif', textLength: 200 },
    ]),
    'sans-serif',
  );
});
