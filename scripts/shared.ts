import crypto from 'node:crypto';
import path from 'node:path';

export type Frontmatter = Record<string, unknown>;

export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

function isElement(node: Node): node is Element {
  return node.nodeType === node.ELEMENT_NODE;
}

export function textForHash(node: Node): string {
  if (node.nodeType === node.TEXT_NODE) {
    return node.nodeValue ?? '';
  }

  if (!isElement(node)) {
    return '';
  }

  const tagName = node.tagName.toLowerCase();
  if (tagName === 'br') {
    return ' ';
  }

  const text = [...node.childNodes].map(textForHash).join('');
  return BLOCK_TAGS.has(tagName) ? ` ${text} ` : text;
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function parseFrontmatter(markdown: string): Frontmatter {
  const lines = markdown.split('\n');
  if (lines[0] !== '---') {
    return {};
  }

  const end = lines.indexOf('---', 1);
  if (end === -1) {
    return {};
  }

  const metadata: Frontmatter = {};
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    try {
      const parsed: unknown = JSON.parse(rawValue);
      metadata[key] = parsed;
    } catch {
      metadata[key] = rawValue;
    }
  }

  return metadata;
}

export function articleSlug(articlePath: string, metadata: Frontmatter): string {
  const slug = metadata.slug;
  return typeof slug === 'string' ? slug : path.basename(articlePath, '.md');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
