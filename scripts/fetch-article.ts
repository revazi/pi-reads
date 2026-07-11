#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { errorMessage, normalizeText, sha256 } from './shared.ts';

const TRACKING_PARAMS = new Set([
  'ascsubtag',
  'camp',
  'creative',
  'fbclid',
  'gclid',
  'igshid',
  'linkcode',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'spm',
  'tag',
]);

const BLOCK_TAGS = new Set([
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

const DROP_SELECTORS = [
  'script',
  'style',
  'iframe',
  'noscript',
  'form',
  'button',
  'svg',
  'canvas',
  'nav',
  'aside',
  '.heading-link',
  '.sr-only',
  '[aria-hidden="true"]',
].join(',');

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string>;
}

interface CleanedArticleContent {
  html: string;
  text: string;
}

type MetadataValue = string | null | undefined;

function usage(): void {
  console.error(
    'Usage: pnpm article:fetch <url> [--slug slug] [--out articles] [--save-html sources/name.html] [--save-clean-html sources/name.clean.html] [--save-text sources/name.txt]\n\nFetches a web article, extracts readable content, cleans links, and writes Markdown without LLM rewriting.',
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }

    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(key, 'true');
      continue;
    }

    flags.set(key, next);
    index += 1;
  }

  return { positional, flags };
}

function meta(document: Document, selector: string): string {
  const element = document.querySelector(selector);
  const content = element?.getAttribute('content');
  return content?.trim() ?? '';
}

function canonicalUrl(document: Document, inputUrl: string): string {
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
  return cleanUrl(canonical ?? inputUrl, inputUrl) || inputUrl;
}

function cleanUrl(value: string, baseUrl: string): string {
  if (!value) {
    return '';
  }

  if (value.startsWith('#')) {
    return value;
  }

  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return '';
  }

  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
    return '';
  }

  for (const key of [...url.searchParams.keys()]) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith('utm_') || TRACKING_PARAMS.has(normalized)) {
      url.searchParams.delete(key);
    }
  }

  return url.toString();
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return slug || 'article';
}

function yamlScalar(value: MetadataValue): string {
  return JSON.stringify(value);
}

function getLanguage(element: Element): string {
  const dataLang = element.getAttribute('data-lang');
  if (dataLang) {
    return dataLang;
  }

  const classValue = element.getAttribute('class') ?? element.className;
  for (const className of String(classValue).split(/\s+/)) {
    if (className.startsWith('language-')) {
      return className.slice('language-'.length);
    }
  }

  return '';
}

function inferCodeLanguage(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return '';
  }

  if (/^warning:\s|^error:\s|^\s*Pattern match\(es\)/m.test(trimmed)) {
    return 'text';
  }

  if (
    /(^|\n)\s*(module|import|data|newtype|type|class|instance)\s+[A-Z_a-z]/.test(trimmed) ||
    /(^|\n)\s*[a-zA-Z_'][\w']*\s*::\s*/.test(trimmed) ||
    /\b(Maybe|NonEmpty|IO|FilePath|Integer|Void|Just|Nothing|MonadError)\b/.test(trimmed) ||
    /\b(do|case|of|let|pure|fmap|throwIO|userError|when)\b/.test(trimmed) ||
    /(<-|=>|->|\$|:\|)/.test(trimmed)
  ) {
    return 'haskell';
  }

  return '';
}

function replaceHighlightBlocks(document: Document): void {
  for (const highlight of [...document.querySelectorAll('div.highlight')]) {
    const code = highlight.querySelector('code');
    if (!code) {
      continue;
    }

    const pre = document.createElement('pre');
    const cleanCode = document.createElement('code');
    const language = getLanguage(code);

    if (language) {
      cleanCode.className = `language-${language}`;
    }

    cleanCode.textContent = (code.textContent ?? '').replace(/\n$/, '');
    pre.append(cleanCode);
    highlight.replaceWith(pre);
  }
}

function cleanCodeBlocks(document: Document): void {
  for (const code of [...document.querySelectorAll('pre code')]) {
    const text = (code.textContent ?? '').replace(/\n$/, '');
    const language = getLanguage(code) || inferCodeLanguage(text);
    code.replaceChildren();
    code.textContent = text;
    code.removeAttribute('style');
    code.removeAttribute('data-lang');
    code.removeAttribute('class');
    if (language) {
      code.className = `language-${language}`;
    }
  }
}

function unwrap(element: Element): void {
  element.replaceWith(...element.childNodes);
}

function cleanLinks(document: Document, sourceUrl: string): void {
  for (const link of [...document.querySelectorAll('a')]) {
    const href = link.getAttribute('href') ?? '';
    const label = normalizeText(link.textContent ?? '');

    if (href.startsWith('#') && (!label || label.toLowerCase() === 'link to heading')) {
      link.remove();
      continue;
    }

    const cleaned = cleanUrl(href, sourceUrl);
    if (!cleaned) {
      unwrap(link);
      continue;
    }

    link.setAttribute('href', cleaned);
  }
}

function cleanImages(document: Document, sourceUrl: string): void {
  for (const image of [...document.querySelectorAll('img')]) {
    const source = cleanUrl(image.getAttribute('src') ?? '', sourceUrl);
    if (!source) {
      image.remove();
      continue;
    }

    const alt = image.getAttribute('alt') ?? '';
    image.replaceChildren();
    image.setAttribute('src', source);
    image.setAttribute('alt', alt);
  }
}

function stripAttributes(document: Document): void {
  for (const element of [...document.querySelectorAll('*')]) {
    const tagName = element.tagName.toLowerCase();
    const allowed = new Set<string>();

    if (element.id === 'article') {
      allowed.add('id');
    }

    if (tagName === 'a') {
      allowed.add('href');
    }

    if (tagName === 'img') {
      allowed.add('src');
      allowed.add('alt');
    }

    if (tagName === 'code') {
      allowed.add('class');
    }

    for (const attribute of [...element.attributes]) {
      if (!allowed.has(attribute.name)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function isElement(node: Node): node is Element {
  return node.nodeType === node.ELEMENT_NODE;
}

function textForHash(node: Node): string {
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

function cleanArticleContent(contentHtml: string, sourceUrl: string): CleanedArticleContent {
  const dom = new JSDOM(`<!doctype html><main id="article">${contentHtml}</main>`, { url: sourceUrl });
  const { document } = dom.window;

  replaceHighlightBlocks(document);

  for (const element of [...document.querySelectorAll(DROP_SELECTORS)]) {
    element.remove();
  }

  cleanCodeBlocks(document);
  cleanLinks(document, sourceUrl);
  cleanImages(document, sourceUrl);
  stripAttributes(document);

  const article = document.querySelector('#article');
  if (!article) {
    throw new Error('Could not build article DOM');
  }

  return { html: article.innerHTML.trim(), text: normalizeText(textForHash(article)) };
}

function fenceFor(source: string): string {
  const runs = source.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function createTurndown(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    bulletListMarker: '-',
  });

  turndown.use(gfm);

  turndown.addRule('fencedCodeBlocksWithLanguage', {
    filter(node) {
      return node.nodeName === 'PRE' && node.firstElementChild?.nodeName === 'CODE';
    },
    replacement(_content, node) {
      const code = node.firstElementChild;
      if (!code) {
        return '';
      }

      const source = (code.textContent ?? '').replace(/\n$/, '');
      const language = getLanguage(code);
      const fence = fenceFor(source);
      return `\n\n${fence}${language}\n${source}\n${fence}\n\n`;
    },
  });

  return turndown;
}

function markdownFromHtml(contentHtml: string): string {
  return createTurndown()
    .turndown(contentHtml)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function frontmatter(metadata: Record<string, MetadataValue>): string {
  return [
    '---',
    ...Object.entries(metadata)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${yamlScalar(value)}`),
    '---',
    '',
  ].join('\n');
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'irakli-reads/0.1',
      accept: 'text/html,application/xhtml+xml',
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function saveOptionalFile(filePath: string | undefined, contents: string): Promise<void> {
  if (!filePath || filePath === 'true') {
    return;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const inputUrl = positional[0];

  if (!inputUrl || flags.has('help')) {
    usage();
    process.exit(inputUrl ? 0 : 1);
  }

  const rawHtml = await fetchHtml(inputUrl);
  const sourceDom = new JSDOM(rawHtml, { url: inputUrl });
  const { document } = sourceDom.window;
  const sourceUrl = canonicalUrl(document, inputUrl);
  const fallbackTitle = meta(document, 'meta[property="og:title"]') || document.title;
  const fallbackAuthor = meta(document, 'meta[name="author"]');
  const fallbackDescription = meta(document, 'meta[name="description"]') || meta(document, 'meta[property="og:description"]');
  const fallbackDate = meta(document, 'meta[property="article:published_time"]') || document.querySelector('time[datetime]')?.getAttribute('datetime') || '';

  const reader = new Readability(document, { keepClasses: true });
  const article = reader.parse();
  if (!article?.content) {
    throw new Error('Readability could not extract article content');
  }

  const cleaned = cleanArticleContent(article.content, sourceUrl);
  const title = article.title || fallbackTitle || 'Untitled article';
  const slug = flags.get('slug') ?? slugify(title);
  const outputDir = flags.get('out') ?? 'articles';
  const outputPath = path.join(outputDir, `${slug}.md`);
  const author = article.byline || fallbackAuthor;
  const description = article.excerpt || fallbackDescription;
  const date = fallbackDate;
  const body = markdownFromHtml(cleaned.html);

  const metadata = {
    title,
    slug,
    source: sourceUrl,
    author,
    date: date.slice(0, 10) || date,
    description,
    sourceTextHash: sha256(cleaned.text),
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${frontmatter(metadata)}${body}\n`, 'utf8');

  await saveOptionalFile(flags.get('save-html'), rawHtml);
  await saveOptionalFile(flags.get('save-clean-html'), cleaned.html);
  await saveOptionalFile(flags.get('save-text'), cleaned.text);

  console.log(`Wrote ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
