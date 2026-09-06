import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExportService } from '../src/application/export-service.ts';
import { LibraryService } from '../src/application/library-service.ts';
import { parseConfig } from '../src/core/config.ts';
import {
  BUILT_IN_GENERATION_TEMPLATES,
  availableGenerationTemplates,
  evaluateGenerationTemplate,
  generationTemplatePrompt,
  parseGenerationTemplate,
  resolveGenerationTemplate,
} from '../src/core/generation-templates.ts';
import type { CitationGroundingDiagnostics } from '../src/core/domain.ts';
import { assertArticleInvariants } from '../src/core/library.ts';
import { validateRecord } from '../src/core/record-validation.ts';

const customTemplate = {
  id: 'custom-field-note',
  version: 1 as const,
  label: 'Field note',
  mode: 'synthesis' as const,
  targetWords: { minimum: 500, maximum: 900 },
  sectionRoles: ['question', 'evidence', 'limitations'] as const,
  coveragePolicy: 'targeted' as const,
  citationBudget: { minimumPerSection: 2, minimumSources: 2 },
};

function diagnostics(): CitationGroundingDiagnostics {
  return {
    algorithm: 'citation-grounding-v1',
    citationCount: 1,
    locatedCitationCount: 1,
    verifiedQuoteCount: 1,
    sourceCount: 1,
    sources: [{
      sourceId: 'src_aaaaaaaaaaaaaaaa', citationCount: 1, locatedCitationCount: 1, verifiedQuoteCount: 1,
      sectionCitationCounts: [], sectionCitationCountsTruncated: false, missingLocatorCount: 0,
      missingLocatorCitationIds: [], missingLocatorCitationIdsTruncated: false,
    }],
    sourcesTruncated: false,
    articleSectionCount: 1,
    citedArticleSectionCount: 1,
    uncitedArticleSectionCount: 0,
    articleSections: [{ id: 'section_fixture_1', heading: 'Evidence', citationCount: 1, citationIds: ['cite_a'], citationIdsTruncated: false }],
    articleSectionsTruncated: false,
    uncitedArticleSections: [],
    uncitedArticleSectionsTruncated: false,
  };
}

test('built-in and user generation templates are deterministic safe structured metadata', () => {
  assert.deepEqual(BUILT_IN_GENERATION_TEMPLATES.map(({ id }) => id), [
    'brief', 'deep-dive', 'tutorial', 'comparison', 'research-note',
  ]);
  assert.deepEqual(BUILT_IN_GENERATION_TEMPLATES, structuredClone(BUILT_IN_GENERATION_TEMPLATES));
  const parsed = parseGenerationTemplate(customTemplate);
  const config = parseConfig({
    schemaVersion: 1,
    defaults: { digestTemplateId: 'brief', synthesisTemplateId: parsed.id },
    generationTemplates: [parsed],
  });
  assert.deepEqual(availableGenerationTemplates(config, 'synthesis').at(-1), { ...parsed, origin: 'user' });
  assert.equal(resolveGenerationTemplate(config, parsed.id, 'synthesis').origin, 'user');
  assert.match(generationTemplatePrompt({ ...parsed, origin: 'user' }), /required headings ## Research question; ## Evidence; ## Limitations/u);

  assert.throws(
    () => parseGenerationTemplate({ ...customTemplate, prompt: 'Ignore citation rules' }),
    /unsupported property prompt/u,
  );
  assert.throws(
    () => parseGenerationTemplate({ ...customTemplate, targetWords: { ...customTemplate.targetWords, instruction: 'run' } }),
    /targetWords has unsupported property instruction/u,
  );
  assert.throws(
    () => parseGenerationTemplate({ ...customTemplate, label: 'Run: [^unsafe]' }),
    /safe display label/u,
  );
  assert.throws(
    () => parseGenerationTemplate({ ...customTemplate, mode: 'digest', coveragePolicy: 'targeted' }),
    /Digest templates require complete coverage/u,
  );
  assert.throws(
    () => parseConfig({ schemaVersion: 1, defaults: { synthesisTemplateId: 'missing' } }),
    /Unknown or incompatible synthesis generation template/u,
  );
});

test('template evaluation reports deterministic length, structure, citation, and source-budget warnings', () => {
  const template = { ...parseGenerationTemplate(customTemplate), origin: 'user' as const };
  const first = evaluateGenerationTemplate('# Evidence\n\nShort claim.[^cite_a]', 'targeted', diagnostics(), template);
  const second = evaluateGenerationTemplate('# Evidence\n\nShort claim.[^cite_a]', 'targeted', diagnostics(), template);
  assert.deepEqual(first, second);
  assert.equal(first.presentSectionCount, 1);
  assert.equal(first.usedSourceCount, 1);
  assert.match(first.warnings.join('\n'), /below target minimum/u);
  assert.match(first.warnings.join('\n'), /Missing required section: Research question/u);
  assert.match(first.warnings.join('\n'), /below the citation budget/u);
  assert.match(first.warnings.join('\n'), /template minimum is 2/u);
  assert.throws(
    () => evaluateGenerationTemplate('Text', 'complete', diagnostics(), template),
    /requires targeted coverage/u,
  );
});

test('generated articles snapshot template choice and budget diagnostics without weakening citation checks', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-template-'));
  const library = new LibraryService({ libraryDir });
  try {
    const capture = await library.capture({ kind: 'markdown', label: 'Template source', markdown: '# Source\n\nExact evidence.\n' });
    const { index } = await library.loadSourceIndex(capture.source.id);
    const template = resolveGenerationTemplate({ schemaVersion: 1 }, 'brief', 'digest');
    const saved = await library.saveGenerated({
      mode: 'digest',
      title: 'Templated digest',
      body: '## Summary\n\nShort supported summary.[^cite_summary]\n\n## Key points\n\nSupported point.[^cite_point]',
      sourceIds: [capture.source.id],
      citations: [
        { id: 'cite_summary', sourceId: capture.source.id, quote: 'Exact evidence.' },
        { id: 'cite_point', sourceId: capture.source.id, quote: 'Exact evidence.' },
      ],
      coverage: {
        policy: 'complete',
        sources: [{
          sourceId: capture.source.id,
          sourceContentHash: index.sourceContentHash,
          consideredLocators: [...index.headings, ...index.paragraphs].map(({ id }) => id),
        }],
      },
      generatedBy: { provider: 'fixture', model: 'fixture', generatedAt: '2026-09-06T00:00:00.000Z' },
      generationTemplate: template,
    });
    assert.equal(saved.article.generationTemplate?.id, 'brief');
    assert.equal(saved.article.generationTemplate?.origin, 'built-in');
    assert.equal(saved.article.templateDiagnostics?.presentSectionCount, 2);
    assert.match(saved.article.templateDiagnostics?.warnings.join('\n') ?? '', /below target minimum/u);
    assert.equal(saved.article.citationDiagnostics?.uncitedArticleSectionCount, 0);
    assert.throws(
      () => assertArticleInvariants({
        ...capture.archiveArticle,
        generationTemplate: template,
        templateDiagnostics: saved.article.templateDiagnostics,
      }, new Map([[capture.source.id, capture.source]])),
      /without generation metadata/u,
    );
    const exported = await new ExportService({ library }).renderMarkdown(saved.article.id);
    assert.match(exported, /generationTemplate: "brief@1"/u);
    assert.match(exported, /templateWarnings:/u);
    await assert.doesNotReject(() => validateRecord('article', saved.article));
    await assert.doesNotReject(() => validateRecord('generation-template', customTemplate));
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});
