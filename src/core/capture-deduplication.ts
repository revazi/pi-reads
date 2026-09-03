import type { IngestedSourceDraft, SourceRecord } from './domain.ts';

export type CaptureMatch =
  | { status: 'exact-duplicate'; matchedBy: 'canonical-url' | 'content-hash'; source: SourceRecord }
  | { status: 'changed-content'; matchedBy: 'canonical-url'; source: SourceRecord };

function newest(sources: readonly SourceRecord[]): SourceRecord | undefined {
  return [...sources].sort((left, right) =>
    right.capturedAt.localeCompare(left.capturedAt) || right.id.localeCompare(left.id))[0];
}

export function detectCaptureMatch(
  draft: IngestedSourceDraft,
  sources: readonly SourceRecord[],
): CaptureMatch | undefined {
  if (draft.canonicalUrl) {
    const canonicalMatches = sources.filter((source) => source.origin.canonicalUrl === draft.canonicalUrl);
    const canonicalExact = newest(canonicalMatches.filter((source) => source.content.contentHash === draft.contentHash));
    if (canonicalExact) return { status: 'exact-duplicate', matchedBy: 'canonical-url', source: canonicalExact };
    const canonicalChanged = newest(canonicalMatches);
    if (canonicalChanged) return { status: 'changed-content', matchedBy: 'canonical-url', source: canonicalChanged };
  }

  const contentMatch = newest(sources.filter((source) => source.content.contentHash === draft.contentHash));
  return contentMatch
    ? { status: 'exact-duplicate', matchedBy: 'content-hash', source: contentMatch }
    : undefined;
}

export function sourceLineage(
  match: CaptureMatch,
): NonNullable<SourceRecord['lineage']> {
  return {
    predecessorSourceId: match.source.id,
    rootSourceId: match.source.lineage?.rootSourceId ?? match.source.id,
    reason: match.status === 'changed-content' ? 'content-changed' : 'explicit-duplicate',
    matchedBy: match.matchedBy,
  };
}
