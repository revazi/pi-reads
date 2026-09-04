import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { resolveLibraryPath, assertSafeLibraryRoot } from './library.ts';
import { versionedSha256 } from './text.ts';

export interface MaintenanceFile { path: string; contentHash: `sha256:${string}`; byteLength: number }
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_FILES = 100_000;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/** Maintenance is offline. Reject links, including in ancestors, rather than following them. */
export async function assertNoSymlinkPath(target: string): Promise<void> {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not supported during maintenance');
  }
}

export async function safeMaintenanceTarget(target: string): Promise<string> {
  const absolute = path.resolve(target);
  await assertNoSymlinkPath(path.dirname(absolute));
  await assertSafeLibraryRoot(absolute);
  await assertSafeLibraryRoot(await realpath(path.dirname(absolute)));
  return absolute;
}

export async function readMaintenanceFile(root: string, relative: string): Promise<Buffer> {
  const absolute = resolveLibraryPath(root, relative);
  await assertNoSymlinkPath(absolute);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Expected a regular file no larger than 256 MiB');
    const bytes = await handle.readFile();
    if (bytes.length !== info.size || bytes.length > MAX_FILE_BYTES) throw new Error('File changed during maintenance');
    return bytes;
  } finally { await handle.close(); }
}

export function describeFile(relative: string, bytes: Buffer): MaintenanceFile {
  return { path: relative, contentHash: versionedSha256(bytes), byteLength: bytes.length };
}

export function assertFileMatches(file: MaintenanceFile, bytes: Buffer): void {
  if (file.byteLength !== bytes.length || file.contentHash !== versionedSha256(bytes)) {
    throw new Error('File hash or byte length mismatch');
  }
}

function assertRecordManifest(directory: string, entries: readonly Dirent[]): void {
  const recordDirectory = /^(?:sources\/[^/]+|articles\/(?:archive|digest|synthesis)\/[^/]+|exports\/[^/]+\/[^/]+)$/u.test(directory);
  if (recordDirectory && !entries.some((entry) => entry.name === 'manifest.json' && entry.isFile())) {
    throw new Error('Record directory is missing its canonical manifest');
  }
}

export async function walkMaintenanceFiles(root: string, relative: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 16) throw new Error('Maintenance directory depth exceeds 16');
    const absolute = directory ? resolveLibraryPath(root, directory) : root;
    await assertNoSymlinkPath(absolute);
    const entries = await readdir(absolute, { withFileTypes: true });
    assertRecordManifest(directory, entries);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = directory ? `${directory}/${entry.name}` : entry.name;
      resolveLibraryPath(root, name);
      if (entry.isDirectory()) await walk(name, depth + 1);
      else if (entry.isFile()) result.push(name);
      else throw new Error('Non-regular files are not supported during maintenance');
      if (result.length > MAX_FILES) throw new Error('Maintenance file count exceeds 100000');
    }
  }
  try { await walk(relative, 0); }
  catch (error) {
    // Only an absent optional top-level directory is acceptable, not a disappearing child.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relative) {
      try { await lstat(resolveLibraryPath(root, relative)); } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return [];
      }
    }
    throw error;
  }
  return result.sort();
}
