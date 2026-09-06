import path from 'node:path';
import type { IngestedSourceDraft, Sha256Digest } from '../core/domain.ts';
import { fetchFeedXml } from '../core/ingest/feed-fetch.ts';
import { parseFeed } from '../core/ingest/feed.ts';
import { ingestNewsletterFile } from '../core/ingest/newsletter.ts';
import { versionedSha256 } from '../core/text.ts';
import { BatchIngestionService, type BatchCaptureResult } from './batch-ingestion-service.ts';
import type { CaptureDraftPreview, LibraryService } from './library-service.ts';

export type CollectionInput =
  | { kind: 'feed'; url: string }
  | { kind: 'newsletter'; path: string; cwd?: string };

export type CollectionEntryStatus = CaptureDraftPreview['status'] | 'duplicate-in-preview' | 'changed-in-preview';

export interface CollectionPreviewEntry {
  index: number;
  title: string;
  sourceKind: 'feed' | 'newsletter';
  canonicalUrl?: string;
  publishedAt?: string;
  status: CollectionEntryStatus;
  matchedBy?: 'canonical-url' | 'content-hash';
  existingSourceId?: string;
  duplicateOfIndex?: number;
}

export interface CollectionPreview {
  algorithm: 'collection-ingestion-preview-v1';
  kind: CollectionInput['kind'];
  title?: string;
  entryCount: number;
  totalEntryCount: number;
  entriesTruncated: boolean;
  entries: CollectionPreviewEntry[];
  previewToken: Sha256Digest;
}

export interface CollectionCaptureResult extends BatchCaptureResult {
  kind: CollectionInput['kind'];
  selectedIndexes: number[];
}

export interface CollectionIngestionDependencies {
  fetchFeedXml?: (url: string, signal?: AbortSignal) => Promise<string>;
  ingestNewsletterFile?: (filePath: string, cwd: string, signal?: AbortSignal) => Promise<IngestedSourceDraft>;
}

interface ResolvedCollection {
  kind: CollectionInput['kind'];
  title?: string;
  collectionHash: Sha256Digest;
  totalEntryCount: number;
  entriesTruncated: boolean;
  drafts: IngestedSourceDraft[];
}

function collectionLocator(value: string): string {
  if (!value.trim() || Buffer.byteLength(value) > 8192) throw new Error('Collection locator must contain 1–8192 bytes');
  return value;
}

function bounded(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  return [...value.replace(/\s+/gu, ' ').trim()].slice(0, maximum).join('');
}

function selectionToken(collection: ResolvedCollection): Sha256Digest {
  return versionedSha256(JSON.stringify({
    algorithm: 'collection-ingestion-selection-v1',
    kind: collection.kind,
    collectionHash: collection.collectionHash,
    entries: collection.drafts.map((draft) => ({
      contentHash: draft.contentHash,
      canonicalUrl: draft.canonicalUrl ?? null,
      locatorHash: versionedSha256(draft.locator),
    })),
  }));
}

function duplicateWithin(
  draft: IngestedSourceDraft,
  prior: readonly IngestedSourceDraft[],
): { status: 'duplicate-in-preview' | 'changed-in-preview'; duplicateOfIndex: number } | undefined {
  for (let index = 0; index < prior.length; index += 1) {
    const candidate = prior[index]!;
    if (draft.canonicalUrl && draft.canonicalUrl === candidate.canonicalUrl) {
      return {
        status: draft.contentHash === candidate.contentHash ? 'duplicate-in-preview' : 'changed-in-preview',
        duplicateOfIndex: index,
      };
    }
    if (draft.contentHash === candidate.contentHash) return { status: 'duplicate-in-preview', duplicateOfIndex: index };
  }
  return undefined;
}

function optionalPreviewMetadata(
  draft: IngestedSourceDraft,
  library: CaptureDraftPreview,
  within: ReturnType<typeof duplicateWithin>,
): Partial<CollectionPreviewEntry> {
  return {
    ...(draft.canonicalUrl ? { canonicalUrl: bounded(draft.canonicalUrl, 240)! } : {}),
    ...(draft.publishedAt ? { publishedAt: bounded(draft.publishedAt, 100)! } : {}),
    ...(library.matchedBy ? { matchedBy: library.matchedBy } : {}),
    ...(library.existingSourceId ? { existingSourceId: library.existingSourceId } : {}),
    ...(within ? { duplicateOfIndex: within.duplicateOfIndex } : {}),
  };
}

function previewEntry(
  draft: IngestedSourceDraft,
  index: number,
  library: CaptureDraftPreview,
  prior: readonly IngestedSourceDraft[],
): CollectionPreviewEntry {
  const within = library.status === 'new' ? duplicateWithin(draft, prior) : undefined;
  return {
    index,
    title: bounded(draft.title, 120) ?? `Entry ${index + 1}`,
    sourceKind: draft.kind as 'feed' | 'newsletter',
    status: within?.status ?? library.status,
    ...optionalPreviewMetadata(draft, library, within),
  };
}

function selectedIndexes(selection: readonly number[], maximum: number): number[] {
  if (!Array.isArray(selection) || selection.length < 1 || selection.length > 50) {
    throw new Error('Collection capture requires an explicit selection of 1–50 entry indexes');
  }
  if (!selection.every((index) => Number.isInteger(index) && index >= 0 && index < maximum)) {
    throw new Error('Collection selection contains an unavailable entry index');
  }
  if (new Set(selection).size !== selection.length) throw new Error('Collection selection must not repeat an entry index');
  return [...selection];
}

export class CollectionIngestionService {
  private readonly library: LibraryService;
  private readonly dependencies: CollectionIngestionDependencies;

  constructor(library: LibraryService, dependencies: CollectionIngestionDependencies = {}) {
    this.library = library;
    this.dependencies = dependencies;
  }

  private async resolve(input: CollectionInput, signal?: AbortSignal): Promise<ResolvedCollection> {
    signal?.throwIfAborted();
    if (input.kind === 'feed') {
      const url = collectionLocator(input.url);
      const xml = await (this.dependencies.fetchFeedXml ?? fetchFeedXml)(url, signal);
      const feed = parseFeed(xml, url);
      return {
        kind: 'feed',
        ...(feed.title ? { title: feed.title } : {}),
        collectionHash: feed.collectionHash,
        totalEntryCount: feed.totalEntryCount,
        entriesTruncated: feed.entriesTruncated,
        drafts: feed.drafts,
      };
    }
    const filePath = collectionLocator(input.path);
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const draft = await (this.dependencies.ingestNewsletterFile ?? ingestNewsletterFile)(filePath, cwd, signal);
    return {
      kind: 'newsletter',
      ...(draft.title ? { title: draft.title } : {}),
      collectionHash: versionedSha256(draft.rawContent ?? draft.content),
      totalEntryCount: 1,
      entriesTruncated: false,
      drafts: [draft],
    };
  }

  private async resolvePreview(input: CollectionInput, signal?: AbortSignal): Promise<{
    collection: ResolvedCollection;
    preview: CollectionPreview;
  }> {
    const collection = await this.resolve(input, signal);
    const libraryMatches = await this.library.previewCaptureDrafts(collection.drafts);
    const entries = collection.drafts.map((draft, index) =>
      previewEntry(draft, index, libraryMatches[index]!, collection.drafts.slice(0, index)));
    return {
      collection,
      preview: {
        algorithm: 'collection-ingestion-preview-v1',
        kind: collection.kind,
        ...(collection.title ? { title: bounded(collection.title, 160) } : {}),
        entryCount: entries.length,
        totalEntryCount: collection.totalEntryCount,
        entriesTruncated: collection.entriesTruncated,
        entries,
        previewToken: selectionToken(collection),
      },
    };
  }

  async preview(input: CollectionInput, signal?: AbortSignal): Promise<CollectionPreview> {
    return (await this.resolvePreview({ ...input } as CollectionInput, signal)).preview;
  }

  async capture(
    input: CollectionInput,
    selection: readonly number[],
    previewToken: Sha256Digest,
    signal?: AbortSignal,
  ): Promise<CollectionCaptureResult> {
    const request = { ...input } as CollectionInput;
    const requestedSelection = [...selection];
    const resolved = await this.resolvePreview(request, signal);
    if (resolved.preview.previewToken !== previewToken) {
      throw new Error('Collection changed after preview; preview the current entries again before capture');
    }
    const indexes = selectedIndexes(requestedSelection, resolved.collection.drafts.length);
    const drafts = indexes.map((index) => resolved.collection.drafts[index]!);
    const result = await new BatchIngestionService(this.library).captureDrafts(drafts, { signal });
    const outcomes = result.outcomes.map((outcome) => ({ ...outcome, index: indexes[outcome.index]! }));
    return { kind: resolved.collection.kind, selectedIndexes: indexes, ...result, outcomes };
  }
}
