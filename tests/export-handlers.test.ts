import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  executeKindleExport,
  executeLocalExport,
  executeObsidianExport,
  resolveReadsExportRequest,
  type ReadsExportHandlerContext,
} from '../extensions/pi-reads/export-handlers.ts';
import type { ReadsServices } from '../extensions/pi-reads/runtime.ts';
import type { ExportRecord, Sha256Digest } from '../src/core/domain.ts';

const contentHash = `sha256:${'a'.repeat(64)}` as Sha256Digest;

function record(
  destination: ExportRecord['destination'],
  format: ExportRecord['format'] = 'markdown',
): ExportRecord {
  return {
    schemaVersion: 1,
    id: 'exp_aaaaaaaaaaaaaaaa',
    articleId: 'art_bbbbbbbbbbbbbbbb',
    format,
    destination,
    status: destination.type === 'local' ? 'prepared' : 'delivered',
    artifact: {
      path: `exports/art_bbbbbbbbbbbbbbbb/exp_aaaaaaaaaaaaaaaa/article.${format}`,
      mediaType: format === 'epub' ? 'application/epub+zip' : 'text/markdown',
      contentHash,
      byteLength: 12,
    },
    createdAt: '2026-09-03T00:00:00.000Z',
  };
}

function extensionContext(hasUI = false, confirm = false): ExtensionContext {
  return {
    hasUI,
    ui: {
      notify() {},
      async confirm() { return confirm; },
    },
  } as unknown as ExtensionContext;
}

function handlerContext(services: Record<string, unknown>, ctx = extensionContext()): ReadsExportHandlerContext {
  return {
    pi: { async exec() { return { code: 0, stdout: '', stderr: '', killed: false }; } } as unknown as ExtensionAPI,
    services: { libraryDir: '/tmp/pi-reads-handler-fixture', ...services } as ReadsServices,
    signal: undefined,
    ctx,
  };
}

test('local export handler prepares local and EPUB formats behind one result contract', async () => {
  let localCalls = 0;
  let epubCalls = 0;
  const localRecord = record({ type: 'local' });
  const services = {
    async getExports() {
      return {
        async prepare() {
          localCalls += 1;
          return { record: localRecord, artifactPath: '/tmp/article.md', manifestPath: '/tmp/manifest.json' };
        },
      };
    },
    async getEpub() {
      return {
        async prepare() {
          epubCalls += 1;
          return {
            record: record({ type: 'local' }, 'epub'),
            artifactPath: '/tmp/article.epub',
            manifestPath: '/tmp/epub-manifest.json',
            validation: { files: [], manifestItems: 1, spineItems: 1, embeddedAssets: 0 },
          };
        },
      };
    },
  };
  const context = handlerContext(services);
  const local = await executeLocalExport(
    resolveReadsExportRequest({ articleId: localRecord.articleId, format: 'markdown' }, context.services),
    context,
  );
  const epub = await executeLocalExport(
    resolveReadsExportRequest({ articleId: localRecord.articleId, format: 'epub' }, context.services),
    context,
  );
  assert.equal(local.details.destination, 'local');
  assert.equal(epub.details.format, 'epub');
  assert.ok(Buffer.byteLength(local.content[0].text) < 300);
  assert.doesNotMatch(local.content[0].text, /Manifest:/u);
  assert.equal(localCalls, 1);
  assert.equal(epubCalls, 1);
});

test('Kindle handler keeps dry runs redacted and delegates sends to the centralized confirmation gate', async () => {
  let deliveries = 0;
  const preview = {
    articleId: 'art_bbbbbbbbbbbbbbbb',
    format: 'epub' as const,
    recipient: 'reader@kindle.com',
    redactedRecipient: 'r*****@kindle.com',
    subject: 'Pi Reads: Fixture',
    filename: 'fixture.epub',
    contentType: 'application/epub+zip',
    bytes: new Uint8Array([1, 2, 3]),
    size: 3,
    contentHash,
    localExportId: 'exp_aaaaaaaaaaaaaaaa',
    artifactPath: '/tmp/fixture.epub',
    localManifestPath: '/tmp/prepared.json',
  };
  const kindle = {
    async preview() { return preview; },
    async previewPrepared() { return preview; },
    async deliver() {
      deliveries += 1;
      const deliveredRecord = {
        ...record({ type: 'kindle' }, 'epub'),
        delivery: {
          preparedExportId: preview.localExportId,
          confirmedAt: '2026-09-03T00:00:00.000Z',
          confirmationMethod: 'interactive' as const,
          deliveredAt: '2026-09-03T00:00:00.000Z',
        },
      };
      return {
        record: deliveredRecord,
        manifestPath: '/tmp/delivered.json',
        artifactPath: preview.artifactPath,
        redactedRecipient: preview.redactedRecipient,
        localArtifactPath: preview.artifactPath,
      };
    },
  };
  const services = { kindleConfig: { defaultFormat: 'epub' }, async getKindle() { return kindle; } };
  const dryContext = handlerContext(services);
  const dryRequest = resolveReadsExportRequest({ articleId: preview.articleId, destination: 'kindle' }, dryContext.services);
  const dryRun = await executeKindleExport(dryRequest, dryContext);
  assert.equal(dryRun.details.recipient, preview.redactedRecipient);
  assert.doesNotMatch(JSON.stringify(dryRun), /reader@kindle\.com/u);
  assert.ok(Buffer.byteLength(dryRun.content[0].text) < 600);
  assert.equal(deliveries, 0);

  const headlessRequest = resolveReadsExportRequest({
    articleId: preview.articleId,
    destination: 'kindle',
    format: 'epub',
    send: true,
    preparedExportId: preview.localExportId,
  }, dryContext.services);
  await assert.rejects(() => executeKindleExport(headlessRequest, dryContext), /requires interactive confirmation/u);
  assert.equal(deliveries, 0);

  const confirmedContext = handlerContext(services, extensionContext(true, true));
  const sent = await executeKindleExport(headlessRequest, confirmedContext);
  assert.equal(sent.details.dryRun, false);
  assert.equal(deliveries, 1);
});

test('Obsidian handler delegates conflicts to the centralized fail-closed overwrite gate', async () => {
  let conflicts = ['Reading/fixture.md'];
  let deliveries = 0;
  const obsidian = {
    async plan() { return { inspection: { conflicts } }; },
    async deliver() {
      deliveries += 1;
      return {
        record: record({ type: 'obsidian', vaultName: 'Fixture', notePath: 'Reading/fixture.md' }),
        artifactPath: '/tmp/fixture.md',
        manifestPath: '/tmp/obsidian.json',
        notePath: '/tmp/vault/Reading/fixture.md',
        noteRelativePath: 'Reading/fixture.md',
        assetPaths: [],
        changedPaths: ['/tmp/vault/Reading/fixture.md'],
        openUri: 'obsidian://open?vault=Fixture&file=Reading%2Ffixture.md',
      };
    },
  };
  const services = {
    obsidianConfig: {
      vaultPath: '/tmp/vault',
      vaultName: 'Fixture',
      inboxFolder: 'Reading',
      attachmentFolder: 'Assets',
      noteNameTemplate: '{{title}}',
      tags: [],
      frontmatter: {},
      openAfterExport: false,
    },
    async getObsidian() { return obsidian; },
  };
  const context = handlerContext(services);
  const request = resolveReadsExportRequest({
    articleId: 'art_bbbbbbbbbbbbbbbb',
    destination: 'obsidian',
    format: 'markdown',
  }, context.services);
  await assert.rejects(() => executeObsidianExport(request, context), /explicit approval/u);
  assert.equal(deliveries, 0);

  conflicts = [];
  const delivered = await executeObsidianExport(request, context);
  assert.equal(delivered.details.destination, 'obsidian');
  assert.ok(Buffer.byteLength(delivered.content[0].text) < 300);
  assert.doesNotMatch(delivered.content[0].text, /Manifest:|Assets:/u);
  assert.equal(deliveries, 1);
});
