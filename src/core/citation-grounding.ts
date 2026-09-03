import { marked } from 'marked';
import type {
  Citation,
  CitationGroundingDiagnostics,
  CitationGroundingSourceDiagnostics,
  SourceRecord,
} from './domain.ts';
import {
  verifySourceContentIndex,
  type IndexedSourceHeading,
  type SourceContentIndex,
} from './source-index.ts';
import { versionedSha256 } from './text.ts';

const MAX_DIAGNOSTIC_ITEMS = 20;
const STABLE_LOCATOR_PATTERN = /^[hp]_[a-f0-9]{16}_[1-9][0-9]*$/u;

export interface CitationGroundingSource {
  source: SourceRecord;
  index: SourceContentIndex;
  content: string;
}

interface ByteRange {
  startByte: number;
  endByte: number;
}

interface ResolvedCitation {
  locator?: string;
  quoteVerified: boolean;
}

interface ArticleSection {
  id: string;
  heading?: string;
  headingTruncated?: boolean;
  citationIds: string[];
  citationCount: number;
  citationIdsTruncated: boolean;
}

function headingSection(index: SourceContentIndex, heading: IndexedSourceHeading): ByteRange {
  const next = index.headings
    .filter((candidate) => candidate.startByte > heading.startByte && candidate.level <= heading.level)
    .sort((left, right) => left.startByte - right.startByte)[0];
  return { startByte: heading.startByte, endByte: next?.startByte ?? index.byteLength };
}

function rangeForStableLocator(index: SourceContentIndex, locator: string, citationId: string): ByteRange {
  const heading = index.headings.find((candidate) => candidate.id === locator);
  if (heading) return heading;
  const paragraph = index.paragraphs.find((candidate) => candidate.id === locator);
  if (paragraph) return paragraph;
  throw new Error(`Citation ${citationId} references unknown source locator ${locator}`);
}

function fragmentRange(index: SourceContentIndex, fragment: string, citationId: string): ByteRange & { locator: string } {
  const [startLocator, endLocator, ...extra] = fragment.split('..');
  if (
    extra.length > 0 ||
    !startLocator ||
    !STABLE_LOCATOR_PATTERN.test(startLocator) ||
    (endLocator !== undefined && !STABLE_LOCATOR_PATTERN.test(endLocator))
  ) {
    throw new Error(`Citation ${citationId} has invalid source locator fragment ${fragment}`);
  }
  const start = rangeForStableLocator(index, startLocator, citationId);
  const end = endLocator ? rangeForStableLocator(index, endLocator, citationId) : start;
  if (end.startByte < start.startByte) {
    throw new Error(`Citation ${citationId} source locator range is reversed: ${fragment}`);
  }
  return { startByte: start.startByte, endByte: end.endByte, locator: fragment };
}

function headingRange(index: SourceContentIndex, headingText: string, citationId: string): ByteRange & { locator: string } {
  const matches = index.headings.filter((heading) => heading.text === headingText);
  if (matches.length === 0) throw new Error(`Citation ${citationId} references unknown source heading ${headingText}`);
  if (matches.length > 1) {
    throw new Error(`Citation ${citationId} source heading is ambiguous; use a stable fragment locator`);
  }
  return { ...headingSection(index, matches[0]!), locator: matches[0]!.id };
}

function paragraphRange(index: SourceContentIndex, paragraphNumber: number, citationId: string): ByteRange & { locator: string } {
  const paragraph = index.paragraphs[paragraphNumber - 1];
  if (!paragraph) throw new Error(`Citation ${citationId} references unknown source paragraph ${paragraphNumber}`);
  return { ...paragraph, locator: paragraph.id };
}

function rangesOverlap(left: ByteRange, right: ByteRange): boolean {
  return Math.max(left.startByte, right.startByte) < Math.min(left.endByte, right.endByte);
}

type LocatedByteRange = ByteRange & { locator: string };

function citationLocatorRanges(citation: Citation, index: SourceContentIndex): LocatedByteRange[] {
  const ranges: LocatedByteRange[] = [];
  const locator = citation.locator;
  if (locator?.fragment) ranges.push(fragmentRange(index, locator.fragment, citation.id));
  if (locator?.paragraph !== undefined) ranges.push(paragraphRange(index, locator.paragraph, citation.id));
  if (locator?.heading) ranges.push(headingRange(index, locator.heading, citation.id));
  return ranges;
}

function intersectLocatorRanges(ranges: readonly LocatedByteRange[], citationId: string): ByteRange | undefined {
  const first = ranges[0];
  if (!first) return undefined;
  for (const range of ranges.slice(1)) {
    if (!rangesOverlap(first, range)) {
      throw new Error(`Citation ${citationId} locator fields resolve to different source sections`);
    }
  }
  const intersection = ranges.slice(1).reduce<ByteRange>((current, range) => ({
    startByte: Math.max(current.startByte, range.startByte),
    endByte: Math.min(current.endByte, range.endByte),
  }), first);
  if (intersection.endByte <= intersection.startByte) {
    throw new Error(`Citation ${citationId} locator fields resolve to different source sections`);
  }
  return intersection;
}

function verifyCitationQuote(
  citation: Citation,
  sourceContent: string,
  supportRange: ByteRange | undefined,
  locator: string | undefined,
): boolean {
  if (citation.quote === undefined) return false;
  if (!citation.quote) throw new Error(`Citation ${citation.id} quote must not be empty`);
  const support = supportRange
    ? Buffer.from(sourceContent).subarray(supportRange.startByte, supportRange.endByte).toString('utf8')
    : sourceContent;
  if (!support.includes(citation.quote)) {
    const context = locator ? ` within locator ${locator}` : '';
    throw new Error(`Citation ${citation.id} quote is not exact immutable source text${context}`);
  }
  return true;
}

function resolveCitation(citation: Citation, source: CitationGroundingSource): ResolvedCitation {
  const resolutions = citationLocatorRanges(citation, source.index);
  const locator = resolutions[0]?.locator;
  const supportRange = intersectLocatorRanges(resolutions, citation.id);
  const quoteVerified = verifyCitationQuote(citation, source.content, supportRange, locator);
  return { ...(locator ? { locator } : {}), quoteVerified };
}

function sectionId(raw: string, occurrences: Map<string, number>): string {
  const digest = versionedSha256(raw).slice('sha256:'.length, 'sha256:'.length + 12);
  const occurrence = (occurrences.get(digest) ?? 0) + 1;
  occurrences.set(digest, occurrence);
  return `section_${digest}_${occurrence}`;
}

function boundedHeading(heading: string): { heading: string; headingTruncated?: boolean } {
  const characters = [...heading];
  return characters.length > 160
    ? { heading: `${characters.slice(0, 159).join('')}…`, headingTruncated: true }
    : { heading };
}

function citationIds(markdown: string): string[] {
  return [...markdown.matchAll(/\[\^(cite_[a-z0-9][a-z0-9_-]{0,63})\](?!:)/giu)].map((match) => match[1]!);
}

function articleSections(markdown: string): ArticleSection[] {
  const sections: Array<{ heading?: string; raw: string }> = [];
  let current: { heading?: string; raw: string } | undefined;
  for (const token of marked.lexer(markdown)) {
    if (token.type === 'space') {
      if (current) current.raw += token.raw;
      continue;
    }
    if (token.type === 'heading') {
      if (current?.raw.trim()) sections.push(current);
      current = { heading: token.text, raw: token.raw };
      continue;
    }
    current ??= { raw: '' };
    current.raw += token.raw;
  }
  if (current?.raw.trim()) sections.push(current);

  const occurrences = new Map<string, number>();
  return sections.map((section) => {
    const markers = citationIds(section.raw);
    const uniqueCitationIds = [...new Set(markers)];
    return {
      id: sectionId(section.raw, occurrences),
      ...(section.heading ? boundedHeading(section.heading) : {}),
      citationIds: uniqueCitationIds.slice(0, MAX_DIAGNOSTIC_ITEMS),
      citationCount: markers.length,
      citationIdsTruncated: uniqueCitationIds.length > MAX_DIAGNOSTIC_ITEMS,
    };
  });
}

function sourceDiagnostics(
  sourceId: string,
  citations: readonly Citation[],
  resolved: ReadonlyMap<string, ResolvedCitation>,
): CitationGroundingSourceDiagnostics {
  const sourceCitations = citations.filter((citation) => citation.sourceId === sourceId);
  const sectionCounts = new Map<string, number>();
  const missingLocatorCitationIds: string[] = [];
  let verifiedQuoteCount = 0;
  for (const citation of sourceCitations) {
    const grounding = resolved.get(citation.id)!;
    if (grounding.locator) sectionCounts.set(grounding.locator, (sectionCounts.get(grounding.locator) ?? 0) + 1);
    else missingLocatorCitationIds.push(citation.id);
    if (grounding.quoteVerified) verifiedQuoteCount += 1;
  }
  const sectionCitationCounts = [...sectionCounts].map(([locator, citationCount]) => ({ locator, citationCount }));
  return {
    sourceId,
    citationCount: sourceCitations.length,
    locatedCitationCount: sourceCitations.length - missingLocatorCitationIds.length,
    verifiedQuoteCount,
    sectionCitationCounts: sectionCitationCounts.slice(0, MAX_DIAGNOSTIC_ITEMS),
    sectionCitationCountsTruncated: sectionCitationCounts.length > MAX_DIAGNOSTIC_ITEMS,
    missingLocatorCount: missingLocatorCitationIds.length,
    missingLocatorCitationIds: missingLocatorCitationIds.slice(0, MAX_DIAGNOSTIC_ITEMS),
    missingLocatorCitationIdsTruncated: missingLocatorCitationIds.length > MAX_DIAGNOSTIC_ITEMS,
  };
}

export function verifyCitationGrounding(
  markdown: string,
  citations: readonly Citation[],
  sources: ReadonlyMap<string, CitationGroundingSource>,
): CitationGroundingDiagnostics {
  for (const [sourceId, source] of sources) {
    if (source.source.id !== sourceId || source.index.sourceId !== sourceId) {
      throw new Error(`Citation grounding source identity mismatch for ${sourceId}`);
    }
    verifySourceContentIndex(source.source, source.content, source.index);
  }
  const resolved = new Map<string, ResolvedCitation>();
  for (const citation of citations) {
    const source = sources.get(citation.sourceId);
    if (!source) throw new Error(`Citation ${citation.id} references an unavailable source`);
    resolved.set(citation.id, resolveCitation(citation, source));
  }

  const sections = articleSections(markdown);
  const uncitedSections = sections.filter((section) => section.citationCount === 0);
  const diagnosticsSections = sections.map(({
    id,
    heading,
    headingTruncated,
    citationIds: ids,
    citationCount,
    citationIdsTruncated,
  }) => ({
    id,
    ...(heading ? { heading } : {}),
    ...(headingTruncated ? { headingTruncated: true } : {}),
    citationCount,
    citationIds: ids,
    citationIdsTruncated,
  }));
  const sourceSummaries = [...sources.keys()].map((sourceId) => sourceDiagnostics(sourceId, citations, resolved));
  return {
    algorithm: 'citation-grounding-v1',
    citationCount: citations.length,
    locatedCitationCount: [...resolved.values()].filter(({ locator }) => locator !== undefined).length,
    verifiedQuoteCount: [...resolved.values()].filter(({ quoteVerified }) => quoteVerified).length,
    sourceCount: sourceSummaries.length,
    sources: sourceSummaries.slice(0, MAX_DIAGNOSTIC_ITEMS),
    sourcesTruncated: sourceSummaries.length > MAX_DIAGNOSTIC_ITEMS,
    articleSectionCount: sections.length,
    citedArticleSectionCount: sections.length - uncitedSections.length,
    uncitedArticleSectionCount: uncitedSections.length,
    articleSections: diagnosticsSections.slice(0, MAX_DIAGNOSTIC_ITEMS),
    articleSectionsTruncated: diagnosticsSections.length > MAX_DIAGNOSTIC_ITEMS,
    uncitedArticleSections: uncitedSections.slice(0, MAX_DIAGNOSTIC_ITEMS).map(({
      id,
      heading,
      headingTruncated,
    }) => ({
      id,
      ...(heading ? { heading } : {}),
      ...(headingTruncated ? { headingTruncated: true } : {}),
    })),
    uncitedArticleSectionsTruncated: uncitedSections.length > MAX_DIAGNOSTIC_ITEMS,
  };
}
