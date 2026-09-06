import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { IngestedSourceDraft } from '../domain.ts';
import { ingestMarkdown, ingestText } from './text.ts';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const TEXT_EXTENSIONS = new Set(['.txt']);

const MAX_FILE_BYTES = 10 * 1024 * 1024;

async function readSourceFile(absolutePath: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  // NONBLOCK prevents a named pipe from hanging before regular-file validation.
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error('Source must be a regular text file no larger than 10 MiB');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!chunk.bytesRead) break;
      offset += chunk.bytesRead;
    }
    signal?.throwIfAborted();
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Source file changed while reading');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

export async function ingestFile(filePath: string, cwd = process.cwd(), signal?: AbortSignal): Promise<IngestedSourceDraft> {
  if (!filePath.trim()) {
    throw new Error('File path is required');
  }

  const absolutePath = path.resolve(cwd, filePath);
  const extension = path.extname(absolutePath).toLowerCase();
  if (!MARKDOWN_EXTENSIONS.has(extension) && !TEXT_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported source file type: ${extension || '(none)'}`);
  }

  const bytes = await readSourceFile(absolutePath, signal);
  let contents: string;
  try {
    contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Source file is not valid UTF-8 text: ${filePath}`);
  }
  if (contents.includes('\0')) {
    throw new Error(`Source file appears to be binary: ${filePath}`);
  }

  const title = path.basename(absolutePath, extension);
  const draft = MARKDOWN_EXTENSIONS.has(extension)
    ? ingestMarkdown(contents, title)
    : ingestText(contents, title);

  return {
    ...draft,
    kind: 'file',
    locator: absolutePath,
    title,
    capture: { adapter: MARKDOWN_EXTENSIONS.has(extension) ? 'markdown-file' : 'text-file' },
  };
}
