import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExportService } from '../src/application/export-service.ts';
import { LibraryService } from '../src/application/library-service.ts';
import type { RecordIdPrefix } from '../src/core/library.ts';

function deterministicIds(): (prefix: RecordIdPrefix) => string {
  const counts: Record<RecordIdPrefix, number> = { src: 0, art: 0, cite: 0, exp: 0 };
  const letters: Record<RecordIdPrefix, string> = { src: 'a', art: 'b', cite: 'c', exp: 'd' };
  return (prefix) => {
    counts[prefix] += 1;
    return `${prefix}_${letters[prefix].repeat(15)}${counts[prefix].toString(36)}`;
  };
}

test('application services capture, generate, list, and export immutable articles', { timeout: 30_000 }, async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-application-'));
  const createId = deterministicIds();
  const now = () => new Date('2026-08-20T12:00:00Z');
  const library = new LibraryService({ libraryDir, createId, now });
  const exports = new ExportService({ library, createId, now });

  try {
    const capture = await library.capture({
      kind: 'markdown',
      label: 'Core Fixture',
      markdown: '# Captured source\n\nFaithful prose.\n\n```ts\nconst value = 1;\n```',
    });

    assert.equal(capture.source.kind, 'markdown');
    assert.equal(capture.archiveArticle.mode, 'archive');
    assert.equal(capture.archiveArticle.archiveVerification?.sourceTextHash, capture.source.content.textHash);
    assert.equal(await readFile(capture.sourceContentPath, 'utf8'), '# Captured source\n\nFaithful prose.\n\n```ts\nconst value = 1;\n```');

    const archiveHtml = await exports.prepare(capture.archiveArticle.id, 'html');
    const renderedArchive = await readFile(archiveHtml.artifactPath, 'utf8');
    assert.match(renderedArchive, /class="article-body"/);
    assert.match(renderedArchive, /github-light/);
    assert.match(renderedArchive, /Faithful prose/);

    const generated = await library.saveGenerated({
      mode: 'digest',
      title: 'Generated digest',
      body: 'A concise generated statement.[^cite_source]',
      sourceIds: [capture.source.id],
      citations: [
        {
          id: 'cite_source',
          sourceId: capture.source.id,
          quote: 'Faithful prose.',
        },
      ],
      generatedBy: {
        provider: 'fixture-provider',
        model: 'fixture-model',
        thinkingLevel: 'low',
        sessionId: 'fixture-session',
        generatedAt: '2026-08-20T12:00:00Z',
      },
    });
    assert.equal(generated.article.mode, 'digest');
    assert.equal(generated.article.generatedBy?.model, 'fixture-model');

    const markdownExport = await exports.prepare(generated.article.id, 'markdown');
    const exportedMarkdown = await readFile(markdownExport.artifactPath, 'utf8');
    assert.match(exportedMarkdown, /piReadsArticleId/);
    assert.match(exportedMarkdown, /\[\^cite_source\]: Core Fixture/);

    const htmlExport = await exports.prepare(generated.article.id, 'html');
    const exportedHtml = await readFile(htmlExport.artifactPath, 'utf8');
    assert.match(exportedHtml, /class="article-citations"/);
    assert.match(exportedHtml, /Faithful prose\./);

    const articles = await library.listArticles();
    assert.deepEqual(new Set(articles.map((article) => article.mode)), new Set(['archive', 'digest']));

    const fixtureHtml = await readFile(new URL('./fixtures/article.html', import.meta.url), 'utf8');
    const urlCapture = await library.capture(
      { kind: 'url', url: 'https://example.test/input' },
      {
        url: {
          fetchHtml: async () => fixtureHtml,
          detectFontStyle: async () => 'serif',
        },
      },
    );
    await assert.doesNotReject(() => library.loadSource(urlCapture.source.id));
    await assert.doesNotReject(() => exports.renderHtml(urlCapture.archiveArticle.id));
    await writeFile(urlCapture.sourceContentPath, 'tampered');
    await assert.rejects(() => library.loadSource(urlCapture.source.id), /content hash mismatch/);

    await assert.rejects(
      () =>
        library.saveGenerated({
          mode: 'digest',
          title: 'Broken citations',
          body: 'Missing marker.',
          sourceIds: [capture.source.id],
          citations: [{ id: 'cite_missing', sourceId: capture.source.id }],
          generatedBy: {
            provider: 'fixture',
            model: 'fixture',
            generatedAt: '2026-08-20T12:00:00Z',
          },
        }),
      /does not reference citation cite_missing/,
    );
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});
