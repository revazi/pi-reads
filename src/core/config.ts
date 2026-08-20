import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ArticleMode, ExportFormat, FrontmatterValue, KindleConfig, ObsidianConfig, PiReadsConfig } from './domain.ts';
import { errorMessage } from './errors.ts';

const ARTICLE_MODES: ReadonlySet<ArticleMode> = new Set(['archive', 'digest', 'synthesis']);
const EXPORT_FORMATS: ReadonlySet<ExportFormat> = new Set(['markdown', 'html', 'pdf', 'epub']);
const OBSIDIAN_TEMPLATE_VARIABLES = new Set(['title', 'slug', 'id', 'mode', 'date']);
const OBSIDIAN_RESERVED_FRONTMATTER = new Set([
  'piReadsArticleId', 'mode', 'title', 'slug', 'canonicalUrl', 'sourceIds', 'sourceUrls',
  'authors', 'createdAt', 'publishedAt', 'generatedBy', 'tags',
]);

export interface ConfigurationEnvironment {
  PI_READS_CONFIG?: string;
  PI_READS_LIBRARY_DIR?: string;
  XDG_CONFIG_HOME?: string;
}

export interface ResolveConfigurationOptions {
  configPath?: string;
  libraryDir?: string;
  cwd?: string;
  homeDir?: string;
  env?: ConfigurationEnvironment;
}

export interface ResolvedObsidianConfig {
  vaultPath: string;
  vaultName: string;
  inboxFolder: string;
  attachmentFolder: string;
  noteNameTemplate: string;
  tags: string[];
  frontmatter: Record<string, FrontmatterValue>;
  openAfterExport: boolean;
}

export interface ResolvedKindleConfig {
  deviceLabel?: string;
  defaultFormat: 'epub' | 'pdf';
  recipientEnv: string;
  smtp: {
    host?: string;
    port: number;
    secure: boolean;
    userEnv: string;
    passwordEnv: string;
    fromEnv: string;
  };
}

export interface ResolvedConfiguration {
  configPath: string;
  libraryDir: string;
  config: PiReadsConfig;
  obsidian?: ResolvedObsidianConfig;
  kindle?: ResolvedKindleConfig;
}

export function expandLeadingTilde(value: string, homeDir = os.homedir()): string {
  if (value === '~') {
    return homeDir;
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDir, value.slice(2));
  }
  if (value.startsWith('~')) {
    throw new Error(`Unsupported home-relative path: ${value}`);
  }
  return value;
}

function absolutePath(value: string, baseDir: string, homeDir: string): string {
  const expanded = expandLeadingTilde(value, homeDir);
  return path.resolve(baseDir, expanded);
}

export function defaultLibraryDir(homeDir = os.homedir()): string {
  return path.join(homeDir, 'Documents', 'pi-reads');
}

export function resolveConfigPath(options: ResolveConfigurationOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const configured = options.configPath ?? env.PI_READS_CONFIG;
  if (configured) {
    return absolutePath(configured, cwd, homeDir);
  }

  const configHome = env.XDG_CONFIG_HOME
    ? absolutePath(env.XDG_CONFIG_HOME, cwd, homeDir)
    : path.join(homeDir, '.config');
  return path.join(configHome, 'pi-reads', 'pi-reads.json');
}

function assertOptionalString(value: unknown, name: string): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`${name} contains unsupported property ${unknown}`);
  }
}

function parseStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name} must contain non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${name} must not contain duplicates`);
  }
  return value;
}

function parseFrontmatter(value: unknown): Record<string, FrontmatterValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('obsidian.frontmatter must be a JSON object');
  }

  const parsed: Record<string, FrontmatterValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error(`obsidian.frontmatter contains unsafe key ${key}`);
    }
    if (OBSIDIAN_RESERVED_FRONTMATTER.has(key)) {
      throw new Error(`obsidian.frontmatter cannot replace reserved property ${key}`);
    }
    if (!key.trim() || /[\r\n]/u.test(key)) {
      throw new Error('obsidian.frontmatter keys must be non-empty single-line strings');
    }
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      parsed[key] = item;
      continue;
    }
    parsed[key] = parseStringArray(item, `obsidian.frontmatter.${key}`);
  }
  return parsed;
}

function assertObsidianFolder(value: string | undefined, name: string): void {
  if (value === undefined) return;
  const normalized = value.replace(/\/+$/u, '');
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized) || normalized.includes('\\')) {
    throw new Error(`${name} must be vault-relative`);
  }
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${name} contains an unsafe path segment`);
  }
}

function assertObsidianTemplate(value: string | undefined): void {
  if (value === undefined) return;
  const unknown = [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/gu)]
    .map((match) => match[1])
    .find((name) => !OBSIDIAN_TEMPLATE_VARIABLES.has(name));
  if (unknown) {
    throw new Error(`obsidian.noteNameTemplate contains unsupported variable ${unknown}`);
  }
  if (/\{\{|\}\}/u.test(value.replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, ''))) {
    throw new Error('obsidian.noteNameTemplate is malformed');
  }
}

function assertEnvironmentName(value: unknown, name: string): asserts value is string | undefined {
  assertOptionalString(value, name);
  if (value !== undefined && !/^[A-Z_][A-Z0-9_]*$/u.test(value)) {
    throw new Error(`${name} must be an uppercase environment variable name`);
  }
}

function parseKindleConfig(value: unknown): KindleConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('kindle must be a JSON object');
  }
  const candidate = value as Record<string, unknown>;
  assertKnownKeys(candidate, new Set(['deviceLabel', 'defaultFormat', 'recipientEnv', 'smtp']), 'kindle');
  assertOptionalString(candidate.deviceLabel, 'kindle.deviceLabel');
  if (typeof candidate.deviceLabel === 'string' && /[\r\n]/u.test(candidate.deviceLabel)) {
    throw new Error('kindle.deviceLabel must be a single-line string');
  }
  if (candidate.defaultFormat !== undefined && candidate.defaultFormat !== 'epub' && candidate.defaultFormat !== 'pdf') {
    throw new Error('kindle.defaultFormat must be epub or pdf');
  }
  assertEnvironmentName(candidate.recipientEnv, 'kindle.recipientEnv');

  let smtp: KindleConfig['smtp'];
  if (candidate.smtp !== undefined) {
    if (!candidate.smtp || typeof candidate.smtp !== 'object' || Array.isArray(candidate.smtp)) {
      throw new Error('kindle.smtp must be a JSON object');
    }
    const smtpCandidate = candidate.smtp as Record<string, unknown>;
    assertKnownKeys(smtpCandidate, new Set(['host', 'port', 'secure', 'userEnv', 'passwordEnv', 'fromEnv']), 'kindle.smtp');
    assertOptionalString(smtpCandidate.host, 'kindle.smtp.host');
    if (typeof smtpCandidate.host === 'string' && (/[@/\s]/u.test(smtpCandidate.host) || smtpCandidate.host.includes('://'))) {
      throw new Error('kindle.smtp.host must be a hostname, not a URL or email address');
    }
    if (smtpCandidate.port !== undefined && (!Number.isInteger(smtpCandidate.port) || (smtpCandidate.port as number) < 1 || (smtpCandidate.port as number) > 65535)) {
      throw new Error('kindle.smtp.port must be an integer from 1 to 65535');
    }
    if (smtpCandidate.secure !== undefined && typeof smtpCandidate.secure !== 'boolean') {
      throw new Error('kindle.smtp.secure must be a boolean');
    }
    for (const key of ['userEnv', 'passwordEnv', 'fromEnv'] as const) {
      assertEnvironmentName(smtpCandidate[key], `kindle.smtp.${key}`);
    }
    smtp = {
      ...(smtpCandidate.host === undefined ? {} : { host: smtpCandidate.host as string }),
      ...(smtpCandidate.port === undefined ? {} : { port: smtpCandidate.port as number }),
      ...(smtpCandidate.secure === undefined ? {} : { secure: smtpCandidate.secure }),
      ...(smtpCandidate.userEnv === undefined ? {} : { userEnv: smtpCandidate.userEnv as string }),
      ...(smtpCandidate.passwordEnv === undefined ? {} : { passwordEnv: smtpCandidate.passwordEnv as string }),
      ...(smtpCandidate.fromEnv === undefined ? {} : { fromEnv: smtpCandidate.fromEnv as string }),
    };
  }

  return {
    ...(candidate.deviceLabel === undefined ? {} : { deviceLabel: candidate.deviceLabel as string }),
    ...(candidate.defaultFormat === undefined ? {} : { defaultFormat: candidate.defaultFormat as 'epub' | 'pdf' }),
    ...(candidate.recipientEnv === undefined ? {} : { recipientEnv: candidate.recipientEnv as string }),
    ...(smtp === undefined ? {} : { smtp }),
  };
}

function parseObsidianConfig(value: unknown): ObsidianConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('obsidian must be a JSON object');
  }
  const candidate = value as Record<string, unknown>;
  assertKnownKeys(
    candidate,
    new Set(['vaultPath', 'vaultName', 'inboxFolder', 'attachmentFolder', 'noteNameTemplate', 'tags', 'frontmatter', 'openAfterExport']),
    'obsidian',
  );
  if (typeof candidate.vaultPath !== 'string' || !candidate.vaultPath.trim()) {
    throw new Error('obsidian.vaultPath must be a non-empty string');
  }
  for (const key of ['vaultName', 'inboxFolder', 'attachmentFolder', 'noteNameTemplate'] as const) {
    assertOptionalString(candidate[key], `obsidian.${key}`);
  }
  assertObsidianFolder(candidate.inboxFolder as string | undefined, 'obsidian.inboxFolder');
  assertObsidianFolder(candidate.attachmentFolder as string | undefined, 'obsidian.attachmentFolder');
  assertObsidianTemplate(candidate.noteNameTemplate as string | undefined);
  if (candidate.openAfterExport !== undefined && typeof candidate.openAfterExport !== 'boolean') {
    throw new Error('obsidian.openAfterExport must be a boolean');
  }

  return {
    vaultPath: candidate.vaultPath,
    ...(candidate.vaultName === undefined ? {} : { vaultName: candidate.vaultName as string }),
    ...(candidate.inboxFolder === undefined ? {} : { inboxFolder: candidate.inboxFolder as string }),
    ...(candidate.attachmentFolder === undefined ? {} : { attachmentFolder: candidate.attachmentFolder as string }),
    ...(candidate.noteNameTemplate === undefined ? {} : { noteNameTemplate: candidate.noteNameTemplate as string }),
    ...(candidate.tags === undefined ? {} : { tags: parseStringArray(candidate.tags, 'obsidian.tags') }),
    ...(candidate.frontmatter === undefined ? {} : { frontmatter: parseFrontmatter(candidate.frontmatter) }),
    ...(candidate.openAfterExport === undefined ? {} : { openAfterExport: candidate.openAfterExport }),
  };
}

export function parseConfig(value: unknown): PiReadsConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pi-reads.json must contain a JSON object');
  }

  const candidate = value as Record<string, unknown>;
  assertKnownKeys(candidate, new Set(['schemaVersion', 'libraryDir', 'defaults', 'obsidian', 'kindle']), 'pi-reads.json');
  if (candidate.schemaVersion !== 1) {
    throw new Error('pi-reads.json must use schemaVersion 1');
  }

  assertOptionalString(candidate.libraryDir, 'libraryDir');

  let defaults: PiReadsConfig['defaults'];
  if (candidate.defaults !== undefined) {
    if (!candidate.defaults || typeof candidate.defaults !== 'object' || Array.isArray(candidate.defaults)) {
      throw new Error('defaults must be a JSON object');
    }

    const configuredDefaults = candidate.defaults as Record<string, unknown>;
    assertKnownKeys(configuredDefaults, new Set(['mode', 'exportFormat']), 'defaults');
    const mode = configuredDefaults.mode;
    const exportFormat = configuredDefaults.exportFormat;
    if (mode !== undefined && (typeof mode !== 'string' || !ARTICLE_MODES.has(mode as ArticleMode))) {
      throw new Error(`Unsupported default article mode: ${String(mode)}`);
    }
    if (
      exportFormat !== undefined &&
      (typeof exportFormat !== 'string' || !EXPORT_FORMATS.has(exportFormat as ExportFormat))
    ) {
      throw new Error(`Unsupported default export format: ${String(exportFormat)}`);
    }

    defaults = {
      ...(mode === undefined ? {} : { mode: mode as ArticleMode }),
      ...(exportFormat === undefined ? {} : { exportFormat: exportFormat as ExportFormat }),
    };
  }

  return {
    schemaVersion: 1,
    ...(candidate.libraryDir === undefined ? {} : { libraryDir: candidate.libraryDir }),
    ...(defaults === undefined ? {} : { defaults }),
    ...(candidate.obsidian === undefined ? {} : { obsidian: parseObsidianConfig(candidate.obsidian) }),
    ...(candidate.kindle === undefined ? {} : { kindle: parseKindleConfig(candidate.kindle) }),
  };
}

export async function readConfig(configPath: string): Promise<PiReadsConfig> {
  let contents: string;
  try {
    contents = await readFile(configPath, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1 };
    }
    throw new Error(`Could not read ${configPath}: ${errorMessage(error)}`);
  }

  try {
    return parseConfig(JSON.parse(contents) as unknown);
  } catch (error: unknown) {
    throw new Error(`Invalid ${configPath}: ${errorMessage(error)}`);
  }
}

export async function resolveConfiguration(
  options: ResolveConfigurationOptions = {},
): Promise<ResolvedConfiguration> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigPath({ ...options, env, homeDir, cwd });
  const config = await readConfig(configPath);
  const explicitLibraryDir = options.libraryDir ?? env.PI_READS_LIBRARY_DIR;
  const configuredLibraryDir = explicitLibraryDir ?? config.libraryDir;
  const baseDir = explicitLibraryDir ? cwd : path.dirname(configPath);
  const libraryDir = configuredLibraryDir
    ? absolutePath(configuredLibraryDir, baseDir, homeDir)
    : defaultLibraryDir(homeDir);
  const obsidianVaultPath = config.obsidian
    ? absolutePath(config.obsidian.vaultPath, path.dirname(configPath), homeDir)
    : undefined;
  const obsidian = config.obsidian && obsidianVaultPath
    ? {
        vaultPath: obsidianVaultPath,
        vaultName: config.obsidian.vaultName ?? path.basename(obsidianVaultPath),
        inboxFolder: config.obsidian.inboxFolder ?? 'Reading Inbox',
        attachmentFolder: config.obsidian.attachmentFolder ?? 'Attachments/pi-reads',
        noteNameTemplate: config.obsidian.noteNameTemplate ?? '{{title}}',
        tags: config.obsidian.tags ?? ['pi-reads'],
        frontmatter: config.obsidian.frontmatter ?? {},
        openAfterExport: config.obsidian.openAfterExport ?? false,
      }
    : undefined;

  const kindle = config.kindle
    ? {
        ...(config.kindle.deviceLabel ? { deviceLabel: config.kindle.deviceLabel } : {}),
        defaultFormat: config.kindle.defaultFormat ?? 'epub',
        recipientEnv: config.kindle.recipientEnv ?? 'PI_READS_KINDLE_ADDRESS',
        smtp: {
          ...(config.kindle.smtp?.host ? { host: config.kindle.smtp.host } : {}),
          port: config.kindle.smtp?.port ?? 587,
          secure: config.kindle.smtp?.secure ?? false,
          userEnv: config.kindle.smtp?.userEnv ?? 'PI_READS_SMTP_USER',
          passwordEnv: config.kindle.smtp?.passwordEnv ?? 'PI_READS_SMTP_PASSWORD',
          fromEnv: config.kindle.smtp?.fromEnv ?? 'PI_READS_SMTP_FROM',
        },
      }
    : undefined;

  return {
    configPath,
    libraryDir,
    config,
    ...(obsidian ? { obsidian } : {}),
    ...(kindle ? { kindle } : {}),
  };
}
