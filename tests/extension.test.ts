import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import piReadsExtension from '../extensions/pi-reads/index.ts';
import { validateEpub } from '../src/application/epub-service.ts';

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
  const previousKindleAddress = process.env.PI_READS_KINDLE_ADDRESS;
  process.env.PI_READS_LIBRARY_DIR = libraryDir;
  process.env.PI_READS_CONFIG = path.join(libraryDir, 'config', 'pi-reads.json');
  process.env.PI_READS_KINDLE_ADDRESS = ['fixture-reader', 'kindle.com'].join('@');

  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const sentMessages: string[] = [];
  const execCalls: Array<{ command: string; args: string[] }> = [];
  let confirmCalls = 0;
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
    async exec(command: string, args: string[]) {
      execCalls.push({ command, args });
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
      async confirm() { confirmCalls += 1; return false; },
    },
  };
  const signal = new AbortController().signal;

  try {
    piReadsExtension(pi);
    const vaultPath = path.join(libraryDir, 'fixture-vault');
    await mkdir(vaultPath);
    await commands.get('reads-config')!.handler(`obsidian ${vaultPath}`, context);
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
    assert.ok(Buffer.byteLength(capture.content[0]?.text ?? '') < 200);
    assert.doesNotMatch(capture.content[0]?.text ?? '', /Source content:|Archive content:|structure index/u);
    const sourceIndex = JSON.parse(await readFile(String(capture.details?.sourceIndexPath), 'utf8')) as {
      sourceContentHash: string;
      headings: Array<{ id: string }>;
      paragraphs: Array<{ id: string }>;
    };

    const generated = await tools.get('reads_save_article')!.execute(
      'save-call',
      {
        mode: 'digest',
        title: 'Extension digest',
        body: 'A generated claim.[^cite_evidence]',
        sourceIds: [sourceId],
        citations: [{ id: 'cite_evidence', sourceId, quote: 'Evidence.' }],
        coverage: {
          policy: 'complete',
          sources: [{
            sourceId,
            sourceContentHash: sourceIndex.sourceContentHash,
            consideredLocators: [
              ...sourceIndex.headings.map(({ id }) => id),
              ...sourceIndex.paragraphs.map(({ id }) => id),
            ],
          }],
        },
      },
      signal,
      undefined,
      context,
    );
    const generatedArticleId = String(generated.details?.articleId);
    assert.match(generatedArticleId, /^art_/);
    assert.match(generated.content[0]?.text ?? '', /\(digest, complete\)/u);
    assert.equal((generated.details?.sourceCoverage as { policy: string }).policy, 'complete');
    assert.equal((generated.details?.citationDiagnostics as { verifiedQuoteCount: number }).verifiedQuoteCount, 1);
    assert.match(generated.content[0]?.text ?? '', /Grounding: 0\/1 located; 0\/1 article sections uncited/u);
    assert.ok(Buffer.byteLength(generated.content[0]?.text ?? '') < 200);
    assert.doesNotMatch(generated.content[0]?.text ?? '', /Article content:|Manifest:/u);

    const exported = await tools.get('reads_export')!.execute(
      'export-call',
      { articleId: generatedArticleId, format: 'html' },
      signal,
      undefined,
      context,
    );
    const artifactPath = String(exported.details?.artifactPath);
    assert.match(await readFile(artifactPath, 'utf8'), /Extension digest/);
    assert.match(exported.content[0]?.text ?? '', new RegExp(artifactPath, 'u'));
    assert.doesNotMatch(exported.content[0]?.text ?? '', /Manifest:/u);

    const epubExport = await tools.get('reads_export')!.execute(
      'epub-export-call',
      { articleId: generatedArticleId, format: 'epub', destination: 'local' },
      signal,
      undefined,
      context,
    );
    const epubPath = String(epubExport.details?.artifactPath);
    assert.ok(validateEpub(await readFile(epubPath)).spineItems > 0);

    const kindleDryRun = await tools.get('reads_export')!.execute(
      'kindle-dry-run-call',
      { articleId: generatedArticleId, destination: 'kindle' },
      signal,
      undefined,
      context,
    );
    assert.equal(kindleDryRun.details?.dryRun, true);
    assert.equal(kindleDryRun.details?.format, 'epub');
    assert.equal(kindleDryRun.details?.recipient, 'f********@kindle.com');
    const preparedExportId = String(kindleDryRun.details?.preparedExportId);
    assert.match(preparedExportId, /^exp_/u);
    assert.match(String(kindleDryRun.details?.contentHash), /^sha256:/u);
    const exportsBeforeSend = (await readdir(path.join(libraryDir, 'exports', generatedArticleId))).sort();
    await assert.rejects(
      () => tools.get('reads_export')!.execute(
        'kindle-headless-send-call',
        {
          articleId: generatedArticleId,
          format: 'epub',
          destination: 'kindle',
          send: true,
          preparedExportId,
        },
        signal,
        undefined,
        context,
      ),
      /requires interactive confirmation/,
    );
    assert.deepEqual(
      (await readdir(path.join(libraryDir, 'exports', generatedArticleId))).sort(),
      exportsBeforeSend,
    );

    const obsidianExport = await tools.get('reads_export')!.execute(
      'obsidian-export-call',
      { articleId: generatedArticleId, format: 'markdown', destination: 'obsidian', open: true },
      signal,
      undefined,
      context,
    );
    const notePath = String(obsidianExport.details?.notePath);
    assert.match(await readFile(notePath, 'utf8'), /"mode": "digest"/);
    assert.match(await readFile(notePath, 'utf8'), /Extension digest/);
    assert.equal(execCalls.length, 1);
    assert.match(execCalls[0].args.at(-1) ?? '', /^obsidian:\/\/open\?/);
    await writeFile(notePath, 'Manual edit.');
    await assert.rejects(
      () => tools.get('reads_export')!.execute(
        'obsidian-interactive-conflict-call',
        { articleId: generatedArticleId, format: 'markdown', destination: 'obsidian', overwrite: true },
        signal,
        undefined,
        { ...context, hasUI: true },
      ),
      /cancelled; no vault files were changed/,
    );
    assert.equal(confirmCalls, 1);
    assert.equal(await readFile(notePath, 'utf8'), 'Manual edit.');
    await assert.rejects(
      () => tools.get('reads_export')!.execute(
        'obsidian-conflict-call',
        { articleId: generatedArticleId, format: 'markdown', destination: 'obsidian' },
        signal,
        undefined,
        context,
      ),
      /rerun with overwrite true only after explicit approval/,
    );
    await tools.get('reads_export')!.execute(
      'obsidian-overwrite-call',
      { articleId: generatedArticleId, format: 'markdown', destination: 'obsidian', overwrite: true },
      signal,
      undefined,
      context,
    );
    assert.match(await readFile(notePath, 'utf8'), /Extension digest/);

    const listed = await tools.get('reads_library')!.execute(
      'list-call',
      { action: 'list', limit: 10 },
      signal,
      undefined,
      context,
    );
    assert.match(listed.content[0]?.text ?? '', /Extension digest/);
    const searched = await tools.get('reads_library')!.execute(
      'search-call',
      { action: 'search', query: 'extension digest', limit: 10 },
      signal,
      undefined,
      context,
    );
    assert.match(searched.content[0]?.text ?? '', /Extension digest/);
    const outlined = await tools.get('reads_library')!.execute(
      'outline-call',
      { action: 'outline', id: sourceId, maxBytes: 1024 },
      signal,
      undefined,
      context,
    );
    assert.match(outlined.content[0]?.text ?? '', /BEGIN PI_READS_SOURCE_DATA/u);
    assert.equal(outlined.details?.sourceId, sourceId);
    const paragraphLocator = (outlined.details?.locators as string[]).find((locator) => locator.startsWith('p_'));
    assert.ok(paragraphLocator);
    const sourceRead = await tools.get('reads_library')!.execute(
      'source-read-call',
      { action: 'read', id: sourceId, startLocator: paragraphLocator, maxBytes: 1024 },
      signal,
      undefined,
      context,
    );
    assert.match(sourceRead.content[0]?.text ?? '', /Evidence\./u);
    assert.match(sourceRead.content[0]?.text ?? '', new RegExp(paragraphLocator, 'u'));
    const sourceSearch = await tools.get('reads_library')!.execute(
      'source-search-call',
      { action: 'search', id: sourceId, query: 'Evidence', maxBytes: 1024 },
      signal,
      undefined,
      context,
    );
    assert.match(sourceSearch.content[0]?.text ?? '', /Evidence\./u);
    assert.equal(sourceSearch.details?.sourceId, sourceId);

    const readsSelections = ['digest — shorter cited AI summary of the source', 'obsidian'];
    const displayedModeChoices: string[] = [];
    await commands.get('reads')!.handler('https://example.test/obsidian', {
      ...context,
      hasUI: true,
      ui: {
        ...context.ui,
        async select(title: string, options: string[]) {
          if (title === 'Article mode') displayedModeChoices.push(...options);
          return readsSelections.shift();
        },
      },
    });
    assert.deepEqual(displayedModeChoices, [
      'archive — faithful source capture; no AI rewriting',
      'digest — shorter cited AI summary of the source',
      'synthesis — new cited AI article combining or reframing source ideas',
    ]);
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0], /reads_ingest/);
    assert.match(sentMessages[0], /reads_export to Obsidian as Markdown/u);
    assert.ok(Buffer.byteLength(sentMessages[0]) < 600);
    const kindleSelections = ['synthesis', 'kindle-epub'];
    await commands.get('reads')!.handler('https://example.test/kindle', {
      ...context,
      hasUI: true,
      ui: { ...context.ui, async select() { return kindleSelections.shift(); } },
    });
    assert.match(sentMessages[1], /reads_export to Kindle as EPUB/u);
    assert.match(sentMessages[1], /interactive confirmation/);

    const configSelections = ['Obsidian destination', 'no'];
    const configInputs = [vaultPath, 'Fixture Vault', 'Reading Inbox', 'Attachments/pi-reads', '{{title}} - {{mode}}', 'pi-reads, test'];
    await commands.get('reads-config')!.handler('', {
      ...context,
      hasUI: true,
      ui: {
        ...context.ui,
        async select() { return configSelections.shift(); },
        async input() { return configInputs.shift(); },
      },
    });
    const interactiveConfig = JSON.parse(await readFile(process.env.PI_READS_CONFIG, 'utf8')) as {
      obsidian: { noteNameTemplate: string; tags: string[] };
    };
    assert.equal(interactiveConfig.obsidian.noteNameTemplate, '{{title}} - {{mode}}');
    assert.deepEqual(interactiveConfig.obsidian.tags, ['pi-reads', 'test']);

    const kindleConfigSelections = [
      'Kindle delivery',
      'epub',
      'no',
      'Environment variables — advanced/CI',
    ];
    const kindleConfigInputs = [
      'Test Reader',
      'smtp.example.test',
      '587',
      'TEST_KINDLE_RECIPIENT',
      'TEST_SMTP_USER',
      'TEST_SMTP_PASSWORD',
      'TEST_SMTP_FROM',
    ];
    await commands.get('reads-config')!.handler('', {
      ...context,
      hasUI: true,
      ui: {
        ...context.ui,
        async select() { return kindleConfigSelections.shift(); },
        async input() { return kindleConfigInputs.shift(); },
      },
    });
    const configuredKindle = JSON.parse(await readFile(process.env.PI_READS_CONFIG, 'utf8')) as {
      kindle: { credentialStore: string; recipientEnv: string; smtp: { host: string; passwordEnv: string } };
    };
    assert.equal(configuredKindle.kindle.credentialStore, 'environment');
    assert.equal(configuredKindle.kindle.recipientEnv, 'TEST_KINDLE_RECIPIENT');
    assert.equal(configuredKindle.kindle.smtp.host, 'smtp.example.test');
    assert.equal(configuredKindle.kindle.smtp.passwordEnv, 'TEST_SMTP_PASSWORD');
    assert.doesNotMatch(JSON.stringify(configuredKindle.kindle), /@kindle\.com|test-only-password/);

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
    if (previousKindleAddress === undefined) {
      delete process.env.PI_READS_KINDLE_ADDRESS;
    } else {
      process.env.PI_READS_KINDLE_ADDRESS = previousKindleAddress;
    }
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('archive-only /reads executes directly without a model and preserves destination confirmations', { timeout: 30_000 }, async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-direct-command-'));
  const previousLibraryDir = process.env.PI_READS_LIBRARY_DIR;
  const previousConfigPath = process.env.PI_READS_CONFIG;
  const previousKindleAddress = process.env.PI_READS_KINDLE_ADDRESS;
  process.env.PI_READS_LIBRARY_DIR = libraryDir;
  process.env.PI_READS_CONFIG = path.join(libraryDir, 'config', 'pi-reads.json');
  process.env.PI_READS_KINDLE_ADDRESS = ['direct-reader', 'kindle.com'].join('@');

  const commands = new Map<string, RegisteredCommand>();
  const sentMessages: string[] = [];
  const notifications: string[] = [];
  const pi = {
    registerTool() {},
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
  const baseContext = {
    cwd: process.cwd(),
    hasUI: false,
    mode: 'print',
    ui: {
      notify(message: string) { notifications.push(message); },
      setStatus() {},
      async select() { return undefined; },
      async input() { return undefined; },
      async editor() { return undefined; },
      async confirm() { return false; },
    },
  };

  try {
    piReadsExtension(pi);
    const sourcePath = path.join(libraryDir, 'direct-source.md');
    const vaultPath = path.join(libraryDir, 'direct-vault');
    await writeFile(sourcePath, '# Direct source\n\nFaithful direct-command prose.');
    await mkdir(vaultPath);
    await commands.get('reads-config')!.handler(`obsidian ${vaultPath}`, baseContext);
    notifications.length = 0;

    await commands.get('reads')!.handler(sourcePath, baseContext);
    assert.equal(sentMessages.length, 0);
    const localReport = notifications.at(-1) ?? '';
    assert.match(localReport, /^Captured source src_/m);
    assert.match(localReport, /^Created faithful archive art_/m);
    const localArtifact = /^Artifact: (.+)$/m.exec(localReport)?.[1];
    assert.ok(localArtifact);
    assert.match(await readFile(localArtifact, 'utf8'), /Faithful direct-command prose/);

    const obsidianSelections = ['archive', 'obsidian'];
    await commands.get('reads')!.handler(sourcePath, {
      ...baseContext,
      hasUI: true,
      mode: 'tui',
      ui: { ...baseContext.ui, async select() { return obsidianSelections.shift(); } },
    });
    assert.equal(sentMessages.length, 0);
    const obsidianReport = notifications.at(-1) ?? '';
    const notePath = /^Artifact: (.+)$/m.exec(obsidianReport)?.[1];
    assert.ok(notePath);
    assert.match(await readFile(notePath, 'utf8'), /Faithful direct-command prose/);
    await writeFile(notePath, 'Manual Obsidian edit.');

    let confirmCalls = 0;
    const conflictingSelections = ['archive', 'obsidian'];
    await assert.rejects(
      () => commands.get('reads')!.handler(sourcePath, {
        ...baseContext,
        hasUI: true,
        mode: 'tui',
        ui: {
          ...baseContext.ui,
          async select() { return conflictingSelections.shift(); },
          async confirm() { confirmCalls += 1; return false; },
        },
      }),
      /Obsidian export cancelled; no vault files were changed/,
    );
    assert.equal(confirmCalls, 1);
    assert.equal(await readFile(notePath, 'utf8'), 'Manual Obsidian edit.');

    const kindleSelections = ['archive', 'kindle-epub'];
    await assert.rejects(
      () => commands.get('reads')!.handler(sourcePath, {
        ...baseContext,
        hasUI: true,
        mode: 'tui',
        ui: {
          ...baseContext.ui,
          async select() { return kindleSelections.shift(); },
          async confirm() { confirmCalls += 1; return false; },
        },
      }),
      /Kindle delivery cancelled\. Local export retained at/,
    );
    assert.equal(confirmCalls, 2);
    assert.equal(sentMessages.length, 0);

    const digestSelections = ['digest', 'markdown'];
    await commands.get('reads')!.handler(sourcePath, {
      ...baseContext,
      hasUI: true,
      mode: 'tui',
      ui: { ...baseContext.ui, async select() { return digestSelections.shift(); } },
    });
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0], /Write a digest with \[\^cite_id\] citations/u);
  } finally {
    if (previousLibraryDir === undefined) delete process.env.PI_READS_LIBRARY_DIR;
    else process.env.PI_READS_LIBRARY_DIR = previousLibraryDir;
    if (previousConfigPath === undefined) delete process.env.PI_READS_CONFIG;
    else process.env.PI_READS_CONFIG = previousConfigPath;
    if (previousKindleAddress === undefined) delete process.env.PI_READS_KINDLE_ADDRESS;
    else process.env.PI_READS_KINDLE_ADDRESS = previousKindleAddress;
    await rm(libraryDir, { recursive: true, force: true });
  }
});
