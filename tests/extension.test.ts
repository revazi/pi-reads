import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import piReadsExtension from '../extensions/pi-reads/index.ts';

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: Record<string, unknown>;
}

interface RegisteredTool {
  name: string;
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

interface RegisteredCommand {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

test('Pi extension registers and executes capture, generation, export, and library tools', { timeout: 30_000 }, async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-extension-'));
  const previousLibraryDir = process.env.PI_READS_LIBRARY_DIR;
  const previousConfigPath = process.env.PI_READS_CONFIG;
  process.env.PI_READS_LIBRARY_DIR = libraryDir;
  process.env.PI_READS_CONFIG = path.join(libraryDir, 'config', 'pi-reads.json');

  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const sentMessages: string[] = [];
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
    async exec() {
      return { stdout: '', stderr: '', code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;

  const context = {
    cwd: process.cwd(),
    model: { provider: 'fixture-provider', id: 'fixture-model' },
    thinkingLevel: 'medium',
    sessionManager: { getSessionId: () => 'fixture-session' },
    hasUI: false,
    mode: 'print',
    ui: {
      notify() {},
      setStatus() {},
      async select() { return undefined; },
      async input() { return undefined; },
      async editor() { return undefined; },
    },
  };
  const signal = new AbortController().signal;

  try {
    piReadsExtension(pi);
    assert.deepEqual(
      new Set(tools.keys()),
      new Set(['reads_ingest', 'reads_save_article', 'reads_export', 'reads_library']),
    );
    assert.deepEqual(
      new Set(commands.keys()),
      new Set(['reads', 'reads-config', 'reads-install-browser', 'reads-list']),
    );

    const capture = await tools.get('reads_ingest')!.execute(
      'capture-call',
      { kind: 'markdown', value: '# Source\n\nEvidence.', label: 'Extension fixture' },
      signal,
      undefined,
      context,
    );
    const sourceId = String(capture.details?.sourceId);
    const archiveArticleId = String(capture.details?.archiveArticleId);
    assert.match(sourceId, /^src_/);
    assert.match(archiveArticleId, /^art_/);
    assert.match(String(capture.details?.sourceContentPath), new RegExp(sourceId));

    const generated = await tools.get('reads_save_article')!.execute(
      'save-call',
      {
        mode: 'digest',
        title: 'Extension digest',
        body: 'A generated claim.[^cite_evidence]',
        sourceIds: [sourceId],
        citations: [{ id: 'cite_evidence', sourceId, quote: 'Evidence.' }],
      },
      signal,
      undefined,
      context,
    );
    const generatedArticleId = String(generated.details?.articleId);
    assert.match(generatedArticleId, /^art_/);

    const exported = await tools.get('reads_export')!.execute(
      'export-call',
      { articleId: generatedArticleId, format: 'html' },
      signal,
      undefined,
      context,
    );
    const artifactPath = String(exported.details?.artifactPath);
    assert.match(await readFile(artifactPath, 'utf8'), /Extension digest/);

    const listed = await tools.get('reads_library')!.execute(
      'list-call',
      { action: 'list', limit: 10 },
      signal,
      undefined,
      context,
    );
    assert.match(listed.content[0]?.text ?? '', /Extension digest/);

    await commands.get('reads')!.handler('https://example.test/article', context);
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0], /reads_ingest/);
    assert.match(sentMessages[0], /reads_export/);

    const alternateLibrary = path.join(libraryDir, 'alternate');
    await commands.get('reads-config')!.handler(alternateLibrary, context);
    const savedConfig = JSON.parse(await readFile(process.env.PI_READS_CONFIG, 'utf8')) as { libraryDir: string };
    assert.equal(savedConfig.libraryDir, alternateLibrary);
  } finally {
    if (previousLibraryDir === undefined) {
      delete process.env.PI_READS_LIBRARY_DIR;
    } else {
      process.env.PI_READS_LIBRARY_DIR = previousLibraryDir;
    }
    if (previousConfigPath === undefined) {
      delete process.env.PI_READS_CONFIG;
    } else {
      process.env.PI_READS_CONFIG = previousConfigPath;
    }
    await rm(libraryDir, { recursive: true, force: true });
  }
});
