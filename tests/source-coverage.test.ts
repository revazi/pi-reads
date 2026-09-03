import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExportService } from '../src/application/export-service.ts';
import { LibraryService } from '../src/application/library-service.ts';
import { verifySourceCoverage, type SourceCoverageInput } from '../src/core/source-coverage.ts';

function evidence(
  sourceId: string,
  sourceContentHash: `sha256:${string}`,
  consideredLocators: string[],
  policy: SourceCoverageInput['policy'] = 'complete',
): SourceCoverageInput {
  return {
    policy,
    sources: [{ sourceId, sourceContentHash, consideredLocators }],
  };
}

const markdown = [
  '# Coverage fixture',
  '',
  ...Array.from({ length: 25 }, (_, index) => `Paragraph ${index + 1} contains source evidence.\n`),
].join('\n');

test('complete coverage verifies every indexed locator and reports missing sections', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-complete-coverage-'));
  const library = new LibraryService({ libraryDir });
  try {
    const capture = await library.capture({ kind: 'markdown', label: 'Coverage fixture', markdown });
    const { index } = await library.loadSourceIndex(capture.source.id);
    const locators = [...index.headings.map(({ id }) => id), ...index.paragraphs.map(({ id }) => id)];
    const indexes = new Map([[capture.source.id, index]]);
    const complete = verifySourceCoverage(
      'digest',
      [capture.source.id],
      indexes,
      evidence(capture.source.id, index.sourceContentHash, locators),
    );
    assert.equal(complete.policy, 'complete');
    assert.equal(complete.warning, undefined);
    assert.equal(complete.sources[0].consideredLocatorCount, locators.length);
    assert.equal(complete.sources[0].missingLocatorCount, 0);
    assert.deepEqual(complete.sources[0].missingLocators, []);
    assert.equal(complete.sources[0].indexLocatorHash, complete.sources[0].consideredLocatorHash);

    assert.throws(
      () => verifySourceCoverage(
        'digest',
        [capture.source.id],
        indexes,
        evidence(capture.source.id, index.sourceContentHash, [locators[0]]),
      ),
      /Complete coverage.*missing 25 of 26 indexed sections/u,
    );
    assert.throws(
      () => verifySourceCoverage(
        'digest',
        [capture.source.id],
        indexes,
        evidence(capture.source.id, index.sourceContentHash, ['p_0000000000000000_1']),
      ),
      /unknown locator/u,
    );
    assert.throws(
      () => verifySourceCoverage(
        'digest',
        [capture.source.id],
        indexes,
        evidence(capture.source.id, `sha256:${'0'.repeat(64)}`, locators),
      ),
      /content hash mismatch/u,
    );
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('targeted synthesis persists a non-comprehensive warning and bounded missing-section diagnostics', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-targeted-coverage-'));
  const library = new LibraryService({ libraryDir });
  const exports = new ExportService({ library });
  try {
    const capture = await library.capture({ kind: 'markdown', label: 'Coverage fixture', markdown });
    const { index } = await library.loadSourceIndex(capture.source.id);
    const consideredLocator = index.paragraphs[0].id;
    const targetedCoverage = evidence(
      capture.source.id,
      index.sourceContentHash,
      [consideredLocator],
      'targeted',
    );
    assert.throws(
      () => verifySourceCoverage('digest', [capture.source.id], new Map([[capture.source.id, index]]), targetedCoverage),
      /cannot be saved as a digest/u,
    );

    const saved = await library.saveGenerated({
      mode: 'synthesis',
      title: 'Focused research note',
      body: 'A focused claim.[^cite_focus]',
      sourceIds: [capture.source.id],
      citations: [{ id: 'cite_focus', sourceId: capture.source.id, quote: 'Paragraph 1 contains source evidence.' }],
      coverage: targetedCoverage,
      generatedBy: {
        provider: 'fixture',
        model: 'fixture',
        generatedAt: '2026-09-03T00:00:00.000Z',
      },
    });
    assert.equal(saved.article.sourceCoverage?.policy, 'targeted');
    assert.match(saved.article.sourceCoverage?.warning ?? '', /not a comprehensive digest/u);
    assert.equal(saved.article.sourceCoverage?.sources[0].consideredLocatorCount, 1);
    assert.equal(saved.article.sourceCoverage?.sources[0].missingLocatorCount, 25);
    assert.equal(saved.article.sourceCoverage?.sources[0].missingLocators.length, 20);
    assert.equal(saved.article.sourceCoverage?.sources[0].missingLocatorsTruncated, true);
    assert.deepEqual(saved.article.sourceIds, [capture.source.id]);
    assert.deepEqual(saved.article.citations, [
      { id: 'cite_focus', sourceId: capture.source.id, quote: 'Paragraph 1 contains source evidence.' },
    ]);

    const manifest = JSON.parse(await readFile(saved.manifestPath, 'utf8')) as { sourceCoverage: unknown };
    assert.deepEqual(manifest.sourceCoverage, saved.article.sourceCoverage);
    const markdownExport = await exports.renderMarkdown(saved.article.id);
    assert.match(markdownExport, /coveragePolicy: "targeted"/u);
    assert.match(markdownExport, /coverageWarning: .*not a comprehensive digest/u);
    const htmlExport = await exports.renderHtml(saved.article.id);
    assert.match(htmlExport, /article-coverage-warning/u);
    assert.match(htmlExport, /not a comprehensive digest/u);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('generated persistence rejects incomplete complete coverage before creating an article', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-rejected-coverage-'));
  const library = new LibraryService({ libraryDir });
  try {
    const capture = await library.capture({ kind: 'markdown', label: 'Coverage fixture', markdown });
    const { index } = await library.loadSourceIndex(capture.source.id);
    const before = await library.listArticles();
    await assert.rejects(
      () => library.saveGenerated({
        mode: 'digest',
        title: 'Incomplete digest',
        body: 'An incomplete claim.[^cite_incomplete]',
        sourceIds: [capture.source.id],
        citations: [{ id: 'cite_incomplete', sourceId: capture.source.id }],
        coverage: evidence(capture.source.id, index.sourceContentHash, [index.headings[0].id]),
        generatedBy: {
          provider: 'fixture',
          model: 'fixture',
          generatedAt: '2026-09-03T00:00:00.000Z',
        },
      }),
      /Complete coverage.*missing/u,
    );
    assert.deepEqual(await library.listArticles(), before);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});
