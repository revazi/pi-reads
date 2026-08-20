import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ArticleMode, ExportFormat, PiReadsConfig } from './domain.ts';
import { errorMessage } from './errors.ts';

const ARTICLE_MODES: ReadonlySet<ArticleMode> = new Set(['archive', 'digest', 'synthesis']);
const EXPORT_FORMATS: ReadonlySet<ExportFormat> = new Set(['markdown', 'html', 'pdf', 'epub']);

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

export interface ResolvedConfiguration {
  configPath: string;
  libraryDir: string;
  config: PiReadsConfig;
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

export function parseConfig(value: unknown): PiReadsConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pi-reads.json must contain a JSON object');
  }

  const candidate = value as Record<string, unknown>;
  assertKnownKeys(candidate, new Set(['schemaVersion', 'libraryDir', 'defaults']), 'pi-reads.json');
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

  return { configPath, libraryDir, config };
}
