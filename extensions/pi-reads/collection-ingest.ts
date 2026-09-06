import type { Sha256Digest } from '../../src/core/domain.ts';
import type { LibraryService } from '../../src/application/library-service.ts';

export interface CollectionToolRequest {
  kind: 'feed' | 'newsletter';
  value: string;
  selection?: number[];
  previewToken?: string;
}

export async function executeCollectionIngest(
  request: CollectionToolRequest,
  library: LibraryService,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
  const { CollectionIngestionService } = await import('../../src/application/collection-ingestion-service.ts');
  const service = new CollectionIngestionService(library);
  const input = request.kind === 'feed'
    ? { kind: 'feed' as const, url: request.value }
    : { kind: 'newsletter' as const, path: request.value.replace(/^@/u, ''), cwd };
  if (request.selection === undefined && request.previewToken === undefined) {
    const preview = await service.preview(input, signal);
    return {
      content: [{ type: 'text', text: JSON.stringify({
        notice: 'Preview only; no source or article records were created. Explicitly choose entry indexes, then repeat with this previewToken and selection.',
        mailbox: 'Local .eml files only; mailbox credentials and remote mailbox access are unsupported.',
        ...preview,
      }) }],
      details: {
        kind: preview.kind,
        entryCount: preview.entryCount,
        totalEntryCount: preview.totalEntryCount,
        entriesTruncated: preview.entriesTruncated,
        previewToken: preview.previewToken,
        persisted: false,
      },
    };
  }
  if (!request.selection || !request.previewToken) {
    throw new Error('Collection capture requires both selection and previewToken from a prior preview');
  }
  const captured = await service.capture(input, request.selection, request.previewToken as Sha256Digest, signal);
  return {
    content: [{ type: 'text', text: JSON.stringify({
      notice: 'Only explicitly selected entries were processed. Successful items remain; collection capture never recaptures changed content.',
      paths: 'library-relative; use reads_library for source retrieval',
      ...captured,
    }) }],
    details: {
      kind: captured.kind,
      selectedIndexes: captured.selectedIndexes,
      total: captured.total,
      counts: captured.counts,
    },
  };
}
