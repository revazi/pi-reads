import process from 'node:process';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

const MAX_CLIPBOARD_BYTES = 256 * 1024;

async function clipboardCommand(pi: ExtensionAPI, signal?: AbortSignal): Promise<string> {
  const candidates: Array<{ command: string; args: string[] }> = process.platform === 'darwin'
    ? [{ command: 'pbpaste', args: [] }]
    : process.platform === 'win32'
      ? [{ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'] }]
      : [
          { command: 'wl-paste', args: ['--no-newline'] },
          { command: 'xclip', args: ['-selection', 'clipboard', '-out'] },
          { command: 'xsel', args: ['--clipboard', '--output'] },
        ];
  for (const candidate of candidates) {
    const result = await pi.exec(candidate.command, candidate.args, { signal, timeout: 10_000 });
    if (result.code === 0) return result.stdout;
  }
  throw new Error('Could not read the system clipboard; install pbpaste, wl-paste, xclip, or xsel as appropriate');
}

export async function readClipboardExplicitly(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  if (!ctx.hasUI) throw new Error('Clipboard capture requires interactive mode');
  const confirmed = await ctx.ui.confirm(
    'Read clipboard now?',
    'Pi Reads will read the clipboard once after this confirmation. It never monitors the clipboard in the background.',
  );
  if (!confirmed) return undefined;
  const content = await clipboardCommand(pi, ctx.signal);
  if (!content.trim()) throw new Error('Clipboard contains no readable text');
  if (Buffer.byteLength(content) > MAX_CLIPBOARD_BYTES) throw new Error('Clipboard exceeds the 256 KiB capture limit');
  return content;
}
