import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import type { IngestedSourceDraft } from '../domain.ts';
import { normalizeText, textForHash, versionedSha256 } from '../text.ts';

function requireContent(value: string, kind: 'text' | 'markdown'): void {
  if (!value.trim()) {
    throw new Error(`Cannot ingest empty ${kind} content`);
  }
}

function visibleTextFromMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false });
  const dom = new JSDOM(`<!doctype html><main id="content">${html}</main>`);
  const content = dom.window.document.querySelector('#content');
  if (!content) {
    throw new Error('Could not render Markdown for hashing');
  }
  return normalizeText(textForHash(content));
}

export function plainTextToMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/([\\`*_[\]{}()#+\-.!|>])/g, '\\$1'))
    .join('\n');
}

export function ingestText(text: string, label = 'Pasted text'): IngestedSourceDraft {
  requireContent(text, 'text');
  const content = plainTextToMarkdown(text);

  return {
    kind: 'text',
    locator: label,
    title: label,
    content,
    mediaType: 'text/markdown',
    contentHash: versionedSha256(content),
    textHash: versionedSha256(normalizeText(text)),
    rawContent: text,
    rawMediaType: 'text/plain',
    capture: { adapter: 'text' },
  };
}

export function ingestMarkdown(markdown: string, label = 'Pasted Markdown'): IngestedSourceDraft {
  requireContent(markdown, 'markdown');

  return {
    kind: 'markdown',
    locator: label,
    title: label,
    content: markdown,
    mediaType: 'text/markdown',
    contentHash: versionedSha256(markdown),
    textHash: versionedSha256(visibleTextFromMarkdown(markdown)),
    capture: { adapter: 'markdown' },
  };
}
