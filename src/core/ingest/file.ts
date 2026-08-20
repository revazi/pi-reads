import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IngestedSourceDraft } from '../domain.ts';
import { ingestMarkdown, ingestText } from './text.ts';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const TEXT_EXTENSIONS = new Set(['.txt']);

export async function ingestFile(filePath: string, cwd = process.cwd()): Promise<IngestedSourceDraft> {
  if (!filePath.trim()) {
    throw new Error('File path is required');
  }

  const absolutePath = path.resolve(cwd, filePath);
  const extension = path.extname(absolutePath).toLowerCase();
  if (!MARKDOWN_EXTENSIONS.has(extension) && !TEXT_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported source file type: ${extension || '(none)'}`);
  }

  const bytes = await readFile(absolutePath);
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
