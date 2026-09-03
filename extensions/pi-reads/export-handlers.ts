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

export interface ReadsExportParams {
  articleId: string;
  format?: ReadsExportFormat;
  destination?: ReadsExportDestination;
  overwrite?: boolean;
  open?: boolean;
  send?: boolean;
  preparedExportId?: string;
}

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
  destination: ReadsExportDestination;
  format: ReadsExportFormat;
}

export function resolveReadsExportRequest(
  params: ReadsExportParams,
  services: ReadsServices,
): ResolvedReadsExportRequest {
  const destination = params.destination ?? 'local';
  const format = params.format ?? (destination === 'kindle'
    ? services.kindleConfig?.defaultFormat ?? 'epub'
    : undefined);
  if (!format) throw new Error('format is required for local and Obsidian exports');
  if (params.preparedExportId && destination !== 'kindle') {
    throw new Error('preparedExportId is only supported for Kindle exports');
  }
  return { params, destination, format };
}

export async function executeLocalExport(
  request: ResolvedReadsExportRequest,
  context: ReadsExportHandlerContext,
): Promise<ReadsExportResult> {
  const { params, format } = request;
  const result = format === 'epub'
    ? await (async () => {
        const epub = await context.services.getEpub();
        return withReadsMutationQueue(context.services.libraryDir, () => epub.prepare(params.articleId, context.signal));
      })()
    : await (async () => {
        const exports = await context.services.getExports();
        return withReadsMutationQueue(context.services.libraryDir, () => exports.prepare(params.articleId, format, context.signal));
      })();
  return {
    content: [{
      type: 'text',
      text: [
        `Prepared ${result.record.format} export ${result.record.id}.`,
        `Artifact: ${result.artifactPath}`,
        `Manifest: ${result.manifestPath}`,
      ].join('\n'),
    }],
    details: {
      libraryDir: context.services.libraryDir,
      destination: 'local',
      exportId: result.record.id,
      articleId: result.record.articleId,
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
  const { params, format } = request;
  if (format !== 'epub' && format !== 'pdf') {
    throw new Error('Kindle delivery requires format epub or pdf');
  }
  const kindle = await context.services.getKindle();
  const preview = await withReadsMutationQueue(context.services.libraryDir, () =>
    params.preparedExportId
      ? kindle.previewPrepared(params.articleId, format, params.preparedExportId, context.signal)
      : kindle.preview(params.articleId, format, context.signal));
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
        articleId: preview.articleId,
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
    content: [{
      type: 'text',
      text: [
        `Sent ${result.record.format} to ${result.redactedRecipient}.`,
        `Delivery manifest: ${result.manifestPath}`,
        `Retained local export: ${result.localArtifactPath}`,
      ].join('\n'),
    }],
    details: {
      libraryDir: context.services.libraryDir,
      destination: 'kindle',
      dryRun: false,
      exportId: result.record.id,
      articleId: result.record.articleId,
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
  const { params, format } = request;
  if (format !== 'markdown') throw new Error('Obsidian exports require format markdown');
  const config = context.services.obsidianConfig;
  if (!config) throw new Error('Obsidian is not configured. Run /reads-config and choose Obsidian destination.');
  const obsidian = await context.services.getObsidian();
  if (!obsidian) throw new Error('Obsidian destination could not be loaded. Check the Pi Reads installation.');

  const plan = await obsidian.plan(params.articleId, config, context.signal);
  const overwrite = await resolveObsidianOverwrite(plan, context.ctx, { headlessOverwrite: params.overwrite });
  const result = await withReadsMutationQueue(config.vaultPath, () => obsidian.deliver(plan, overwrite));
  let openWarning: string | undefined;
  if (params.open ?? config.openAfterExport) {
    openWarning = await openObsidianNote(context.pi, result.openUri, context.signal);
  }
  return {
    content: [{
      type: 'text',
      text: [
        `Delivered Obsidian export ${result.record.id}.`,
        `Note: ${result.notePath}`,
        `Assets: ${result.assetPaths.length}`,
        `Manifest: ${result.manifestPath}`,
        ...(openWarning ? [`Obsidian open warning: ${openWarning}`] : []),
      ].join('\n'),
    }],
    details: {
      libraryDir: context.services.libraryDir,
      destination: 'obsidian',
      exportId: result.record.id,
      articleId: result.record.articleId,
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

export async function executeReadsExport(
  request: ResolvedReadsExportRequest,
  context: ReadsExportHandlerContext,
): Promise<ReadsExportResult> {
  switch (request.destination) {
    case 'local':
      return executeLocalExport(request, context);
    case 'kindle':
      return executeKindleExport(request, context);
    case 'obsidian':
      return executeObsidianExport(request, context);
  }
}
