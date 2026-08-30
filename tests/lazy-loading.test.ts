import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const blockedSpecifiers = [
  'playwright',
  'shiki',
  'fflate',
  'nodemailer',
  '@napi-rs/keyring',
  '/application/export-service.ts',
  '/application/epub-service.ts',
  '/application/kindle-service.ts',
  '/application/obsidian-service.ts',
  '/adapters/credentials/keyring.ts',
  '/adapters/destinations/kindle.ts',
  '/adapters/destinations/obsidian.ts',
];

function rejectingLoaderUrl(specifiers: string[] = blockedSpecifiers): string {
  const source = `
const blocked = ${JSON.stringify(specifiers)};
export async function resolve(specifier, context, nextResolve) {
  if (blocked.some((entry) => specifier === entry || specifier.includes(entry))) {
    throw new Error('Unexpected heavyweight import: ' + specifier);
  }
  return nextResolve(specifier, context);
}
`;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

test('Markdown export does not load browser or syntax-highlighting dependencies', { timeout: 30_000 }, async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-lazy-markdown-'));
  const extensionPath = fileURLToPath(new URL('../extensions/pi-reads/index.ts', import.meta.url));
  const script = `
const extension = (await import(process.argv[1])).default;
const libraryDir = process.argv[2];
process.env.PI_READS_LIBRARY_DIR = libraryDir;
process.env.PI_READS_CONFIG = libraryDir + '/config/pi-reads.json';
const tools = new Map();
extension({ registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {} });
const context = { cwd: process.cwd(), hasUI: false, mode: 'print', ui: { notify() {}, setStatus() {} } };
const signal = new AbortController().signal;
const capture = await tools.get('reads_ingest').execute(
  'markdown-capture',
  { kind: 'text', value: 'Markdown export fixture.', label: 'Markdown fixture' },
  signal,
  undefined,
  context,
);
const exported = await tools.get('reads_export').execute(
  'markdown-export',
  { articleId: capture.details.archiveArticleId, format: 'markdown', destination: 'local' },
  signal,
  undefined,
  context,
);
process.stdout.write(JSON.stringify({ artifactPath: exported.details.artifactPath }));
`;

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      '--no-warnings',
      '--experimental-loader', rejectingLoaderUrl(['playwright', 'shiki']),
      '--input-type=module',
      '--eval', script,
      extensionPath,
      libraryDir,
    ], { encoding: 'utf8', timeout: 20_000 });
    const result = JSON.parse(stdout) as { artifactPath: string };
    assert.match(result.artifactPath, /article\.md$/u);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('extension registration, text ingestion, and metadata listing avoid renderer and destination modules', { timeout: 30_000 }, async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-lazy-load-'));
  const extensionPath = fileURLToPath(new URL('../extensions/pi-reads/index.ts', import.meta.url));
  const script = `
const extension = (await import(process.argv[1])).default;
const libraryDir = process.argv[2];
process.env.PI_READS_LIBRARY_DIR = libraryDir;
process.env.PI_READS_CONFIG = libraryDir + '/config/pi-reads.json';
const tools = new Map();
const commands = new Map();
extension({
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand(name, command) { commands.set(name, command); },
});
const context = {
  cwd: process.cwd(),
  hasUI: false,
  mode: 'print',
  ui: { notify() {}, setStatus() {} },
};
const signal = new AbortController().signal;
const capture = await tools.get('reads_ingest').execute(
  'lazy-capture',
  { kind: 'text', value: 'Local metadata-only fixture.', label: 'Lazy fixture' },
  signal,
  undefined,
  context,
);
const listed = await tools.get('reads_library').execute(
  'lazy-list',
  { action: 'list', limit: 10 },
  signal,
  undefined,
  context,
);
const { openReadsServices } = await import(process.argv[1].replace('/index.ts', '/runtime.ts'));
const services = await openReadsServices(process.cwd());
let optionalError = '';
try {
  await services.getExports();
} catch (error) {
  optionalError = error instanceof Error ? error.message : String(error);
}
process.stdout.write(JSON.stringify({
  toolCount: tools.size,
  commandCount: commands.size,
  sourceId: capture.details.sourceId,
  listed: listed.details.articles.length,
  optionalError,
}));
`;

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      '--no-warnings',
      '--experimental-loader', rejectingLoaderUrl(),
      '--input-type=module',
      '--eval', script,
      extensionPath,
      libraryDir,
    ], { encoding: 'utf8', timeout: 20_000 });
    const result = JSON.parse(stdout) as {
      toolCount: number;
      commandCount: number;
      sourceId: string;
      listed: number;
      optionalError: string;
    };
    assert.equal(result.toolCount, 4);
    assert.equal(result.commandCount, 4);
    assert.equal(result.listed, 1);
    assert.match(result.sourceId, /^src_/u);
    assert.match(result.optionalError, /Local export support could not be loaded\. Reinstall or update Pi Reads/u);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});
