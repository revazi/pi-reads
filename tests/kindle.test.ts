import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { KindleMail, KindleMailTransport } from '../src/adapters/destinations/kindle.ts';
import { EpubService } from '../src/application/epub-service.ts';
import { ExportService } from '../src/application/export-service.ts';
import { KindleDeliveryError, KindleService, type KindleEnvironment } from '../src/application/kindle-service.ts';
import type { KindleCredentialStore } from '../src/application/kindle-credentials.ts';
import type { ResolvedKindleConfig } from '../src/core/config.ts';
import { LibraryService } from '../src/application/library-service.ts';
import type { RecordIdPrefix } from '../src/core/library.ts';
import { versionedSha256 } from '../src/core/text.ts';

function deterministicIds(): (prefix: RecordIdPrefix) => string {
  const counts: Record<RecordIdPrefix, number> = { src: 0, art: 0, cite: 0, exp: 0 };
  const letters: Record<RecordIdPrefix, string> = { src: 'i', art: 'j', cite: 'k', exp: 'l' };
  return (prefix) => {
    counts[prefix] += 1;
    return `${prefix}_${letters[prefix].repeat(15)}${counts[prefix].toString(36)}`;
  };
}

class FakeTransport implements KindleMailTransport {
  readonly sent: KindleMail[] = [];
  private readonly fail: boolean;

  constructor(fail = false) {
    this.fail = fail;
  }

  async send(mail: KindleMail): Promise<void> {
    if (this.fail) throw new Error('fixture transport failure');
    this.sent.push(mail);
  }
}

const kindleAddress = ['reader', 'kindle.com'].join('@');
const senderAddress = ['sender', 'example.test'].join('@');

const environment: KindleEnvironment = {
  TEST_KINDLE_RECIPIENT: kindleAddress,
  TEST_SMTP_USER: 'approved-sender',
  TEST_SMTP_PASSWORD: 'test-only-password',
  TEST_SMTP_FROM: senderAddress,
};
const kindleConfig: ResolvedKindleConfig = {
  deviceLabel: 'Fixture Kindle',
  defaultFormat: 'epub',
  credentialStore: 'environment',
  credentialProfile: 'default',
  recipientEnv: 'TEST_KINDLE_RECIPIENT',
  smtp: {
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    userEnv: 'TEST_SMTP_USER',
    passwordEnv: 'TEST_SMTP_PASSWORD',
    fromEnv: 'TEST_SMTP_FROM',
  },
};

test('Kindle dry-run, confirmed delivery, and failure retention use a fake SMTP transport', { timeout: 30_000 }, async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-kindle-'));
  const createId = deterministicIds();
  const now = () => new Date('2026-08-22T11:00:00Z');
  const library = new LibraryService({ libraryDir, createId, now });
  const exports = new ExportService({ library, createId, now });
  const epubRenderer = new EpubService({ library, createId, now });
  let epubRenderCount = 0;
  const epub = {
    async prepare(articleId: string, signal?: AbortSignal) {
      epubRenderCount += 1;
      return epubRenderer.prepare(articleId, signal);
    },
  };
  const transport = new FakeTransport();
  const kindle = new KindleService({ library, exports, epub, env: environment, config: kindleConfig, transport, createId, now });

  try {
    const capture = await library.capture({
      kind: 'markdown',
      label: 'Kindle Fixture',
      markdown: '# Kindle Fixture\n\nReflowable reading prose.',
    });
    const preview = await kindle.preview(capture.archiveArticle.id, 'epub');
    assert.equal(preview.redactedRecipient, 'r*****@kindle.com');
    assert.equal(preview.subject, 'Pi Reads: Kindle Fixture');
    assert.equal(preview.filename, 'kindle-fixture.epub');
    assert.ok(preview.size > 0);
    assert.match(preview.localExportId, /^exp_/u);
    assert.equal(preview.contentHash, versionedSha256(preview.bytes));
    assert.equal(epubRenderCount, 1);
    assert.equal(transport.sent.length, 0);
    await access(preview.artifactPath);

    await assert.rejects(
      () => kindle.deliver(preview, { confirmedAt: '', confirmationMethod: 'interactive' }),
      /requires interactive confirmation/,
    );
    assert.equal(transport.sent.length, 0);

    const reusedPreview = await kindle.previewPrepared(
      capture.archiveArticle.id,
      'epub',
      preview.localExportId,
    );
    assert.equal(reusedPreview.contentHash, preview.contentHash);
    assert.deepEqual(reusedPreview.bytes, preview.bytes);
    const delivered = await kindle.deliver(reusedPreview, {
      confirmedAt: '2026-08-22T10:59:59Z',
      confirmationMethod: 'interactive',
    });
    assert.equal(epubRenderCount, 1);
    assert.equal(transport.sent.length, 1);
    assert.equal(transport.sent[0].to, kindleAddress);
    assert.equal(transport.sent[0].filename, 'kindle-fixture.epub');
    assert.equal(versionedSha256(transport.sent[0].content), preview.contentHash);
    assert.equal(delivered.record.destination.type, 'kindle');
    assert.equal(delivered.record.delivery?.confirmationMethod, 'interactive');
    assert.equal(delivered.record.delivery?.preparedExportId, preview.localExportId);
    assert.equal(delivered.record.artifact.contentHash, preview.contentHash);
    assert.equal(delivered.artifactPath, preview.artifactPath);
    assert.deepEqual(await readdir(path.dirname(delivered.manifestPath)), ['manifest.json']);
    const manifest = await readFile(delivered.manifestPath, 'utf8');
    assert.doesNotMatch(manifest, /@kindle\.com|@example\.test|test-only-password/);

    await assert.rejects(
      () => kindle.previewPrepared(capture.archiveArticle.id, 'pdf', preview.localExportId),
      /is not a pdf artifact/u,
    );
    await assert.rejects(
      () => kindle.previewPrepared(capture.archiveArticle.id, 'epub', 'exp_zzzzzzzzzzzzzzzz'),
      /manifest is missing/u,
    );

    let recipientReads = 0;
    let smtpReads = 0;
    const credentialStore: KindleCredentialStore = {
      async getRecipient(profile) {
        recipientReads += 1;
        assert.equal(profile, 'default');
        return kindleAddress;
      },
      async getSmtp(profile) {
        smtpReads += 1;
        assert.equal(profile, 'default');
        return {
          user: 'stored-approved-sender',
          password: 'stored-test-password',
          from: senderAddress,
        };
      },
      async set() {},
      async delete() { return true; },
    };
    const storedTransport = new FakeTransport();
    const storedKindle = new KindleService({
      library,
      exports,
      epub,
      env: {},
      config: { ...kindleConfig, credentialStore: 'system' },
      credentialStore,
      transport: storedTransport,
      createId,
      now,
    });
    const storedPreview = await storedKindle.preview(capture.archiveArticle.id, 'epub');
    await storedKindle.deliver(storedPreview, {
      confirmedAt: '2026-08-22T10:59:59Z',
      confirmationMethod: 'interactive',
    });
    assert.equal(recipientReads, 1);
    assert.equal(smtpReads, 1);
    assert.equal(storedTransport.sent[0].to, kindleAddress);
    assert.equal(storedTransport.sent[0].from, senderAddress);

    const pdfBytes = Buffer.from('%PDF-1.7\nfixture\n%%EOF\n');
    const pdfKindle = new KindleService({
      library,
      exports: {
        async prepare(articleId) {
          const exportId = 'exp_mmmmmmmmmmmmmmmm';
          const relativeDirectory = path.posix.join('exports', articleId, exportId);
          const artifactRelativePath = path.posix.join(relativeDirectory, 'article.pdf');
          const artifactPath = path.join(libraryDir, ...artifactRelativePath.split('/'));
          const manifestPath = path.join(libraryDir, ...relativeDirectory.split('/'), 'manifest.json');
          const record = {
            schemaVersion: 1 as const,
            id: exportId,
            articleId,
            format: 'pdf' as const,
            destination: { type: 'local' as const },
            status: 'prepared' as const,
            artifact: {
              path: artifactRelativePath,
              mediaType: 'application/pdf',
              contentHash: versionedSha256(pdfBytes),
              byteLength: pdfBytes.byteLength,
            },
            createdAt: '2026-08-22T11:00:00Z',
          };
          await mkdir(path.dirname(artifactPath), { recursive: true });
          await Promise.all([
            writeFile(artifactPath, pdfBytes),
            writeFile(manifestPath, `${JSON.stringify(record, null, 2)}\n`),
          ]);
          return { record, artifactPath, manifestPath };
        },
      },
      epub,
      env: environment,
      config: kindleConfig,
      transport,
      createId,
      now,
    });
    const pdfPreview = await pdfKindle.preview(capture.archiveArticle.id, 'pdf');
    assert.equal(Buffer.from(pdfPreview.bytes.subarray(0, 4)).toString(), '%PDF');
    await access(pdfPreview.artifactPath);

    const failing = new KindleService({
      library,
      exports,
      epub,
      env: environment,
      config: kindleConfig,
      transport: new FakeTransport(true),
      createId,
      now,
    });
    await assert.rejects(
      () => failing.deliver(preview, {
        confirmedAt: '2026-08-22T11:00:00Z',
        confirmationMethod: 'interactive',
      }),
      (error: unknown) => {
        assert.ok(error instanceof KindleDeliveryError);
        assert.match(error.message, /Local export retained at/);
        assert.doesNotMatch(error.message, /@kindle\.com/);
        return true;
      },
    );
    await access(preview.artifactPath);
    await writeFile(preview.artifactPath, Buffer.from('tampered EPUB'));
    await assert.rejects(
      () => kindle.previewPrepared(capture.archiveArticle.id, 'epub', preview.localExportId),
      /failed artifact integrity verification/u,
    );
    await rm(preview.artifactPath);
    await assert.rejects(
      () => kindle.previewPrepared(capture.archiveArticle.id, 'epub', preview.localExportId),
      /artifact is missing/u,
    );
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});
