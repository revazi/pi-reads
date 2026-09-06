import { CaptureRecoveryError } from '../core/record-group.ts';
import type { IngestedSourceDraft } from '../core/domain.ts';
import type { SourceInput, IngestSourceDependencies } from '../core/ingest/index.ts';
import type { CaptureResult, LibraryService } from './library-service.ts';

export const MAX_BATCH_ITEMS = 50;
export const MAX_BATCH_INPUT_BYTES = 1024 * 1024;
export const MAX_BATCH_ITEM_BYTES = 256 * 1024;
const MAX_LOCATOR_BYTES = 8192;
const MAX_LABEL_BYTES = 200;

export type BatchCaptureStatus = 'captured' | 'exact-duplicate' | 'changed-content' | 'failed' | 'cancelled';
export type BatchCaptureOutcome = {
  index: number;
  status: 'captured' | 'exact-duplicate' | 'changed-content';
  sourceId: string;
  archiveArticleId: string;
  /** Library-relative: never source prose or a user-supplied input locator. */
  sourceContentPath: string;
} | {
  index: number;
  status: 'failed' | 'cancelled';
  error: 'invalid-input' | 'capture-failed' | 'cancelled' | 'recovery-required';
};

export interface BatchCaptureResult {
  total: number;
  counts: Record<BatchCaptureStatus, number>;
  outcomes: BatchCaptureOutcome[];
}
export interface BatchCaptureOptions {
  concurrency?: number;
  signal?: AbortSignal;
}

function inputValue(input: SourceInput): string {
  switch (input.kind) {
    case 'url': return input.url;
    case 'file': return input.path;
    case 'text': return input.text;
    case 'markdown': return input.markdown;
  }
}

function inputBytes(input: SourceInput): number {
  if (!input || typeof input !== 'object') return 0;
  const value = inputValue(input);
  const label = 'label' in input ? input.label : undefined;
  return (typeof value === 'string' ? Buffer.byteLength(value) : 0)
    + (typeof label === 'string' ? Buffer.byteLength(label) : 0);
}

function validLabel(input: SourceInput): boolean {
  if (!('label' in input) || input.label === undefined) return true;
  return typeof input.label === 'string' && Buffer.byteLength(input.label) <= MAX_LABEL_BYTES;
}

function validFileCwd(input: SourceInput): boolean {
  if (input.kind !== 'file' || input.cwd === undefined) return true;
  return typeof input.cwd === 'string' && Buffer.byteLength(input.cwd) <= MAX_LOCATOR_BYTES;
}

function validInput(input: SourceInput): boolean {
  if (!input || typeof input !== 'object') return false;
  const value = inputValue(input);
  if (typeof value !== 'string' || !value.trim()) return false;
  const maximum = input.kind === 'url' || input.kind === 'file' ? MAX_LOCATOR_BYTES : MAX_BATCH_ITEM_BYTES;
  if (Buffer.byteLength(value) > maximum) return false;
  return validLabel(input) && validFileCwd(input);
}

function validateBatchSize(count: number, concurrency: number): void {
  if (count < 1 || count > MAX_BATCH_ITEMS) {
    throw new Error('Batch capture requires 1–50 inputs; split larger collections before capture');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error('Batch concurrency must be an integer from 1 to 4');
  }
}

function validateBatch(inputs: readonly SourceInput[], concurrency: number): void {
  if (!Array.isArray(inputs)) throw new Error('Batch capture inputs must be an array');
  validateBatchSize(inputs.length, concurrency);
  if (inputs.reduce((total, input) => total + inputBytes(input), 0) > MAX_BATCH_INPUT_BYTES) {
    throw new Error('Batch input exceeds 1 MiB; split the request or use local files');
  }
}

function captureOutcome(index: number, result: CaptureResult): BatchCaptureOutcome {
  return {
    index,
    status: result.status === 'recaptured' ? 'captured' : result.status,
    sourceId: result.source.id,
    archiveArticleId: result.archiveArticle.id,
    sourceContentPath: result.source.content.path,
  };
}

/** Bounded independent acquisitions; LibraryService serializes duplicate checks and per-item publication. */
export class BatchIngestionService {
  private readonly library: LibraryService;
  private readonly dependencies: IngestSourceDependencies;
  constructor(library: LibraryService, dependencies: IngestSourceDependencies = {}) {
    this.library = library;
    this.dependencies = dependencies;
  }

  private async captureOne(input: SourceInput, index: number, signal?: AbortSignal): Promise<BatchCaptureOutcome> {
    if (signal?.aborted) return { index, status: 'cancelled', error: 'cancelled' };
    if (!validInput(input)) return { index, status: 'failed', error: 'invalid-input' };
    try {
      const result = await this.library.capture(input, this.dependencies, signal);
      // A cancellation during publication cannot relabel a committed source as cancelled.
      return captureOutcome(index, result);
    } catch (error) {
      if (error instanceof CaptureRecoveryError) return { index, status: 'failed', error: 'recovery-required' };
      return signal?.aborted
        ? { index, status: 'cancelled', error: 'cancelled' }
        : { index, status: 'failed', error: 'capture-failed' };
    }
  }

  private async captureDraftOne(draft: IngestedSourceDraft, index: number, signal?: AbortSignal): Promise<BatchCaptureOutcome> {
    if (signal?.aborted) return { index, status: 'cancelled', error: 'cancelled' };
    try {
      return captureOutcome(index, await this.library.captureDraft(draft, signal));
    } catch (error) {
      if (error instanceof CaptureRecoveryError) return { index, status: 'failed', error: 'recovery-required' };
      return signal?.aborted
        ? { index, status: 'cancelled', error: 'cancelled' }
        : { index, status: 'failed', error: 'capture-failed' };
    }
  }

  private async run<T>(
    pending: readonly T[],
    concurrency: number,
    capture: (item: T, index: number, signal: AbortSignal) => Promise<BatchCaptureOutcome>,
    callerSignal?: AbortSignal,
  ): Promise<BatchCaptureResult> {
    const recoveryAbort = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, recoveryAbort.signal]) : recoveryAbort.signal;
    const outcomes: BatchCaptureOutcome[] = new Array(pending.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        const index = next++;
        const outcome = await capture(pending[index]!, index, signal);
        outcomes[index] = outcome;
        if ('error' in outcome && outcome.error === 'recovery-required') recoveryAbort.abort();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
    const counts: BatchCaptureResult['counts'] = {
      captured: 0, 'exact-duplicate': 0, 'changed-content': 0, failed: 0, cancelled: 0,
    };
    for (const outcome of outcomes) counts[outcome.status]++;
    return { total: outcomes.length, counts, outcomes };
  }

  async capture(inputs: readonly SourceInput[], options: BatchCaptureOptions = {}): Promise<BatchCaptureResult> {
    const concurrency = options.concurrency ?? 3;
    validateBatch(inputs, concurrency);
    // Snapshot caller-owned descriptors before awaiting network or filesystem work.
    const pending = inputs.map((input) => input && { ...input });
    return this.run(pending, concurrency, (input, index, signal) => this.captureOne(input, index, signal), options.signal);
  }

  async captureDrafts(drafts: readonly IngestedSourceDraft[], options: BatchCaptureOptions = {}): Promise<BatchCaptureResult> {
    const concurrency = options.concurrency ?? 3;
    if (!Array.isArray(drafts)) throw new Error('Batch capture drafts must be an array');
    validateBatchSize(drafts.length, concurrency);
    const pending = drafts.map((draft) => ({
      ...draft,
      ...(draft.authors ? { authors: [...draft.authors] } : {}),
      capture: { ...draft.capture },
    }));
    return this.run(pending, concurrency, (draft, index, signal) => this.captureDraftOne(draft, index, signal), options.signal);
  }
}
