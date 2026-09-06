import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  deliverKindleWithConfirmation,
  formatBytes,
  openObsidianNote,
  resolveObsidianOverwrite,
  withReadsMutationQueue,
} from './operations.ts';
import type { ReadsServices } from './runtime.ts';

export type ReadsExportFormat = 'markdown' | 'html' | 'pdf' | 'epub';
export type ReadsExportDestination = 'local' | 'obsidian' | 'kindle';
type ReadsExportTarget = { articleId: string; collectionId?: never } | { collectionId: string; articleId?: never };

export type ReadsExportParams = ReadsExportTarget & {
  format?: ReadsExportFormat;
  destination?: ReadsExportDestination;
  overwrite?: boolean;
  open?: boolean;
  send?: boolean;
  preparedExportId?: string;
};

export interface ReadsExportResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

export interface ReadsExportHandlerContext {
  pi: ExtensionAPI;
  services: ReadsServices;
  signal: AbortSignal | undefined;
  ctx: ExtensionContext;
}

export interface ResolvedReadsExportRequest {
  params: ReadsExportParams;
  target: ReadsExportTarget;
  destination: ReadsExportDestination;
  format: ReadsExportFormat;
}

function isArticleTarget(target: ReadsExportTarget): target is { articleId: string; collectionId?: never } {
  return typeof target.articleId === 'string';
}

function targetDetails(target: ReadsExportTarget): Record<string, string> {
  return isArticleTarget(target) ? { articleId: target.articleId } : { collectionId: target.collectionId };
}

export function resolveReadsExportRequest(
  params: ReadsExportParams,
  services: ReadsServices,
): ResolvedReadsExportRequest {
  const targetCount = Number(Boolean(params.articleId)) + Number(Boolean(params.collectionId));
  if (targetCount !== 1) throw new Error('reads_export requires exactly one articleId or collectionId');
  const target: ReadsExportTarget = params.articleId
    ? { articleId: params.articleId }
    : { collectionId: params.collectionId! };
  const destination = params.destination ?? 'local';
  const format = params.format ?? (!isArticleTarget(target)
    ? 'epub'
    : destination === 'kindle' ? services.kindleConfig?.defaultFormat ?? 'epub' : undefined);
  if (!format) throw new Error('format is required for local and Obsidian exports');
  if (!isArticleTarget(target) && (format !== 'epub' || destination === 'obsidian')) {
    throw new Error('Reading collections support only local or Kindle EPUB export');
  }
  if (!isArticleTarget(target) && destination === 'kindle' && !params.preparedExportId) {
    throw new Error('Kindle collection export requires its reviewed preparedExportId');
  }
  if (params.preparedExportId && destination !== 'kindle') throw new Error('preparedExportId is only supported for Kindle exports');
  return { params, target, destination, format };
}

export async function executeLocalExport(
  request: ResolvedReadsExportRequest,
  context: ReadsExportHandlerContext,
): Promise<ReadsExportResult> {
  const { target, format } = request;
  const result = format === 'epub'
    ? await (async () => {
        const epub = await context.services.getEpub();
        return withReadsMutationQueue(context.services.libraryDir, () => isArticleTarget(target)
          ? epub.prepare(target.articleId, context.signal)
          : epub.prepareCollection(target.collectionId, context.signal));
      })()
    : await (async () => {
        if (!isArticleTarget(target)) throw new Error('Non-EPUB local exports require articleId');
        const exports = await context.services.getExports();
        return withReadsMutationQueue(context.services.libraryDir, () => exports.prepare(target.articleId, format, context.signal));
      })();
  return {
    content: [{ type: 'text', text: `Prepared ${result.record.id} (${result.record.format}): ${result.artifactPath}` }],
    details: {
      libraryDir: context.services.libraryDir,
      destination: 'local',
      exportId: result.record.id,
      ...targetDetails(target),
      format: result.record.format,
      artifactPath: result.artifactPath,
      manifestPath: result.manifestPath,
    },
  };
}

export async function executeKindleExport(
  request: ResolvedReadsExportRequest,
  context: ReadsExportHandlerContext,
): Promise<ReadsExportResult> {
  const { params, target, format } = request;
  if (format !== 'epub' && format !== 'pdf') throw new Error('Kindle delivery requires format epub or pdf');
  const kindle = await context.services.getKindle();
  const preview = await withReadsMutationQueue(context.services.libraryDir, () => isArticleTarget(target)
    ? params.preparedExportId
      ? kindle.previewPrepared(target.articleId, format, params.preparedExportId, context.signal)
      : kindle.preview(target.articleId, format, context.signal)
    : kindle.previewPreparedCollection(target.collectionId, params.preparedExportId!, context.signal));
  const previewLines = [
    `Kindle ${params.send ? 'send preview' : 'dry run'} prepared.`,
    `Recipient: ${preview.redactedRecipient}`,
    `Subject: ${preview.subject}`,
    `File: ${preview.artifactPath}`,
    `Size: ${formatBytes(preview.size)}`,
    `Prepared export ID: ${preview.localExportId}`,
    `Content hash: ${preview.contentHash}`,
  ];
  if (!params.send) {
    if (context.ctx.hasUI) {
      context.ctx.ui.notify(
        `Kindle dry run\nRecipient: ${preview.recipient}\nSubject: ${preview.subject}\nFile: ${preview.filename}\nSize: ${formatBytes(preview.size)}\nPrepared export: ${preview.localExportId}\nContent hash: ${preview.contentHash}`,
        'info',
      );
    }
    return {
      content: [{ type: 'text', text: previewLines.join('\n') }],
      details: {
        libraryDir: context.services.libraryDir,
        destination: 'kindle',
        dryRun: true,
        ...targetDetails(target),
        format: preview.format,
        recipient: preview.redactedRecipient,
        subject: preview.subject,
        filename: preview.filename,
        size: preview.size,
        exportId: preview.localExportId,
        preparedExportId: preview.localExportId,
        contentHash: preview.contentHash,
        artifactPath: preview.artifactPath,
        manifestPath: preview.localManifestPath,
      },
    };
  }

  const result = await deliverKindleWithConfirmation(context.services, preview, context.signal, context.ctx);
  return {
    content: [{ type: 'text', text: `Sent ${result.record.format} to ${result.redactedRecipient}. Retained: ${result.localArtifactPath}` }],
    details: {
      libraryDir: context.services.libraryDir,
      destination: 'kindle',
      dryRun: false,
      exportId: result.record.id,
      ...targetDetails(target),
      format: result.record.format,
      recipient: result.redactedRecipient,
      artifactPath: result.artifactPath,
      manifestPath: result.manifestPath,
      localArtifactPath: result.localArtifactPath,
      preparedExportId: result.record.delivery?.preparedExportId,
      contentHash: result.record.artifact.contentHash,
    },
  };
}

export async function executeObsidianExport(
  request: ResolvedReadsExportRequest,
  context: ReadsExportHandlerContext,
): Promise<ReadsExportResult> {
  const { params, target, format } = request;
  if (!isArticleTarget(target)) throw new Error('Obsidian exports require articleId');
  if (format !== 'markdown') throw new Error('Obsidian exports require format markdown');
  const config = context.services.obsidianConfig;
  if (!config) throw new Error('Obsidian is not configured. Run /reads-config and choose Obsidian destination.');
  const obsidian = await context.services.getObsidian();
  if (!obsidian) throw new Error('Obsidian destination could not be loaded. Check the Pi Reads installation.');

  const plan = await obsidian.plan(target.articleId, config, context.signal);
  const overwrite = await resolveObsidianOverwrite(plan, context.ctx, { headlessOverwrite: params.overwrite });
  const result = await withReadsMutationQueue(config.vaultPath, () => obsidian.deliver(plan, overwrite));
  let openWarning: string | undefined;
  if (params.open ?? config.openAfterExport) openWarning = await openObsidianNote(context.pi, result.openUri, context.signal);
  return {
    content: [{
      type: 'text',
      text: [`Delivered ${result.record.id} to Obsidian: ${result.notePath}`, ...(openWarning ? [`Open warning: ${openWarning}`] : [])].join('\n'),
    }],
    details: {
      libraryDir: context.services.libraryDir,
      destination: 'obsidian',
      exportId: result.record.id,
      articleId: target.articleId,
      format: result.record.format,
      artifactPath: result.artifactPath,
      manifestPath: result.manifestPath,
      notePath: result.notePath,
      noteRelativePath: result.noteRelativePath,
      assetPaths: result.assetPaths,
      changedPaths: result.changedPaths,
      openUri: result.openUri,
      ...(openWarning ? { openWarning } : {}),
    },
  };
}

export async function executeReadsExport(request: ResolvedReadsExportRequest, context: ReadsExportHandlerContext): Promise<ReadsExportResult> {
  switch (request.destination) {
    case 'local': return executeLocalExport(request, context);
    case 'kindle': return executeKindleExport(request, context);
    case 'obsidian': return executeObsidianExport(request, context);
  }
}
