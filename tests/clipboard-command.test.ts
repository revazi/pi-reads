import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerReadsCommands } from '../extensions/pi-reads/commands.ts';

interface Command { handler: (args: string, ctx: any) => Promise<void> }

function environment() {
  return { library: process.env.PI_READS_LIBRARY_DIR, config: process.env.PI_READS_CONFIG };
}

function restore(before: ReturnType<typeof environment>): void {
  if (before.library === undefined) delete process.env.PI_READS_LIBRARY_DIR; else process.env.PI_READS_LIBRARY_DIR = before.library;
  if (before.config === undefined) delete process.env.PI_READS_CONFIG; else process.env.PI_READS_CONFIG = before.config;
}

test('/reads never reads clipboard before an explicit interactive confirmation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-clipboard-command-'));
  const before = environment();
  process.env.PI_READS_LIBRARY_DIR = path.join(root, 'library');
  process.env.PI_READS_CONFIG = path.join(root, 'absent.json');
  t.after(async () => { restore(before); await rm(root, { recursive: true, force: true }); });
  const commands = new Map<string, Command>();
  let execCount = 0;
  const sent: string[] = [];
  const pi = {
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    async exec() {
      execCount += 1;
      return { code: 0, stdout: 'Explicit synthetic clipboard evidence.', stderr: '' };
    },
    sendUserMessage(message: string) { sent.push(message); },
  } as unknown as ExtensionAPI;
  registerReadsCommands(pi);

  let approve = false;
  let requestedMode: 'archive' | 'digest' = 'archive';
  const notifications: string[] = [];
  const ctx = {
    cwd: root, hasUI: true, mode: 'interactive', signal: new AbortController().signal,
    ui: {
      async select(title: string, options: string[]) {
        if (title === 'Source type') return 'Clipboard — read once after confirmation';
        if (title === 'Clipboard content format') return 'Plain text';
        if (title === 'Article mode') return options.find((option) => option.startsWith(requestedMode));
        if (title === 'Generation template') return options[0];
        if (title === 'Export destination/format') return 'markdown';
        return undefined;
      },
      async confirm(title: string) { assert.equal(title, 'Read clipboard now?'); return approve; },
      notify(message: string) { notifications.push(message); },
      setStatus() {},
    },
  };

  assert.equal(execCount, 0);
  await commands.get('reads')!.handler('', ctx);
  assert.equal(execCount, 0);
  approve = true;
  await commands.get('reads')!.handler('', ctx);
  assert.equal(execCount, 1);
  assert.match(notifications.at(-1)!, /Created faithful archive/u);

  requestedMode = 'digest';
  await commands.get('reads')!.handler('', ctx);
  assert.equal(execCount, 2);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /already captured immutable source src_/u);
  assert.doesNotMatch(sent[0]!, /Explicit synthetic clipboard evidence/u);
});
