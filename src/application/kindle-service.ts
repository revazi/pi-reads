import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExportRecord } from '../core/domain.ts';
import {
  createImmutableRecordDirectory,
  createRecordId,
  exportDirectory,
  resolveLibraryPath,
  type RecordIdPrefix,
} from '../core/library.ts';
import { versionedSha256 } from '../core/text.ts';
import {
  NodemailerKindleTransport,
  redactEmail,
  type KindleMailTransport,
  type SmtpSettings,
} from '../adapters/destinations/kindle.ts';
import type { PreparedEpubExport } from './epub-service.ts';
import type { PreparedExport } from './export-service.ts';
import { LibraryService } from './library-service.ts';

export type KindleFormat = 'epub' | 'pdf';

export interface KindleEnvironment {
  PI_READS_KINDLE_ADDRESS?: string;
  PI_READS_KINDLE_DEVICE_LABEL?: string;
  PI_READS_SMTP_HOST?: string;
  PI_READS_SMTP_PORT?: string;
  PI_READS_SMTP_SECURE?: string;
  PI_READS_SMTP_USER?: string;
  PI_READS_SMTP_PASSWORD?: string;
  PI_READS_SMTP_FROM?: string;
}

export interface KindleLocalExportPort {
  prepare(articleId: string, format: 'pdf', signal?: AbortSignal): Promise<PreparedExport>;
}

export interface KindleEpubExportPort {
  prepare(articleId: string, signal?: AbortSignal): Promise<PreparedEpubExport>;
}

export interface KindleServiceOptions {
  library: LibraryService;
  exports: KindleLocalExportPort;
  epub: KindleEpubExportPort;
  env?: KindleEnvironment;
  transport?: KindleMailTransport;
  now?: () => Date;
  createId?: (prefix: RecordIdPrefix) => string;
}

export interface KindlePreview {
  articleId: string;
  format: KindleFormat;
  recipient: string;
  redactedRecipient: string;
  deviceLabel?: string;
  subject: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  size: number;
  localExportId: string;
  artifactPath: string;
  localManifestPath: string;
}

export interface DeliveredKindleExport {
  record: ExportRecord;
  manifestPath: string;
  artifactPath: string;
  redactedRecipient: string;
  localArtifactPath: string;
}

export class KindleDeliveryError extends Error {
  readonly artifactPath: string;

  constructor(message: string, artifactPath: string) {
    super(`${message} Local export retained at ${artifactPath}`);
    this.name = 'KindleDeliveryError';
    this.artifactPath = artifactPath;
  }
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function assertEmail(value: string, name: string): string {
  if (/\r|\n/u.test(value) || !/^[^\s@]+@[^\s@]+$/u.test(value)) {
    throw new Error(`${name} must be a valid email address`);
  }
  return value;
}

function kindleRecipient(env: KindleEnvironment): string {
  const recipient = assertEmail(required(env.PI_READS_KINDLE_ADDRESS, 'PI_READS_KINDLE_ADDRESS'), 'PI_READS_KINDLE_ADDRESS');
  if (!recipient.toLowerCase().endsWith('@kindle.com')) {
    throw new Error('PI_READS_KINDLE_ADDRESS must use the kindle.com domain');
  }
  return recipient;
}

function smtpSettings(env: KindleEnvironment): { settings: SmtpSettings; from: string } {
  const portValue = env.PI_READS_SMTP_PORT?.trim() || '587';
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PI_READS_SMTP_PORT must be an integer from 1 to 65535');
  }
  const secureValue = env.PI_READS_SMTP_SECURE?.trim().toLowerCase() || 'false';
  if (secureValue !== 'true' && secureValue !== 'false') {
    throw new Error('PI_READS_SMTP_SECURE must be true or false');
  }
  return {
    settings: {
      host: required(env.PI_READS_SMTP_HOST, 'PI_READS_SMTP_HOST'),
      port,
      secure: secureValue === 'true',
      user: required(env.PI_READS_SMTP_USER, 'PI_READS_SMTP_USER'),
      password: required(env.PI_READS_SMTP_PASSWORD, 'PI_READS_SMTP_PASSWORD'),
    },
    from: assertEmail(required(env.PI_READS_SMTP_FROM, 'PI_READS_SMTP_FROM'), 'PI_READS_SMTP_FROM'),
  };
}

function safeSubject(title: string): string {
  return `Pi Reads: ${title.replace(/[\r\n\u0000-\u001f]+/gu, ' ').trim()}`.slice(0, 200);
}

function safeFilename(slug: string, format: KindleFormat): string {
  const safe = slug.replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '') || 'article';
  return `${safe}.${format}`;
}

function isEpubExport(value: PreparedExport | PreparedEpubExport): value is PreparedEpubExport {
  return value.record.format === 'epub';
}

export class KindleService {
  private readonly library: LibraryService;
  private readonly exports: KindleLocalExportPort;
  private readonly epub: KindleEpubExportPort;
  private readonly env: KindleEnvironment;
  private readonly transport?: KindleMailTransport;
  private readonly now: () => Date;
  private readonly createId: (prefix: RecordIdPrefix) => string;

  constructor(options: KindleServiceOptions) {
    this.library = options.library;
    this.exports = options.exports;
    this.epub = options.epub;
    this.env = options.env ?? process.env;
    this.transport = options.transport;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((prefix) => createRecordId(prefix));
  }

  async preview(articleId: string, format: KindleFormat, signal?: AbortSignal): Promise<KindlePreview> {
    signal?.throwIfAborted();
    const article = await this.library.loadArticle(articleId);
    const prepared: PreparedExport | PreparedEpubExport = format === 'epub'
      ? await this.epub.prepare(articleId, signal)
      : await this.exports.prepare(articleId, 'pdf', signal);
    const bytes = new Uint8Array(await readFile(prepared.artifactPath));
    const recipient = kindleRecipient(this.env);
    const contentType = format === 'epub' ? 'application/epub+zip' : 'application/pdf';
    if (isEpubExport(prepared) && prepared.validation.spineItems === 0) {
      throw new Error('EPUB has no readable spine content');
    }
    return {
      articleId,
      format,
      recipient,
      redactedRecipient: redactEmail(recipient),
      ...(this.env.PI_READS_KINDLE_DEVICE_LABEL?.trim()
        ? { deviceLabel: this.env.PI_READS_KINDLE_DEVICE_LABEL.trim() }
        : {}),
      subject: safeSubject(article.article.title),
      filename: safeFilename(article.article.slug, format),
      contentType,
      bytes,
      size: bytes.byteLength,
      localExportId: prepared.record.id,
      artifactPath: prepared.artifactPath,
      localManifestPath: prepared.manifestPath,
    };
  }

  async deliver(
    preview: KindlePreview,
    confirmation: { confirmedAt: string; confirmationMethod: 'interactive' },
    signal?: AbortSignal,
  ): Promise<DeliveredKindleExport> {
    if (!confirmation.confirmedAt || confirmation.confirmationMethod !== 'interactive') {
      throw new Error('Kindle delivery requires interactive confirmation');
    }
    signal?.throwIfAborted();
    const smtp = smtpSettings(this.env);
    const transport = this.transport ?? new NodemailerKindleTransport(smtp.settings);
    try {
      await transport.send({
        from: smtp.from,
        to: preview.recipient,
        subject: preview.subject,
        filename: preview.filename,
        content: preview.bytes,
        contentType: preview.contentType,
      }, signal);
    } catch {
      throw new KindleDeliveryError('Kindle delivery failed.', preview.artifactPath);
    }

    const deliveredAt = this.now().toISOString();
    const exportId = this.createId('exp');
    const directory = exportDirectory(preview.articleId, exportId);
    const artifactRelativePath = path.posix.join(directory, preview.filename);
    const record: ExportRecord = {
      schemaVersion: 1,
      id: exportId,
      articleId: preview.articleId,
      format: preview.format,
      destination: {
        type: 'kindle',
        ...(preview.deviceLabel ? { deviceLabel: preview.deviceLabel } : {}),
      },
      status: 'delivered',
      artifact: {
        path: artifactRelativePath,
        mediaType: preview.contentType,
        contentHash: versionedSha256(preview.bytes),
        byteLength: preview.size,
      },
      createdAt: deliveredAt,
      delivery: {
        attemptedAt: confirmation.confirmedAt,
        confirmedAt: confirmation.confirmedAt,
        confirmationMethod: 'interactive',
        deliveredAt,
      },
    };
    try {
      await createImmutableRecordDirectory(
        this.library.libraryDir,
        directory,
        [
          { path: preview.filename, contents: preview.bytes },
          { path: 'manifest.json', contents: `${JSON.stringify(record, null, 2)}\n` },
        ],
      );
    } catch {
      throw new KindleDeliveryError('Kindle email may have been sent, but delivery evidence could not be stored.', preview.artifactPath);
    }
    return {
      record,
      manifestPath: resolveLibraryPath(this.library.libraryDir, path.posix.join(directory, 'manifest.json')),
      artifactPath: resolveLibraryPath(this.library.libraryDir, artifactRelativePath),
      redactedRecipient: preview.redactedRecipient,
      localArtifactPath: preview.artifactPath,
    };
  }
}
