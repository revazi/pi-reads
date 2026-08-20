import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { KindleMail, KindleMailTransport } from '../src/adapters/destinations/kindle.ts';
import { EpubService } from '../src/application/epub-service.ts';
import { ExportService } from '../src/application/export-service.ts';
import { KindleDeliveryError, KindleService, type KindleEnvironment } from '../src/application/kindle-service.ts';
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
  PI_READS_KINDLE_ADDRESS: kindleAddress,
  PI_READS_KINDLE_DEVICE_LABEL: 'Fixture Kindle',
  PI_READS_SMTP_HOST: 'smtp.example.test',
  PI_READS_SMTP_PORT: '587',
  PI_READS_SMTP_SECURE: 'false',
  PI_READS_SMTP_USER: 'approved-sender',
  PI_READS_SMTP_PASSWORD: 'test-only-password',
  PI_READS_SMTP_FROM: senderAddress,
};

test('Kindle dry-run, confirmed delivery, and failure retention use a fake SMTP transport', { timeout: 30_000 }, async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-kindle-'));
  const createId = deterministicIds();
  const now = () => new Date('2026-08-22T11:00:00Z');
  const library = new LibraryService({ libraryDir, createId, now });
  const exports = new ExportService({ library, createId, now });
  const epub = new EpubService({ library, createId, now });
  const transport = new FakeTransport();
  const kindle = new KindleService({ library, exports, epub, env: environment, transport, createId, now });

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
    assert.equal(transport.sent.length, 0);
    await access(preview.artifactPath);

    await assert.rejects(
      () => kindle.deliver(preview, { confirmedAt: '', confirmationMethod: 'interactive' }),
      /requires interactive confirmation/,
    );
    assert.equal(transport.sent.length, 0);

    const delivered = await kindle.deliver(preview, {
      confirmedAt: '2026-08-22T10:59:59Z',
      confirmationMethod: 'interactive',
    });
    assert.equal(transport.sent.length, 1);
    assert.equal(transport.sent[0].to, kindleAddress);
    assert.equal(transport.sent[0].filename, 'kindle-fixture.epub');
    assert.equal(delivered.record.destination.type, 'kindle');
    assert.equal(delivered.record.delivery?.confirmationMethod, 'interactive');
    const manifest = await readFile(delivered.manifestPath, 'utf8');
    assert.doesNotMatch(manifest, /@kindle\.com|@example\.test|test-only-password/);

    const pdfBytes = Buffer.from('%PDF-1.7\nfixture\n%%EOF\n');
    const pdfPath = path.join(libraryDir, 'fixture.pdf');
    await writeFile(pdfPath, pdfBytes);
    const pdfKindle = new KindleService({
      library,
      exports: {
        async prepare(articleId) {
          return {
            record: {
              schemaVersion: 1,
              id: 'exp_mmmmmmmmmmmmmmmm',
              articleId,
              format: 'pdf',
              destination: { type: 'local' },
              status: 'prepared',
              artifact: {
                path: 'exports/art_jjjjjjjjjjjjjjj1/exp_mmmmmmmmmmmmmmmm/article.pdf',
                mediaType: 'application/pdf',
                contentHash: versionedSha256(pdfBytes),
                byteLength: pdfBytes.byteLength,
              },
              createdAt: '2026-08-22T11:00:00Z',
            },
            artifactPath: pdfPath,
            manifestPath: `${pdfPath}.json`,
          };
        },
      },
      epub,
      env: environment,
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
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});
