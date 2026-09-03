import path from 'node:path';
import type { FrontmatterValue, ObsidianConfig } from '../domain.ts';
import { assertJsonObject, assertKnownKeys, assertOptionalString, definedProperties, parseStringArray } from './shared.ts';

const OBSIDIAN_KEYS = new Set([
  'vaultPath', 'vaultName', 'inboxFolder', 'attachmentFolder', 'noteNameTemplate', 'tags', 'frontmatter', 'openAfterExport',
]);
const TEMPLATE_VARIABLES = new Set(['title', 'slug', 'id', 'mode', 'date']);
const RESERVED_FRONTMATTER = new Set([
  'piReadsArticleId', 'mode', 'title', 'slug', 'canonicalUrl', 'sourceIds', 'sourceUrls',
  'authors', 'createdAt', 'publishedAt', 'generatedBy', 'tags',
]);

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

function assertFrontmatterKey(key: string): void {
  if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
    throw new Error(`obsidian.frontmatter contains unsafe key ${key}`);
  }
  if (RESERVED_FRONTMATTER.has(key)) {
    throw new Error(`obsidian.frontmatter cannot replace reserved property ${key}`);
  }
  if (!key.trim() || /[\r\n]/u.test(key)) {
    throw new Error('obsidian.frontmatter keys must be non-empty single-line strings');
  }
}

function parseFrontmatterValue(value: unknown, name: string): FrontmatterValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : parseStringArray(value, name);
}

function parseFrontmatter(value: unknown): Record<string, FrontmatterValue> {
  assertJsonObject(value, 'obsidian.frontmatter');
  const parsed: Record<string, FrontmatterValue> = {};
  for (const [key, item] of Object.entries(value)) {
    assertFrontmatterKey(key);
    parsed[key] = parseFrontmatterValue(item, `obsidian.frontmatter.${key}`);
  }
  return parsed;
}

function assertVaultFolder(value: string | undefined, name: string): void {
  if (value === undefined) return;
  const normalized = value.replace(/\/+$/u, '');
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized) || normalized.includes('\\')) {
    throw new Error(`${name} must be vault-relative`);
  }
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${name} contains an unsafe path segment`);
  }
}

function assertNoteTemplate(value: string | undefined): void {
  if (value === undefined) return;
  const placeholders = [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/gu)];
  const unknown = placeholders.map((match) => match[1]).find((name) => !TEMPLATE_VARIABLES.has(name));
  if (unknown) throw new Error(`obsidian.noteNameTemplate contains unsupported variable ${unknown}`);
  if (/\{\{|\}\}/u.test(value.replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, ''))) {
    throw new Error('obsidian.noteNameTemplate is malformed');
  }
}

export function parseObsidianConfig(value: unknown): ObsidianConfig {
  assertJsonObject(value, 'obsidian');
  assertKnownKeys(value, OBSIDIAN_KEYS, 'obsidian');
  if (typeof value.vaultPath !== 'string' || !value.vaultPath.trim()) {
    throw new Error('obsidian.vaultPath must be a non-empty string');
  }
  for (const key of ['vaultName', 'inboxFolder', 'attachmentFolder', 'noteNameTemplate'] as const) {
    assertOptionalString(value[key], `obsidian.${key}`);
  }
  assertVaultFolder(value.inboxFolder as string | undefined, 'obsidian.inboxFolder');
  assertVaultFolder(value.attachmentFolder as string | undefined, 'obsidian.attachmentFolder');
  assertNoteTemplate(value.noteNameTemplate as string | undefined);
  if (value.openAfterExport !== undefined && typeof value.openAfterExport !== 'boolean') {
    throw new Error('obsidian.openAfterExport must be a boolean');
  }
  return definedProperties({
    vaultPath: value.vaultPath,
    vaultName: value.vaultName,
    inboxFolder: value.inboxFolder,
    attachmentFolder: value.attachmentFolder,
    noteNameTemplate: value.noteNameTemplate,
    tags: value.tags === undefined ? undefined : parseStringArray(value.tags, 'obsidian.tags'),
    frontmatter: value.frontmatter === undefined ? undefined : parseFrontmatter(value.frontmatter),
    openAfterExport: value.openAfterExport,
  }) as ObsidianConfig;
}

export function resolveObsidianConfig(config: ObsidianConfig, vaultPath: string): ResolvedObsidianConfig {
  return {
    vaultPath,
    vaultName: config.vaultName ?? path.basename(vaultPath),
    inboxFolder: config.inboxFolder ?? 'Reading Inbox',
    attachmentFolder: config.attachmentFolder ?? 'Attachments/pi-reads',
    noteNameTemplate: config.noteNameTemplate ?? '{{title}}',
    tags: config.tags ?? ['pi-reads'],
    frontmatter: config.frontmatter ?? {},
    openAfterExport: config.openAfterExport ?? false,
  };
}
