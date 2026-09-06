import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerReadsTools } from '../extensions/pi-reads/tools.ts';
import type { BatchCaptureResult } from '../src/application/batch-ingestion-service.ts';

interface ToolResult { content: Array<{ type: string; text: string }>; details: Record<string, unknown> }
interface Tool { name: string; execute: (...args: unknown[]) => Promise<ToolResult> }

test('reads_ingest batch returns bounded complete outcomes, resolves relative @files, and refuses recapture/mixed envelopes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-batch-tool-'));
  const before = { library: process.env.PI_READS_LIBRARY_DIR, config: process.env.PI_READS_CONFIG };
  process.env.PI_READS_LIBRARY_DIR = path.join(root, 'library');
  process.env.PI_READS_CONFIG = path.join(root, 'absent.json');
  t.after(async () => {
    if (before.library === undefined) delete process.env.PI_READS_LIBRARY_DIR; else process.env.PI_READS_LIBRARY_DIR = before.library;
    if (before.config === undefined) delete process.env.PI_READS_CONFIG; else process.env.PI_READS_CONFIG = before.config;
    await rm(root, { recursive: true, force: true });
  });
  const tools = new Map<string, Tool>();
  registerReadsTools({ registerTool(tool: Tool) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI);
  assert.equal(tools.size, 4);
  const ctx = { cwd: root, hasUI: false, mode: 'print' };
  const invoke = (params: unknown, signal = new AbortController().signal) => tools.get('reads_ingest')!.execute('fixture', params, signal, undefined, ctx);
  await writeFile(path.join(root, 'input.md'), '# Batch file\n\nExact file evidence.');
  const items = [{ kind: 'file', value: '@input.md' }, { kind: 'text', value: 'Private body must not leak.' }];
  const result = await invoke({ kind: 'batch', items });
  const report = JSON.parse(result.content[0]!.text) as BatchCaptureResult;
  assert.equal(report.counts.captured, 2);
  assert.deepEqual(result.details, { total: 2, counts: report.counts });
  assert.doesNotMatch(result.content[0]!.text, /Private body|Exact file evidence/u);
  for (const outcome of report.outcomes) {
    assert.ok('sourceId' in outcome);
    const bytes = await readFile(path.join(root, 'library', outcome.sourceContentPath));
    assert.ok(bytes.length > 0);
  }
  const reused = await invoke({ kind: 'batch', items });
  assert.equal((JSON.parse(reused.content[0]!.text) as BatchCaptureResult).counts['exact-duplicate'], 2);
  await assert.rejects(() => invoke({ kind: 'batch', items, recapture: true }), /recapture is individual/u);
  await assert.rejects(() => invoke({ kind: 'batch', items, value: 'ambiguous' }), /only kind batch/u);
  await assert.rejects(() => invoke({ kind: 'text', value: 'ambiguous', items }), /without items/u);
  await assert.rejects(() => invoke({ kind: 'text' }), /requires value/u);
  const controller = new AbortController(); controller.abort();
  const cancelled = await invoke({ kind: 'batch', items }, controller.signal);
  assert.equal((JSON.parse(cancelled.content[0]!.text) as BatchCaptureResult).counts.cancelled, 2);
  const large = await invoke({ kind: 'batch', items: Array.from({ length: 50 }, (_, index) => ({ kind: 'text', value: `Bounded tool fixture ${index}.` })) });
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 32 * 1024);
  assert.equal((JSON.parse(large.content[0]!.text) as BatchCaptureResult).outcomes.length, 50);
});
