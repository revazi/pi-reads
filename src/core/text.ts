import crypto from 'node:crypto';

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

export function sha256(value: string | NodeJS.ArrayBufferView): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function versionedSha256(value: string | NodeJS.ArrayBufferView): `sha256:${string}` {
  return `sha256:${sha256(value)}`;
}
