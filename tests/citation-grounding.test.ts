import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LibraryService } from '../src/application/library-service.ts';
import { verifyCitationGrounding } from '../src/core/citation-grounding.ts';
import type { Citation, SourceRecord } from '../src/core/domain.ts';
import { analyzeMarkdown } from '../src/core/ingest/text.ts';
import { sourceContentPath, type RecordIdPrefix } from '../src/core/library.ts';
import { createSourceContentIndex } from '../src/core/source-index.ts';

function sourceFixture(markdown: string): { source: SourceRecord; content: string; index: ReturnType<typeof createSourceContentIndex> } {
  const id = 'src_ggggggggggggggg1';
  const analysis = analyzeMarkdown(markdown);
  const source: SourceRecord = {
    schemaVersion: 1,
    id,
    kind: 'markdown',
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
  return { source, content: markdown, index: createSourceContentIndex(source, markdown) };
}

const sourceMarkdown = '# Alpha\n\nExact first-source quote.\n\n## Beta\n\nSecond section evidence.\n';

test('citation grounding verifies exact quotes and reports source/article section distribution', () => {
  const fixture = sourceFixture(sourceMarkdown);
  const citations: Citation[] = [
    {
      id: 'cite_first',
      sourceId: fixture.source.id,
      locator: { paragraph: 1 },
      quote: 'Exact first-source quote.',
    },
    {
      id: 'cite_second',
      sourceId: fixture.source.id,
      locator: { heading: 'Beta' },
      quote: 'Second section evidence.',
    },
    { id: 'cite_unlocated', sourceId: fixture.source.id },
  ];
  const diagnostics = verifyCitationGrounding(
    '# Supported\n\nGrounded claim.[^cite_first][^cite_second]\n\n## Needs citation\n\nUncited claim.\n',
    citations,
    new Map([[fixture.source.id, fixture]]),
  );

  assert.equal(diagnostics.citationCount, 3);
  assert.equal(diagnostics.locatedCitationCount, 2);
  assert.equal(diagnostics.verifiedQuoteCount, 2);
  assert.equal(diagnostics.articleSectionCount, 2);
  assert.equal(diagnostics.uncitedArticleSectionCount, 1);
  assert.equal(diagnostics.uncitedArticleSections[0]?.heading, 'Needs citation');
  assert.deepEqual(diagnostics.sources[0]?.missingLocatorCitationIds, ['cite_unlocated']);
  assert.deepEqual(diagnostics.sources[0]?.sectionCitationCounts, [
    { locator: fixture.index.paragraphs[0]!.id, citationCount: 1 },
    { locator: fixture.index.headings[1]!.id, citationCount: 1 },
  ]);
});

test('citation grounding fails closed for unsupported quotes and invalid source locators', () => {
  const fixture = sourceFixture(sourceMarkdown);
  const sources = new Map([[fixture.source.id, fixture]]);
  assert.throws(
    () => verifyCitationGrounding('Claim.[^cite_bad]', [{
      id: 'cite_bad',
      sourceId: fixture.source.id,
      locator: { paragraph: 1 },
      quote: 'Fabricated quote.',
    }], sources),
    /quote is not exact immutable source text within locator/u,
  );
  assert.throws(
    () => verifyCitationGrounding('Claim.[^cite_bad]', [{
      id: 'cite_bad',
      sourceId: fixture.source.id,
      locator: { paragraph: 1 },
      quote: 'Second section evidence.',
    }], sources),
    /quote is not exact immutable source text within locator/u,
  );
  assert.throws(
    () => verifyCitationGrounding('Claim.[^cite_bad]', [{
      id: 'cite_bad',
      sourceId: fixture.source.id,
      locator: { paragraph: 99 },
    }], sources),
    /unknown source paragraph 99/u,
  );
  assert.throws(
    () => verifyCitationGrounding('Claim.[^cite_bad]', [{
      id: 'cite_bad',
      sourceId: fixture.source.id,
      locator: { fragment: 'p_0000000000000000_1' },
    }], sources),
    /unknown source locator/u,
  );
});

test('citation diagnostics remain bounded for articles with many uncited sections', () => {
  const fixture = sourceFixture(sourceMarkdown);
  const body = Array.from({ length: 25 }, (_, index) => `# Section ${index + 1}\n\nUncited text ${index + 1}.`).join('\n\n');
  const diagnostics = verifyCitationGrounding(
    body,
    [{ id: 'cite_unlocated', sourceId: fixture.source.id }],
    new Map([[fixture.source.id, fixture]]),
  );
  assert.equal(diagnostics.articleSectionCount, 25);
  assert.equal(diagnostics.uncitedArticleSectionCount, 25);
  assert.equal(diagnostics.articleSections.length, 20);
  assert.equal(diagnostics.uncitedArticleSections.length, 20);
  assert.equal(diagnostics.articleSectionsTruncated, true);
  assert.equal(diagnostics.uncitedArticleSectionsTruncated, true);
});

function deterministicIds(): (prefix: RecordIdPrefix) => string {
  const counts: Record<RecordIdPrefix, number> = { src: 0, art: 0, cite: 0, exp: 0 };
  return (prefix) => `${prefix}_${prefix[0].repeat(15)}${(++counts[prefix]).toString(36)}`;
}

test('generated save persists diagnostics and creates no article for fabricated evidence', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-citation-grounding-'));
  const library = new LibraryService({ libraryDir, createId: deterministicIds() });
  try {
    const capture = await library.capture({ kind: 'markdown', label: 'Grounding source', markdown: sourceMarkdown });
    const { index } = await library.loadSourceIndex(capture.source.id);
    const coverage = {
      policy: 'complete' as const,
      sources: [{
        sourceId: capture.source.id,
        sourceContentHash: index.sourceContentHash,
        consideredLocators: [...index.headings, ...index.paragraphs].map(({ id }) => id),
      }],
    };
    const input = {
      mode: 'digest' as const,
      title: 'Grounded digest',
      body: '# Cited\n\nA grounded claim.[^cite_grounded]\n\n## Uncited\n\nA diagnostic target.',
      sourceIds: [capture.source.id],
      citations: [{
        id: 'cite_grounded',
        sourceId: capture.source.id,
        locator: { paragraph: 1 },
        quote: 'Exact first-source quote.',
      }],
      coverage,
      generatedBy: { provider: 'fixture', model: 'fixture', generatedAt: '2026-09-03T00:00:00.000Z' },
    };
    const stored = await library.saveGenerated(input);
    assert.equal(stored.article.citationDiagnostics?.verifiedQuoteCount, 1);
    assert.equal(stored.article.citationDiagnostics?.uncitedArticleSectionCount, 1);

    const articleCount = (await library.listArticles()).length;
    await assert.rejects(
      () => library.saveGenerated({
        ...input,
        title: 'Fabricated digest',
        citations: [{ ...input.citations[0]!, quote: 'Not in the immutable source.' }],
      }),
      /quote is not exact immutable source text/u,
    );
    await assert.rejects(
      () => library.saveGenerated({
        ...input,
        title: 'Invalid locator digest',
        citations: [{ ...input.citations[0]!, locator: { paragraph: 999 } }],
      }),
      /unknown source paragraph 999/u,
    );
    assert.equal((await library.listArticles()).length, articleCount);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});
