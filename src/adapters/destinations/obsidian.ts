import { link, lstat, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { errorMessage } from '../../core/errors.ts';
import { assertPublicHttpUrl } from '../../core/network.ts';
import { versionedSha256 } from '../../core/text.ts';

export interface ObsidianVaultFile {
  relativePath: string;
  contents: Uint8Array | string;
}

export interface ObsidianVaultInspection {
  conflicts: string[];
  unchanged: string[];
  missing: string[];
}

export interface ObsidianVaultWrite {
  changedPaths: string[];
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface DownloadedAsset {
  contents: Uint8Array;
  mediaType: string;
}

const DEFAULT_MAX_ASSET_BYTES = 20 * 1024 * 1024;

export function validateVaultRelativePath(relativePath: string, label = 'Obsidian path'): string {
  const normalized = relativePath.replace(/\/+$/u, '');
  if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized) || normalized.includes('\\')) {
    throw new Error(`${label} must be a non-empty vault-relative path: ${relativePath}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${label} contains an unsafe segment: ${relativePath}`);
  }
  return segments.join('/');
}

function resolveVaultPath(vaultPath: string, relativePath: string): string {
  const safe = validateVaultRelativePath(relativePath);
  const root = path.resolve(vaultPath);
  const resolved = path.resolve(root, ...safe.split('/'));
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Obsidian path escapes the vault: ${relativePath}`);
  }
  return resolved;
}

async function assertVault(vaultPath: string): Promise<string> {
  const absolute = path.resolve(vaultPath);
  const info = await stat(absolute).catch((error: unknown) => {
    throw new Error(`Could not open Obsidian vault ${absolute}: ${errorMessage(error)}`);
  });
  if (!info.isDirectory()) {
    throw new Error(`Obsidian vault is not a directory: ${absolute}`);
  }
  return realpath(absolute);
}

async function assertSafeExistingParents(canonicalVault: string, relativePath: string): Promise<void> {
  const segments = validateVaultRelativePath(relativePath).split('/');
  segments.pop();
  let current = canonicalVault;
  for (const segment of segments) {
    const next = path.join(current, segment);
    let info;
    try {
      info = await lstat(next);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      const linked = await realpath(next);
      if (linked !== canonicalVault && !linked.startsWith(`${canonicalVault}${path.sep}`)) {
        throw new Error(`Obsidian path crosses a symlink outside the vault: ${relativePath}`);
      }
      current = linked;
      continue;
    }
    if (!info.isDirectory()) {
      throw new Error(`Obsidian path parent is not a directory: ${relativePath}`);
    }
    current = await realpath(next);
  }
}

async function ensureSafeParent(canonicalVault: string, relativePath: string): Promise<string> {
  const safe = validateVaultRelativePath(relativePath);
  const segments = safe.split('/');
  const filename = segments.pop();
  if (!filename) {
    throw new Error(`Obsidian file path is required: ${relativePath}`);
  }

  let current = canonicalVault;
  for (const segment of segments) {
    const next = path.join(current, segment);
    await mkdir(next).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    });
    const info = await lstat(next);
    if (info.isSymbolicLink()) {
      const linked = await realpath(next);
      if (linked !== canonicalVault && !linked.startsWith(`${canonicalVault}${path.sep}`)) {
        throw new Error(`Obsidian path crosses a symlink outside the vault: ${relativePath}`);
      }
      current = linked;
      continue;
    }
    if (!info.isDirectory()) {
      throw new Error(`Obsidian path parent is not a directory: ${relativePath}`);
    }
    current = await realpath(next);
    if (current !== canonicalVault && !current.startsWith(`${canonicalVault}${path.sep}`)) {
      throw new Error(`Obsidian path escapes the vault: ${relativePath}`);
    }
  }

  return path.join(current, filename);
}

function bytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value) : value;
}

function assertExpectedExistingHash(
  expectedHashes: Readonly<Record<string, string | null>> | undefined,
  relativePath: string,
  existing: Uint8Array | undefined,
): void {
  if (!Object.hasOwn(expectedHashes ?? {}, relativePath)) return;
  const currentHash = existing ? versionedSha256(existing) : null;
  if (currentHash !== expectedHashes![relativePath]) {
    throw new Error(`Obsidian target changed after preview: ${relativePath}`);
  }
}

export async function readObsidianVaultFile(
  vaultPath: string,
  relativePath: string,
): Promise<Uint8Array | undefined> {
  const canonicalVault = await assertVault(vaultPath);
  await assertSafeExistingParents(canonicalVault, relativePath);
  const target = resolveVaultPath(canonicalVault, relativePath);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Obsidian target must be a regular file: ${relativePath}`);
    }
    return new Uint8Array(await readFile(target));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Could not read Obsidian path ${relativePath}: ${errorMessage(error)}`);
  }
}

export async function inspectObsidianVault(
  vaultPath: string,
  files: readonly ObsidianVaultFile[],
): Promise<ObsidianVaultInspection> {
  const canonicalVault = await assertVault(vaultPath);
  const conflicts: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];

  for (const file of files) {
    await assertSafeExistingParents(canonicalVault, file.relativePath);
    const target = resolveVaultPath(canonicalVault, file.relativePath);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Obsidian export target must be a regular file: ${file.relativePath}`);
      }
      const existing = await readFile(target);
      if (versionedSha256(existing) === versionedSha256(bytes(file.contents))) {
        unchanged.push(file.relativePath);
      } else {
        conflicts.push(file.relativePath);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        missing.push(file.relativePath);
        continue;
      }
      throw new Error(`Could not inspect Obsidian path ${file.relativePath}: ${errorMessage(error)}`);
    }
  }

  return { conflicts, unchanged, missing };
}

export async function writeObsidianVault(
  vaultPath: string,
  files: readonly ObsidianVaultFile[],
  options: { overwrite?: boolean; expectedExistingHashes?: Readonly<Record<string, string | null>> } = {},
): Promise<ObsidianVaultWrite> {
  const canonicalVault = await assertVault(vaultPath);
  const changedPaths: string[] = [];
  const createdPaths: string[] = [];
  const backups = new Map<string, Uint8Array>();
  const backupFiles: string[] = [];

  try {
    for (const file of files) {
      const target = await ensureSafeParent(canonicalVault, file.relativePath);
      const contents = bytes(file.contents);
      let existing: Uint8Array | undefined;
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new Error(`Obsidian export target must be a regular file: ${file.relativePath}`);
        }
        existing = await readFile(target);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      assertExpectedExistingHash(options.expectedExistingHashes, file.relativePath, existing);

      if (existing && versionedSha256(existing) === versionedSha256(contents)) {
        continue;
      }
      if (existing && !options.overwrite) {
        throw new Error(`Obsidian export conflict: ${file.relativePath}`);
      }

      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
      await writeFile(temporary, contents, { flag: 'wx' });
      try {
        if (existing) {
          const backup = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.bak`);
          await rename(target, backup);
          backups.set(target, existing);
          backupFiles.push(backup);
          try {
            await rename(temporary, target);
          } catch (error: unknown) {
            await rename(backup, target).catch(() => undefined);
            throw error;
          }
        } else {
          try {
            await link(temporary, target);
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
              throw new Error(`Obsidian export conflict: ${file.relativePath}`);
            }
            throw error;
          }
          createdPaths.push(target);
        }
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      changedPaths.push(file.relativePath);
    }
  } catch (error: unknown) {
    for (const target of createdPaths.reverse()) {
      await rm(target, { force: true }).catch(() => undefined);
    }
    for (const [target, contents] of backups) {
      await writeFile(target, contents).catch(() => undefined);
    }
    for (const backup of backupFiles) {
      await rm(backup, { force: true }).catch(() => undefined);
    }
    throw new Error(`Could not write Obsidian vault: ${errorMessage(error)}`);
  }

  let settled = false;
  return {
    changedPaths,
    async commit() {
      if (settled) return;
      settled = true;
      await Promise.all(backupFiles.map((backup) => rm(backup, { force: true })));
    },
    async rollback() {
      if (settled) return;
      settled = true;
      for (const target of createdPaths.reverse()) {
        await rm(target, { force: true }).catch(() => undefined);
      }
      for (const [target, contents] of backups) {
        await writeFile(target, contents).catch(() => undefined);
      }
      await Promise.all(backupFiles.map((backup) => rm(backup, { force: true })));
    },
  };
}

export async function downloadImageAsset(
  url: string,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<DownloadedAsset> {
  let parsed = new URL(url);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await assertPublicHttpUrl(parsed, { label: 'Remote image URL', signal: options.signal });
    response = await fetch(parsed, { redirect: 'manual', signal: options.signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) {
      throw new Error(`Image redirect is missing a location: ${parsed.href}`);
    }
    if (redirects === 5) {
      throw new Error(`Image URL has too many redirects: ${url}`);
    }
    parsed = new URL(location, parsed);
    response = undefined;
  }
  if (!response || !response.ok) {
    throw new Error(`Could not download image ${parsed.href}: HTTP ${response?.status ?? 'unknown'}`);
  }
  const mediaType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!mediaType.startsWith('image/')) {
    throw new Error(`Image URL returned unsupported content type ${mediaType || '(missing)'}`);
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ASSET_BYTES;
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Image exceeds the ${maxBytes} byte limit: ${parsed.href}`);
  }
  const contents = new Uint8Array(await response.arrayBuffer());
  if (contents.byteLength > maxBytes) {
    throw new Error(`Image exceeds the ${maxBytes} byte limit: ${parsed.href}`);
  }
  return { contents, mediaType };
}

export function obsidianOpenUri(vaultName: string, notePath: string): string {
  if (!vaultName.trim()) {
    throw new Error('Obsidian vault name is required to open a note');
  }
  const query = new URLSearchParams({ vault: vaultName, file: validateVaultRelativePath(notePath) });
  return `obsidian://open?${query.toString()}`;
}
