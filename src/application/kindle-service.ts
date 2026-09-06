import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExportRecord, Sha256Digest } from '../core/domain.ts';
import type { ResolvedKindleConfig } from '../core/config.ts';
import {
  createImmutableRecordDirectory,
  createRecordId,
  exportDirectory,
  exportTargetId,
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
import type { KindleCredentialStore, KindleSmtpCredentials } from './kindle-credentials.ts';
import type { PreparedExport } from './export-service.ts';
import { LibraryService } from './library-service.ts';
import { ReadingCollectionService } from './reading-collection-service.ts';

export type KindleFormat = 'epub' | 'pdf';
type KindleTarget = { articleId: string; collectionId?: never } | { collectionId: string; articleId?: never };

export interface KindleEnvironment {
  [name: string]: string | undefined;
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
  collections?: ReadingCollectionService;
  exports: KindleLocalExportPort;
  epub: KindleEpubExportPort;
  env?: KindleEnvironment;
  config?: ResolvedKindleConfig;
  credentialStore?: KindleCredentialStore;
  transport?: KindleMailTransport;
  now?: () => Date;
  createId?: (prefix: RecordIdPrefix) => string;
}

interface KindlePreviewFields {
  format: KindleFormat;
  recipient: string;
  redactedRecipient: string;
  deviceLabel?: string;
  subject: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  size: number;
  contentHash: Sha256Digest;
  localExportId: string;
  artifactPath: string;
  localManifestPath: string;
}

export type KindlePreview = KindlePreviewFields & KindleTarget;

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
  if (/\r|\n/u.test(value) || !/^[^\s@]+@[^\s@]+$/u.test(value)) throw new Error(`${name} must be a valid email address`);
  return value;
}

function kindleRecipient(env: KindleEnvironment, config: ResolvedKindleConfig | undefined, storedRecipient: string | undefined): string {
  const envName = config?.recipientEnv ?? 'PI_READS_KINDLE_ADDRESS';
  const recipient = assertEmail(required(env[envName] ?? storedRecipient, `${envName} or stored Kindle recipient`), 'Kindle recipient');
  if (!recipient.toLowerCase().endsWith('@kindle.com')) throw new Error('PI_READS_KINDLE_ADDRESS must use the kindle.com domain');
  return recipient;
}

function smtpSettings(
  env: KindleEnvironment,
  config: ResolvedKindleConfig | undefined,
  credentials: KindleSmtpCredentials | undefined,
): { settings: SmtpSettings; from: string } {
  const portValue = env.PI_READS_SMTP_PORT?.trim() || String(config?.smtp.port ?? 587);
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PI_READS_SMTP_PORT must be an integer from 1 to 65535');
  const secureValue = env.PI_READS_SMTP_SECURE?.trim().toLowerCase() || String(config?.smtp.secure ?? false);
  if (secureValue !== 'true' && secureValue !== 'false') throw new Error('PI_READS_SMTP_SECURE must be true or false');
  return {
    settings: {
      host: required(env.PI_READS_SMTP_HOST ?? config?.smtp.host, 'PI_READS_SMTP_HOST or kindle.smtp.host'),
      port,
      secure: secureValue === 'true',
      user: required(env[config?.smtp.userEnv ?? 'PI_READS_SMTP_USER'] ?? credentials?.user, `${config?.smtp.userEnv ?? 'PI_READS_SMTP_USER'} or stored SMTP username`),
      password: required(env[config?.smtp.passwordEnv ?? 'PI_READS_SMTP_PASSWORD'] ?? credentials?.password, `${config?.smtp.passwordEnv ?? 'PI_READS_SMTP_PASSWORD'} or stored SMTP password`),
    },
    from: assertEmail(required(env[config?.smtp.fromEnv ?? 'PI_READS_SMTP_FROM'] ?? credentials?.from, `${config?.smtp.fromEnv ?? 'PI_READS_SMTP_FROM'} or stored SMTP sender`), 'SMTP sender'),
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

interface VerifiedPreparedKindleExport {
  record: ExportRecord;
  manifestPath: string;
  artifactPath: string;
  bytes: Uint8Array;
}

function assertPreparedExportId(value: string): void {
  if (!/^exp_[a-z0-9]{16,64}$/u.test(value)) throw new Error(`Invalid prepared export ID: ${value}`);
}

function parsePreparedExportRecord(value: unknown, preparedExportId: string): ExportRecord {
  if (!value || typeof value !== 'object') throw new Error(`Prepared export ${preparedExportId} has an invalid manifest`);
  const record = value as Partial<ExportRecord>;
  const targetCount = Number(typeof record.articleId === 'string') + Number(typeof record.collectionId === 'string');
  const valid = [
    record.schemaVersion === 1,
    typeof record.id === 'string',
    targetCount === 1,
    typeof record.format === 'string',
    Boolean(record.destination) && typeof record.destination === 'object',
    record.destination?.type === 'local',
    record.status === 'prepared',
    Boolean(record.artifact),
    typeof record.artifact?.path === 'string',
    typeof record.artifact?.mediaType === 'string',
    typeof record.artifact?.contentHash === 'string',
    typeof record.artifact?.byteLength === 'number',
  ];
  if (!valid.every(Boolean)) throw new Error(`Prepared export ${preparedExportId} has an invalid manifest`);
  return record as ExportRecord;
}

async function readRegularFile(filePath: string, label: string): Promise<Buffer> {
  let metadata;
  try { metadata = await lstat(filePath); } catch { throw new Error(`${label} is missing`); }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return readFile(filePath);
}

function isArticleTarget(target: KindleTarget): target is { articleId: string; collectionId?: never } {
  return typeof target.articleId === 'string';
}

function targetFromPreview(preview: KindlePreview): KindleTarget {
  return isArticleTarget(preview) ? { articleId: preview.articleId } : { collectionId: preview.collectionId };
}

export class KindleService {
  private readonly library: LibraryService;
  private readonly collections: ReadingCollectionService;
  private readonly exports: KindleLocalExportPort;
  private readonly epub: KindleEpubExportPort;
  private readonly env: KindleEnvironment;
  private readonly config?: ResolvedKindleConfig;
  private readonly credentialStore?: KindleCredentialStore;
  private readonly transport?: KindleMailTransport;
  private readonly now: () => Date;
  private readonly createId: (prefix: RecordIdPrefix) => string;

  constructor(options: KindleServiceOptions) {
    this.library = options.library;
    this.collections = options.collections ?? new ReadingCollectionService({ library: options.library });
    this.exports = options.exports;
    this.epub = options.epub;
    this.env = options.env ?? process.env;
    this.config = options.config;
    this.credentialStore = options.credentialStore;
    this.transport = options.transport;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((prefix) => createRecordId(prefix));
  }

  private credentialProfile(): string { return this.config?.credentialProfile ?? 'default'; }

  private assertCredentialStore(): KindleCredentialStore {
    if (!this.credentialStore) throw new Error('System Kindle credential storage is unavailable');
    return this.credentialStore;
  }

  private async storedRecipient(needed: boolean, signal?: AbortSignal): Promise<string | undefined> {
    if (!needed || this.config?.credentialStore !== 'system') return undefined;
    const recipient = await this.assertCredentialStore().getRecipient(this.credentialProfile(), signal);
    if (!recipient) throw new Error('Kindle recipient is not configured; run /reads-config');
    return recipient;
  }

  private async storedSmtp(needed: boolean, signal?: AbortSignal): Promise<KindleSmtpCredentials | undefined> {
    if (!needed || this.config?.credentialStore !== 'system') return undefined;
    const credentials = await this.assertCredentialStore().getSmtp(this.credentialProfile(), signal);
    if (!credentials) throw new Error('Kindle SMTP credentials are not configured; run /reads-config');
    return credentials;
  }

  private async loadPrepared(
    target: KindleTarget,
    format: KindleFormat,
    preparedExportId: string,
    signal?: AbortSignal,
  ): Promise<VerifiedPreparedKindleExport> {
    assertPreparedExportId(preparedExportId);
    signal?.throwIfAborted();
    const targetId = isArticleTarget(target) ? target.articleId : target.collectionId;
    const directory = exportDirectory(targetId, preparedExportId);
    const manifestPath = resolveLibraryPath(this.library.libraryDir, path.posix.join(directory, 'manifest.json'));
    const manifestBytes = await readRegularFile(manifestPath, `Prepared export ${preparedExportId} manifest`);
    let parsed: unknown;
    try { parsed = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error(`Prepared export ${preparedExportId} has an invalid manifest`); }
    const record = parsePreparedExportRecord(parsed, preparedExportId);
    const expectedMediaType = format === 'epub' ? 'application/epub+zip' : 'application/pdf';
    const expectedFilename = isArticleTarget(target) ? `article.${format}` : 'collection.epub';
    const expectedArtifactPath = path.posix.join(directory, expectedFilename);
    if (record.id !== preparedExportId || exportTargetId(record) !== targetId) {
      throw new Error(`Prepared export ${preparedExportId} does not belong to ${targetId}`);
    }
    if (record.format !== format || record.artifact.mediaType !== expectedMediaType) throw new Error(`Prepared export ${preparedExportId} is not a ${format} artifact`);
    if (record.artifact.path !== expectedArtifactPath) throw new Error(`Prepared export ${preparedExportId} references an unexpected artifact path`);
    const artifactPath = resolveLibraryPath(this.library.libraryDir, record.artifact.path);
    const bytes = new Uint8Array(await readRegularFile(artifactPath, `Prepared export ${preparedExportId} artifact`));
    signal?.throwIfAborted();
    if (record.artifact.contentHash !== versionedSha256(bytes) || !Number.isSafeInteger(record.artifact.byteLength) || record.artifact.byteLength !== bytes.byteLength) {
      throw new Error(`Prepared export ${preparedExportId} failed artifact integrity verification`);
    }
    return { record, manifestPath, artifactPath, bytes };
  }

  private async targetMetadata(target: KindleTarget): Promise<{ title: string; slug: string }> {
    if (isArticleTarget(target)) {
      const { article } = await this.library.loadArticle(target.articleId);
      return { title: article.title, slug: article.slug };
    }
    const { collection } = await this.collections.load(target.collectionId);
    return { title: collection.title, slug: collection.slug };
  }

  private async previewVerified(
    target: KindleTarget,
    format: KindleFormat,
    prepared: VerifiedPreparedKindleExport,
    signal?: AbortSignal,
  ): Promise<KindlePreview> {
    const metadata = await this.targetMetadata(target);
    const recipientEnv = this.config?.recipientEnv ?? 'PI_READS_KINDLE_ADDRESS';
    const storedRecipient = await this.storedRecipient(!this.env[recipientEnv]?.trim(), signal);
    const recipient = kindleRecipient(this.env, this.config, storedRecipient);
    return {
      ...target,
      format,
      recipient,
      redactedRecipient: redactEmail(recipient),
      ...(this.env.PI_READS_KINDLE_DEVICE_LABEL?.trim() || this.config?.deviceLabel
        ? { deviceLabel: this.env.PI_READS_KINDLE_DEVICE_LABEL?.trim() || this.config?.deviceLabel }
        : {}),
      subject: safeSubject(metadata.title),
      filename: safeFilename(metadata.slug, format),
      contentType: prepared.record.artifact.mediaType,
      bytes: prepared.bytes,
      size: prepared.bytes.byteLength,
      contentHash: prepared.record.artifact.contentHash,
      localExportId: prepared.record.id,
      artifactPath: prepared.artifactPath,
      localManifestPath: prepared.manifestPath,
    };
  }

  async preview(articleId: string, format: KindleFormat, signal?: AbortSignal): Promise<KindlePreview> {
    signal?.throwIfAborted();
    const prepared: PreparedExport | PreparedEpubExport = format === 'epub'
      ? await this.epub.prepare(articleId, signal)
      : await this.exports.prepare(articleId, 'pdf', signal);
    if (isEpubExport(prepared) && prepared.validation.spineItems === 0) throw new Error('EPUB has no readable spine content');
    const target = { articleId };
    return this.previewVerified(target, format, await this.loadPrepared(target, format, prepared.record.id, signal), signal);
  }

  async previewPrepared(articleId: string, format: KindleFormat, preparedExportId: string, signal?: AbortSignal): Promise<KindlePreview> {
    const target = { articleId };
    return this.previewVerified(target, format, await this.loadPrepared(target, format, preparedExportId, signal), signal);
  }

  async previewPreparedCollection(collectionId: string, preparedExportId: string, signal?: AbortSignal): Promise<KindlePreview> {
    const target = { collectionId };
    return this.previewVerified(target, 'epub', await this.loadPrepared(target, 'epub', preparedExportId, signal), signal);
  }

  async deliver(
    preview: KindlePreview,
    confirmation: { confirmedAt: string; confirmationMethod: 'interactive' },
    signal?: AbortSignal,
  ): Promise<DeliveredKindleExport> {
    if (!confirmation.confirmedAt || confirmation.confirmationMethod !== 'interactive') throw new Error('Kindle delivery requires interactive confirmation');
    signal?.throwIfAborted();
    const target = targetFromPreview(preview);
    const targetId = isArticleTarget(target) ? target.articleId : target.collectionId;
    const prepared = await this.loadPrepared(target, preview.format, preview.localExportId, signal);
    if (
      prepared.record.artifact.contentHash !== preview.contentHash ||
      prepared.record.artifact.mediaType !== preview.contentType ||
      prepared.artifactPath !== preview.artifactPath ||
      prepared.manifestPath !== preview.localManifestPath ||
      prepared.bytes.byteLength !== preview.size ||
      versionedSha256(preview.bytes) !== preview.contentHash
    ) throw new Error(`Prepared export ${preview.localExportId} no longer matches the confirmed preview`);
    const userEnv = this.config?.smtp.userEnv ?? 'PI_READS_SMTP_USER';
    const passwordEnv = this.config?.smtp.passwordEnv ?? 'PI_READS_SMTP_PASSWORD';
    const fromEnv = this.config?.smtp.fromEnv ?? 'PI_READS_SMTP_FROM';
    const needsStoredCredentials = !this.env[userEnv]?.trim() || !this.env[passwordEnv]?.trim() || !this.env[fromEnv]?.trim();
    const credentials = await this.storedSmtp(needsStoredCredentials, signal);
    const smtp = smtpSettings(this.env, this.config, credentials);
    const transport = this.transport ?? new NodemailerKindleTransport(smtp.settings);
    try {
      await transport.send({
        from: smtp.from,
        to: preview.recipient,
        subject: preview.subject,
        filename: preview.filename,
        content: prepared.bytes,
        contentType: prepared.record.artifact.mediaType,
      }, signal);
    } catch {
      throw new KindleDeliveryError('Kindle delivery failed.', preview.artifactPath);
    }

    const deliveredAt = this.now().toISOString();
    const exportId = this.createId('exp');
    const directory = exportDirectory(targetId, exportId);
    const record: ExportRecord = {
      schemaVersion: 1,
      id: exportId,
      ...target,
      format: preview.format,
      destination: { type: 'kindle', ...(preview.deviceLabel ? { deviceLabel: preview.deviceLabel } : {}) },
      status: 'delivered',
      artifact: { ...prepared.record.artifact },
      createdAt: deliveredAt,
      delivery: {
        preparedExportId: preview.localExportId,
        attemptedAt: confirmation.confirmedAt,
        confirmedAt: confirmation.confirmedAt,
        confirmationMethod: 'interactive',
        deliveredAt,
      },
    };
    try {
      await createImmutableRecordDirectory(this.library.libraryDir, directory, [{ path: 'manifest.json', contents: `${JSON.stringify(record, null, 2)}\n` }]);
    } catch {
      throw new KindleDeliveryError('Kindle email may have been sent, but delivery evidence could not be stored.', preview.artifactPath);
    }
    return {
      record,
      manifestPath: resolveLibraryPath(this.library.libraryDir, path.posix.join(directory, 'manifest.json')),
      artifactPath: prepared.artifactPath,
      redactedRecipient: preview.redactedRecipient,
      localArtifactPath: preview.artifactPath,
    };
  }
}
