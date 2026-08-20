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

  const contents = await readFile(absolutePath, 'utf8');
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
