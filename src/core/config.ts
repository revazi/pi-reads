import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PiReadsConfig } from './domain.ts';
import { errorMessage } from './errors.ts';
import { parseDefaultConfig } from './config/defaults.ts';
import {
  parseKindleConfig,
  resolveKindleConfig,
  type ResolvedKindleConfig,
} from './config/kindle.ts';
import {
  parseObsidianConfig,
  resolveObsidianConfig,
  type ResolvedObsidianConfig,
} from './config/obsidian.ts';
import { assertJsonObject, assertKnownKeys, assertOptionalString } from './config/shared.ts';

export type { ResolvedKindleConfig } from './config/kindle.ts';
export type { ResolvedObsidianConfig } from './config/obsidian.ts';

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
  obsidian?: ResolvedObsidianConfig;
  kindle?: ResolvedKindleConfig;
}

export function expandLeadingTilde(value: string, homeDir = os.homedir()): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDir, value.slice(2));
  if (value.startsWith('~')) throw new Error(`Unsupported home-relative path: ${value}`);
  return value;
}

function absolutePath(value: string, baseDir: string, homeDir: string): string {
  return path.resolve(baseDir, expandLeadingTilde(value, homeDir));
}

export function defaultLibraryDir(homeDir = os.homedir()): string {
  return path.join(homeDir, 'Documents', 'pi-reads');
}

export function resolveConfigPath(options: ResolveConfigurationOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const configured = options.configPath ?? env.PI_READS_CONFIG;
  if (configured) return absolutePath(configured, cwd, homeDir);
  const configHome = env.XDG_CONFIG_HOME
    ? absolutePath(env.XDG_CONFIG_HOME, cwd, homeDir)
    : path.join(homeDir, '.config');
  return path.join(configHome, 'pi-reads', 'pi-reads.json');
}

export function parseConfig(value: unknown): PiReadsConfig {
  assertJsonObject(value, 'pi-reads.json');
  assertKnownKeys(value, new Set(['schemaVersion', 'libraryDir', 'defaults', 'obsidian', 'kindle']), 'pi-reads.json');
  if (value.schemaVersion !== 1) throw new Error('pi-reads.json must use schemaVersion 1');
  assertOptionalString(value.libraryDir, 'libraryDir');
  return {
    schemaVersion: 1,
    ...(value.libraryDir === undefined ? {} : { libraryDir: value.libraryDir }),
    ...(value.defaults === undefined ? {} : { defaults: parseDefaultConfig(value.defaults) }),
    ...(value.obsidian === undefined ? {} : { obsidian: parseObsidianConfig(value.obsidian) }),
    ...(value.kindle === undefined ? {} : { kindle: parseKindleConfig(value.kindle) }),
  };
}

export async function readConfig(configPath: string): Promise<PiReadsConfig> {
  let contents: string;
  try {
    contents = await readFile(configPath, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1 };
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
  const obsidian = config.obsidian
    ? resolveObsidianConfig(
        config.obsidian,
        absolutePath(config.obsidian.vaultPath, path.dirname(configPath), homeDir),
      )
    : undefined;
  const kindle = config.kindle ? resolveKindleConfig(config.kindle) : undefined;
  return {
    configPath,
    libraryDir,
    config,
    ...(obsidian ? { obsidian } : {}),
    ...(kindle ? { kindle } : {}),
  };
}
