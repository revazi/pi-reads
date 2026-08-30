import process from 'node:process';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { DeliveredKindleExport, KindlePreview } from '../../src/application/kindle-service.ts';
import type { ObsidianExportPlan } from '../../src/application/obsidian-service.ts';
import type { SourceInput } from '../../src/core/ingest/index.ts';
import type { ReadsServices } from './runtime.ts';

export async function withReadsMutationQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const { withFileMutationQueue } = await import('@earendil-works/pi-coding-agent');
  return withFileMutationQueue(key, operation);
}

export function sourceInput(
  kind: 'url' | 'text' | 'markdown' | 'file',
  value: string,
  label: string | undefined,
  cwd: string,
): SourceInput {
  switch (kind) {
    case 'url':
      return { kind, url: value };
    case 'text':
      return { kind, text: value, ...(label ? { label } : {}) };
    case 'markdown':
      return { kind, markdown: value, ...(label ? { label } : {}) };
    case 'file':
      return { kind, path: value.replace(/^@/, ''), cwd };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export async function openObsidianNote(
  pi: ExtensionAPI,
  uri: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', uri] : [uri];
  const result = await pi.exec(command, args, { signal, timeout: 15_000 });
  return result.code === 0 ? undefined : (result.stderr || `exit code ${result.code}`);
}

export async function resolveObsidianOverwrite(
  plan: ObsidianExportPlan,
  ctx: ExtensionContext,
  options: { headlessOverwrite?: boolean } = {},
): Promise<{ overwrite: boolean; confirmedAt?: string }> {
  if (plan.inspection.conflicts.length === 0) return { overwrite: false };
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm(
      'Overwrite Obsidian files?',
      `The following files differ:\n${plan.inspection.conflicts.join('\n')}\n\nReplace only these Pi Reads targets?`,
    );
    if (!confirmed) throw new Error('Obsidian export cancelled; no vault files were changed');
    return { overwrite: true, confirmedAt: new Date().toISOString() };
  }
  if (options.headlessOverwrite) return { overwrite: true };
  throw new Error(`Obsidian export conflicts with ${plan.inspection.conflicts.join(', ')}; rerun with overwrite true only after explicit approval`);
}

export async function deliverKindleWithConfirmation(
  services: ReadsServices,
  preview: KindlePreview,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<DeliveredKindleExport> {
  if (!ctx.hasUI) {
    throw new Error(`Kindle send requires interactive confirmation. Local export retained at ${preview.artifactPath}`);
  }
  const confirmed = await ctx.ui.confirm(
    'Send to Kindle?',
    `Recipient: ${preview.recipient}\nSubject: ${preview.subject}\nFile: ${preview.filename}\nSize: ${formatBytes(preview.size)}\nPrepared export: ${preview.localExportId}\nContent hash: ${preview.contentHash}\n\nSend this exact attachment now?`,
  );
  if (!confirmed) throw new Error(`Kindle delivery cancelled. Local export retained at ${preview.artifactPath}`);
  const kindle = await services.getKindle();
  return withReadsMutationQueue(services.libraryDir, () =>
    kindle.deliver(preview, {
      confirmedAt: new Date().toISOString(),
      confirmationMethod: 'interactive',
    }, signal),
  );
}
