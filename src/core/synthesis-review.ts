import type {
  Citation,
  CitationGroundingDiagnostics,
  GeneratedBy,
  GenerationTemplateDiagnostics,
  GenerationTemplateSnapshot,
  Sha256Digest,
} from './domain.ts';
import type { SourceCoverageInput } from './source-coverage.ts';
import { versionedSha256 } from './text.ts';

const MIN_MULTI_SOURCE_SYNTHESIS_SOURCES = 2;
export const MAX_MULTI_SOURCE_SYNTHESIS_SOURCES = 20;

export interface MultiSourceSynthesisReviewInput {
  mode: 'synthesis';
  title: string;
  slug?: string;
  description?: string;
  body: string;
  sourceIds: string[];
  citations: Citation[];
  coverage: SourceCoverageInput;
  generatedBy: GeneratedBy;
  generationTemplate?: GenerationTemplateSnapshot;
}

export interface MultiSourceSynthesisReview {
  algorithm: 'multi-source-synthesis-review-v1';
  reviewToken: Sha256Digest;
  selectedSourceIds: string[];
  usedSourceIds: string[];
  unusedSourceIds: string[];
  citationDistribution: Array<{ sourceId: string; citationCount: number }>;
  citationCount: number;
  articleSectionCount: number;
  uncitedArticleSectionCount: number;
  templateDiagnostics?: GenerationTemplateDiagnostics;
}

export function assertOrderedSourceSelection(
  sourceIds: readonly string[],
  options: { minimum?: number; maximum?: number } = {},
): string[] {
  const minimum = options.minimum ?? 1;
  const maximum = options.maximum ?? MAX_MULTI_SOURCE_SYNTHESIS_SOURCES;
  if (sourceIds.length < minimum || sourceIds.length > maximum) {
    throw new Error(`Source selection requires ${minimum}–${maximum} sources`);
  }
  const unique = new Set(sourceIds);
  if (unique.size !== sourceIds.length) {
    throw new Error('Source selection must not repeat a source ID');
  }
  return [...sourceIds];
}

function canonicalCitation(citation: Citation) {
  const locator = citation.locator ? {
    ...(citation.locator.url !== undefined ? { url: citation.locator.url } : {}),
    ...(citation.locator.heading !== undefined ? { heading: citation.locator.heading } : {}),
    ...(citation.locator.paragraph !== undefined ? { paragraph: citation.locator.paragraph } : {}),
    ...(citation.locator.fragment !== undefined ? { fragment: citation.locator.fragment } : {}),
  } : undefined;
  return {
    id: citation.id,
    sourceId: citation.sourceId,
    ...(locator ? { locator } : {}),
    ...(citation.quote !== undefined ? { quote: citation.quote } : {}),
    ...(citation.note !== undefined ? { note: citation.note } : {}),
  };
}

function reviewToken(input: MultiSourceSynthesisReviewInput): Sha256Digest {
  const generationIdentity = {
    provider: input.generatedBy.provider,
    model: input.generatedBy.model,
    ...(input.generatedBy.thinkingLevel !== undefined ? { thinkingLevel: input.generatedBy.thinkingLevel } : {}),
    ...(input.generatedBy.sessionId !== undefined ? { sessionId: input.generatedBy.sessionId } : {}),
  };
  return versionedSha256(JSON.stringify({
    algorithm: 'multi-source-synthesis-review-v1',
    mode: input.mode,
    title: input.title,
    ...(input.slug ? { slug: input.slug } : {}),
    ...(input.description ? { description: input.description } : {}),
    body: input.body,
    sourceIds: input.sourceIds,
    citations: input.citations.map(canonicalCitation),
    coverage: {
      policy: input.coverage.policy,
      sources: input.coverage.sources.map((source) => ({
        sourceId: source.sourceId,
        sourceContentHash: source.sourceContentHash,
        consideredLocators: source.consideredLocators,
      })),
    },
    ...(input.generationTemplate ? { generationTemplate: input.generationTemplate } : {}),
    generatedBy: generationIdentity,
  }));
}

export function createMultiSourceSynthesisReview(
  input: MultiSourceSynthesisReviewInput,
  diagnostics: CitationGroundingDiagnostics,
  templateDiagnostics?: GenerationTemplateDiagnostics,
): MultiSourceSynthesisReview {
  const selectedSourceIds = assertOrderedSourceSelection(input.sourceIds, {
    minimum: MIN_MULTI_SOURCE_SYNTHESIS_SOURCES,
  });
  if (diagnostics.sourceCount !== selectedSourceIds.length || diagnostics.sourcesTruncated) {
    throw new Error('Multi-source synthesis citation diagnostics do not cover every selected source');
  }
  if (diagnostics.uncitedArticleSectionCount > 0) {
    throw new Error(
      `Multi-source synthesis requires at least one registered citation marker in every non-empty article section; ` +
      `${diagnostics.uncitedArticleSectionCount} of ${diagnostics.articleSectionCount} sections are uncited`,
    );
  }

  const counts = new Map(diagnostics.sources.map((source) => [source.sourceId, source.citationCount]));
  const citationDistribution = selectedSourceIds.map((sourceId) => ({
    sourceId,
    citationCount: counts.get(sourceId) ?? 0,
  }));
  const usedSourceIds = citationDistribution.filter(({ citationCount }) => citationCount > 0).map(({ sourceId }) => sourceId);
  const unusedSourceIds = citationDistribution.filter(({ citationCount }) => citationCount === 0).map(({ sourceId }) => sourceId);

  return {
    algorithm: 'multi-source-synthesis-review-v1',
    reviewToken: reviewToken(input),
    selectedSourceIds,
    usedSourceIds,
    unusedSourceIds,
    citationDistribution,
    citationCount: diagnostics.citationCount,
    articleSectionCount: diagnostics.articleSectionCount,
    uncitedArticleSectionCount: diagnostics.uncitedArticleSectionCount,
    ...(templateDiagnostics ? { templateDiagnostics } : {}),
  };
}
