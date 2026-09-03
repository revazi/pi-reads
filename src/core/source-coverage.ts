import type {
  ArticleMode,
  Sha256Digest,
  SourceCoveragePolicy,
  SourceCoverageSummary,
} from './domain.ts';
import {
  SOURCE_CONTENT_INDEX_ALGORITHM,
  type SourceContentIndex,
} from './source-index.ts';
import { versionedSha256 } from './text.ts';

const MAX_MISSING_LOCATOR_DIAGNOSTICS = 20;

export interface SourceCoverageEvidence {
  sourceId: string;
  sourceContentHash: Sha256Digest;
  consideredLocators: string[];
}

export interface SourceCoverageInput {
  policy: SourceCoveragePolicy;
  sources: SourceCoverageEvidence[];
}

function orderedLocators(index: SourceContentIndex): string[] {
  return [
    ...index.headings.map(({ id, startByte }) => ({ id, startByte })),
    ...index.paragraphs.map(({ id, startByte }) => ({ id, startByte })),
  ].sort((left, right) => left.startByte - right.startByte).map(({ id }) => id);
}

function locatorHash(locators: readonly string[]): Sha256Digest {
  return versionedSha256(locators.join('\n'));
}

function evidenceBySource(input: SourceCoverageInput): Map<string, SourceCoverageEvidence> {
  const evidence = new Map<string, SourceCoverageEvidence>();
  for (const source of input.sources) {
    if (evidence.has(source.sourceId)) throw new Error(`Duplicate coverage evidence for ${source.sourceId}`);
    evidence.set(source.sourceId, source);
  }
  return evidence;
}

function summarizeSourceCoverage(
  sourceId: string,
  index: SourceContentIndex,
  sourceEvidence: SourceCoverageEvidence,
  policy: SourceCoveragePolicy,
): SourceCoverageSummary['sources'][number] {
  if (sourceEvidence.sourceContentHash !== index.sourceContentHash) {
    throw new Error(`Coverage evidence content hash mismatch for ${sourceId}`);
  }
  if (sourceEvidence.consideredLocators.length === 0) {
    throw new Error(`Coverage evidence for ${sourceId} must include at least one considered locator`);
  }
  const expectedLocators = orderedLocators(index);
  const expected = new Set(expectedLocators);
  const considered = new Set<string>();
  for (const locator of sourceEvidence.consideredLocators) {
    if (!expected.has(locator)) throw new Error(`Coverage evidence for ${sourceId} contains unknown locator ${locator}`);
    if (considered.has(locator)) throw new Error(`Coverage evidence for ${sourceId} repeats locator ${locator}`);
    considered.add(locator);
  }
  const canonicalConsidered = expectedLocators.filter((locator) => considered.has(locator));
  const missing = expectedLocators.filter((locator) => !considered.has(locator));
  if (policy === 'complete' && missing.length > 0) {
    const examples = missing.slice(0, MAX_MISSING_LOCATOR_DIAGNOSTICS).join(', ');
    const suffix = missing.length > MAX_MISSING_LOCATOR_DIAGNOSTICS ? ', …' : '';
    throw new Error(
      `Complete coverage for ${sourceId} is missing ${missing.length} of ${expectedLocators.length} indexed sections: ${examples}${suffix}`,
    );
  }
  return {
    sourceId,
    sourceContentHash: index.sourceContentHash,
    indexAlgorithm: SOURCE_CONTENT_INDEX_ALGORITHM,
    indexLocatorHash: locatorHash(expectedLocators),
    consideredLocatorHash: locatorHash(canonicalConsidered),
    consideredLocatorCount: canonicalConsidered.length,
    totalLocatorCount: expectedLocators.length,
    missingLocatorCount: missing.length,
    missingLocators: missing.slice(0, MAX_MISSING_LOCATOR_DIAGNOSTICS),
    missingLocatorsTruncated: missing.length > MAX_MISSING_LOCATOR_DIAGNOSTICS,
  };
}

export function verifySourceCoverage(
  mode: Exclude<ArticleMode, 'archive'>,
  sourceIds: readonly string[],
  indexes: ReadonlyMap<string, SourceContentIndex>,
  input: SourceCoverageInput,
): SourceCoverageSummary {
  if (input.policy !== 'complete' && input.policy !== 'targeted') {
    throw new Error(`Unknown source coverage policy: ${String(input.policy)}`);
  }
  if (input.policy === 'targeted' && mode === 'digest') {
    throw new Error('A targeted article cannot be saved as a digest; use complete coverage or synthesis');
  }
  const evidence = evidenceBySource(input);
  const expectedSourceIds = new Set(sourceIds);
  for (const sourceId of evidence.keys()) {
    if (!expectedSourceIds.has(sourceId)) throw new Error(`Coverage evidence references undeclared source ${sourceId}`);
  }
  const summaries: SourceCoverageSummary['sources'] = [];
  for (const sourceId of sourceIds) {
    const index = indexes.get(sourceId);
    if (!index) throw new Error(`Missing source index for coverage verification: ${sourceId}`);
    const sourceEvidence = evidence.get(sourceId);
    if (!sourceEvidence) throw new Error(`Missing coverage evidence for ${sourceId}`);
    summaries.push(summarizeSourceCoverage(sourceId, index, sourceEvidence, input.policy));
  }
  return {
    policy: input.policy,
    ...(input.policy === 'targeted'
      ? { warning: 'Targeted coverage considered selected source sections only; this article is not a comprehensive digest.' }
      : {}),
    sources: summaries,
  };
}
