import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { resolveLibraryPath, assertSafeLibraryRoot } from './library.ts';
import { versionedSha256 } from './text.ts';

export interface MaintenanceFile {
  path: string;
  contentHash: `sha256:${string}`;
  byteLength: number;
}

/** Fixed v1 bounds for an in-memory, offline maintenance operation. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_FILES = 50_000;
const MAX_ENTRIES = 100_000;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_PATH_BYTES = 240;
const MAX_DEPTH = 16;

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

function assertPortablePath(relative: string): void {
  if (Buffer.byteLength(relative) > MAX_PATH_BYTES) throw new Error('Non-portable snapshot path');
  resolveLibraryPath('/portable', relative);
  const segments = relative.split('/');
  const valid = [
    segments.length <= MAX_DEPTH,
    /^(sources|articles|exports|assets|state\/articles)\//u.test(relative),
    segments.every((segment) =>
      !/[\x00-\x1f\x7f<>:"|?*]/u.test(segment)
      && !/[. ]$/u.test(segment)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|$)/iu.test(segment)),
  ];
  if (!valid.every(Boolean)) throw new Error('Non-portable snapshot path');
}

/** Reject duplicate and file/directory aliases at every case-folded path prefix. */
export class PortablePaths {
  private readonly spellings = new Map<string, string>();
  private readonly files = new Set<string>();

  add(relative: string): void {
    assertPortablePath(relative);
    const parts = relative.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      const folded = prefix.normalize('NFC').toLowerCase();
      const previous = this.spellings.get(folded);
      if ((previous && previous !== prefix) || (index < parts.length && this.files.has(folded))) {
        throw new Error('Snapshot path collision');
      }
      if (index === parts.length && previous) throw new Error('Snapshot path collision');
      this.spellings.set(folded, prefix);
      if (index === parts.length) this.files.add(folded);
    }
  }
}

export async function readMaintenanceFile(
  root: string,
  relative: string,
  maximum = MAX_FILE_BYTES,
): Promise<Buffer> {
  const absolute = resolveLibraryPath(root, relative);
  await assertNoSymlinkPath(path.dirname(absolute));
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) {
    throw new Error(`Expected a regular, unlinked file no larger than ${maximum} bytes`);
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) throw new Error('File changed during maintenance');

    // A fixed buffer prevents a concurrently growing file from causing an unbounded read.
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) throw new Error('File changed during maintenance');
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export function parseMaintenanceJson(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      depth += 1;
      if (depth > 32) throw new Error('JSON nesting limit exceeded');
    } else if (character === '}' || character === ']') depth -= 1;
  }
  return JSON.parse(text) as unknown;
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
  let entryCount = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error(`Maintenance directory depth exceeds ${MAX_DEPTH}`);
    const absolute = directory ? resolveLibraryPath(root, directory) : root;
    await assertNoSymlinkPath(absolute);
    const entries = await readdir(absolute, { withFileTypes: true });
    assertRecordManifest(directory, entries);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      entryCount += 1;
      if (entryCount > MAX_ENTRIES) throw new Error(`Maintenance entry count exceeds ${MAX_ENTRIES}`);
      const name = directory ? `${directory}/${entry.name}` : entry.name;
      resolveLibraryPath(root, name);
      if (entry.isDirectory()) await walk(name, depth + 1);
      else if (entry.isFile()) result.push(name);
      else throw new Error('Non-regular files are not supported during maintenance');
      if (result.length > MAX_FILES) throw new Error(`Maintenance file count exceeds ${MAX_FILES}`);
    }
  }
  try {
    await walk(relative, 0);
  } catch (error) {
    // Only an absent optional top-level directory is acceptable, not a disappearing child.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relative) {
      try {
        await lstat(resolveLibraryPath(root, relative));
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return [];
      }
    }
    throw error;
  }
  return result.sort();
}
