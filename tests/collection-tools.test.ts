import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerReadsCommands } from '../extensions/pi-reads/commands.ts';
import { registerReadsTools } from '../extensions/pi-reads/tools.ts';
import type { CollectionPreview } from '../src/application/collection-ingestion-service.ts';
import type { BatchCaptureResult } from '../src/application/batch-ingestion-service.ts';

interface ToolResult { content: Array<{ type: string; text: string }>; details: Record<string, unknown> }
interface Tool { execute: (...args: unknown[]) => Promise<ToolResult> }
interface Command { handler: (args: string, ctx: any) => Promise<void> }

const newsletterPath = path.resolve('tests/fixtures/newsletter.eml');

function preserveEnvironment() {
  return { library: process.env.PI_READS_LIBRARY_DIR, config: process.env.PI_READS_CONFIG };
}

function restoreEnvironment(before: ReturnType<typeof preserveEnvironment>): void {
  if (before.library === undefined) delete process.env.PI_READS_LIBRARY_DIR;
  else process.env.PI_READS_LIBRARY_DIR = before.library;
  if (before.config === undefined) delete process.env.PI_READS_CONFIG;
  else process.env.PI_READS_CONFIG = before.config;
}

test('reads_ingest previews local newsletter metadata and requires exact explicit selection before capture', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-collection-tool-'));
  const before = preserveEnvironment();
  process.env.PI_READS_LIBRARY_DIR = path.join(root, 'library');
  process.env.PI_READS_CONFIG = path.join(root, 'absent.json');
  t.after(async () => { restoreEnvironment(before); await rm(root, { recursive: true, force: true }); });
  const tools = new Map<string, Tool>();
  registerReadsTools({ registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI);
  const invoke = (params: unknown) => tools.get('reads_ingest')!.execute(
    'fixture', params, new AbortController().signal, undefined, { cwd: root, hasUI: false, mode: 'print' },
  );

  const previewResult = await invoke({ kind: 'newsletter', value: newsletterPath });
  const preview = JSON.parse(previewResult.content[0]!.text) as CollectionPreview & { notice: string };
  assert.equal(preview.entryCount, 1);
  assert.equal(preview.entries[0]!.title, 'Synthetic Weekly Newsletter');
  assert.equal(preview.entries[0]!.status, 'new');
  assert.match(preview.notice, /no source or article records/u);
  assert.doesNotMatch(previewResult.content[0]!.text, /Newsletter fixture evidence|multipart\/alternative/u);
  assert.equal(previewResult.details.persisted, false);
  await assert.rejects(
    () => invoke({ kind: 'newsletter', value: newsletterPath, selection: [0] }),
    /both selection and previewToken/u,
  );
  await assert.rejects(
    () => invoke({ kind: 'newsletter', value: newsletterPath, previewToken: preview.previewToken }),
    /both selection and previewToken/u,
  );

  const capturedResult = await invoke({
    kind: 'newsletter', value: newsletterPath, selection: [0], previewToken: preview.previewToken,
  });
  const captured = JSON.parse(capturedResult.content[0]!.text) as BatchCaptureResult;
  assert.equal(captured.counts.captured, 1);
  assert.deepEqual(capturedResult.details.selectedIndexes, [0]);
  const repeated = await invoke({ kind: 'newsletter', value: newsletterPath });
  assert.equal((JSON.parse(repeated.content[0]!.text) as CollectionPreview).entries[0]!.status, 'exact-duplicate');
  await assert.rejects(
    () => invoke({ kind: 'newsletter', value: newsletterPath, label: 'not allowed' }),
    /requires value and optional selection/u,
  );
});

test('/reads local newsletter flow previews before asking for entries and captures only after Done', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-collection-command-'));
  const before = preserveEnvironment();
  process.env.PI_READS_LIBRARY_DIR = path.join(root, 'library');
  process.env.PI_READS_CONFIG = path.join(root, 'absent.json');
  t.after(async () => { restoreEnvironment(before); await rm(root, { recursive: true, force: true }); });
  const commands = new Map<string, Command>();
  registerReadsCommands({
    registerCommand(name: string, command: Command) { commands.set(name, command); },
  } as unknown as ExtensionAPI);
  const notifications: string[] = [];
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: 'interactive',
    signal: new AbortController().signal,
    ui: {
      async select(title: string, options: string[]) {
        if (title === 'Source type') return 'Newsletter .eml — preview before capture';
        if (title.startsWith('Select entry #1')) return options[0];
        if (title.startsWith('Select entry #2')) return 'Done — capture selected entries';
        return undefined;
      },
      async input() { return newsletterPath; },
      notify(message: string) { notifications.push(message); },
      setStatus() {},
    },
  };
  await commands.get('reads')!.handler('', ctx);
  assert.match(notifications[0]!, /No records created/u);
  assert.match(notifications.at(-1)!, /Captured 1/u);
});
