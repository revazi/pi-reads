import type { LibraryService } from '../../src/application/library-service.ts';
import { sourceInput } from './operations.ts';

export interface BatchToolItem { kind: 'url' | 'text' | 'markdown' | 'file' | 'transcript'; value: string; label?: string }

export async function executeBatchIngest(
  items: readonly BatchToolItem[], library: LibraryService, cwd: string, signal?: AbortSignal,
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
  const { BatchIngestionService } = await import('../../src/application/batch-ingestion-service.ts');
  const inputs = items.map((item) => sourceInput(item.kind, item.value, item.label, cwd));
  const result = await new BatchIngestionService(library).capture(inputs, { signal });
  return {
    content: [{ type: 'text', text: JSON.stringify({
      paths: 'library-relative; use reads_library for source retrieval',
      notice: 'Successful items remain. Changed-content requires individual user-approved recapture. Recovery-required means stop writers and inspect the library before retrying.',
      ...result,
    }) }],
    // Do not duplicate the per-item rows in persistent context.
    details: { total: result.total, counts: result.counts },
  };
}
