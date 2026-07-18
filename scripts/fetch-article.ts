#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { chromium, type Browser } from 'playwright';
import { BLOCK_TAGS, errorMessage, normalizeText, sha256, textForHash } from './shared.ts';

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

interface FontFamilySample {
  fontFamily: string;
  textLength: number;
}

type MetadataValue = string | number | null | undefined;
type SourceFontStyle = 'serif' | 'sans-serif';

function usage(): void {
  console.error(
    'Usage: pnpm article:fetch <url> [--slug slug] [--smaller-body-font] [--image-scale 1-100] [--out articles] [--save-html sources/name.html] [--save-clean-html sources/name.clean.html] [--save-text sources/name.txt]\n\nFetches a web article, extracts readable content, cleans links, and writes Markdown without LLM rewriting. --smaller-body-font reduces article prose from 11pt to 10pt. --image-scale caps images at the given percentage of article width without enlarging smaller images.',
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

function parseImageScale(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const percentage = Number(value);
  if (value === 'true' || !Number.isInteger(percentage) || percentage < 1 || percentage > 100) {
    throw new Error('--image-scale must be an integer from 1 to 100');
  }

  return percentage;
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

  if (url.hash.toLowerCase().startsWith('#:~:text=')) {
    url.hash = '';
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

function normalizeInlineFormatting(document: Document): void {
  const tagNames = ['strong', 'b', 'em', 'i'];

  for (const element of [...document.querySelectorAll(tagNames.join(','))]) {
    if (!/[\p{L}\p{N}]/u.test(element.textContent ?? '')) {
      element.replaceWith(...element.childNodes);
    }
  }

  for (const tagName of tagNames) {
    for (const element of [...document.querySelectorAll(tagName)]) {
      while (true) {
        let sibling = element.nextSibling;
        const whitespace: Text[] = [];

        while (sibling?.nodeType === 3 && !(sibling.nodeValue ?? '').trim()) {
          whitespace.push(sibling as Text);
          sibling = sibling.nextSibling;
        }

        if (!sibling || sibling.nodeType !== 1) {
          break;
        }

        const siblingElement = sibling as Element;
        if (siblingElement.tagName.toLowerCase() !== tagName) {
          break;
        }

        element.append(...whitespace, ...siblingElement.childNodes);
        siblingElement.remove();
      }
    }
  }
}

function normalizeTables(document: Document): void {
  for (const table of [...document.querySelectorAll('table')]) {
    const firstRow = table.querySelector('tr');
    if (!firstRow) {
      continue;
    }

    const cells = [...firstRow.children];
    const isHeaderRow =
      cells.length > 0 &&
      cells.every(
        (cell) =>
          cell.tagName.toLowerCase() === 'td' &&
          normalizeText(cell.textContent ?? '') &&
          cell.querySelector('strong, b'),
      );
    if (!isHeaderRow) {
      continue;
    }

    for (const cell of cells) {
      const header = document.createElement('th');
      header.append(...cell.childNodes);
      cell.replaceWith(header);
    }

    const rowGroup = firstRow.parentElement;
    const tableHead = document.createElement('thead');
    table.insertBefore(tableHead, rowGroup);
    tableHead.append(firstRow);
    if (rowGroup && rowGroup.children.length === 0) {
      rowGroup.remove();
    }
  }
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

function isBylineText(value: string): boolean {
  const text = normalizeText(value);
  return text.length <= 240 && /^by\s+\p{L}/iu.test(text);
}

function isInternalLinkList(element: Element): boolean {
  if (!['ul', 'ol'].includes(element.tagName.toLowerCase())) {
    return false;
  }

  const links = [...element.querySelectorAll('a[href]')];
  if (links.length < 2 || links.some((link) => !(link.getAttribute('href') ?? '').startsWith('#'))) {
    return false;
  }

  const withoutLinks = element.cloneNode(true) as Element;
  for (const link of [...withoutLinks.querySelectorAll('a')]) {
    link.remove();
  }

  return !normalizeText(withoutLinks.textContent ?? '');
}

function removeArticleFurniture(document: Document): void {
  const article = document.querySelector('#article');
  const firstParagraph = article?.querySelector('p');
  if (firstParagraph) {
    const text = normalizeText(firstParagraph.textContent ?? '');
    if (isBylineText(text) && firstParagraph.querySelector('a[href]')) {
      firstParagraph.remove();
    }
  }

  for (const marker of [...document.querySelectorAll('#article :is(p, h1, h2, h3, h4, h5, h6)')]) {
    const label = comparisonText(marker.textContent ?? '');
    if (!['toc', 'table of contents', 'contents'].includes(label)) {
      continue;
    }

    const list = marker.nextElementSibling;
    if (list && isInternalLinkList(list)) {
      marker.remove();
      list.remove();
    }
  }
}

function cleanLinks(document: Document, sourceUrl: string): void {
  for (const link of [...document.querySelectorAll('a')]) {
    const href = link.getAttribute('href') ?? '';
    const label = normalizeText(textForHash(link));

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

    const hasBlockContent = [...link.querySelectorAll('*')].some((element) =>
      BLOCK_TAGS.has(element.tagName.toLowerCase()),
    );
    if (label && hasBlockContent) {
      link.replaceChildren(document.createTextNode(label));
    }
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

function cleanArticleContent(contentHtml: string, sourceUrl: string): CleanedArticleContent {
  const dom = new JSDOM(`<!doctype html><main id="article">${contentHtml}</main>`, { url: sourceUrl });
  const { document } = dom.window;

  replaceHighlightBlocks(document);
  normalizeInlineFormatting(document);
  normalizeTables(document);

  for (const element of [...document.querySelectorAll(DROP_SELECTORS)]) {
    element.remove();
  }

  removeArticleFurniture(document);
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

  turndown.addRule('preserveTablesAsHtml', {
    filter: 'table',
    replacement(_content, node) {
      return `\n\n${(node as Element).outerHTML}\n\n`;
    },
  });

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

function comparisonText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function descriptionRepeatsOpening(description: string, contentHtml: string): boolean {
  const dom = new JSDOM(`<!doctype html><main>${contentHtml}</main>`);
  const opening = [...dom.window.document.querySelectorAll('p')]
    .map((paragraph) => normalizeText(paragraph.textContent ?? ''))
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
  const comparableDescription = comparisonText(description);
  const comparableOpening = comparisonText(opening);

  return Boolean(
    comparableDescription &&
      (comparableOpening === comparableDescription || comparableOpening.startsWith(`${comparableDescription} `)),
  );
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

function articleParagraphSamples(contentHtml: string): string[] {
  const dom = new JSDOM(`<!doctype html><main>${contentHtml}</main>`);

  return [...dom.window.document.querySelectorAll('p')]
    .map((paragraph) => normalizeText(paragraph.textContent ?? ''))
    .filter((text) => text.length >= 80)
    .sort((left, right) => right.length - left.length)
    .slice(0, 12);
}

function classifyFontFamily(fontFamily: string): SourceFontStyle | null {
  const families = fontFamily
    .split(',')
    .map((family) => family.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
    .filter(Boolean);

  for (const family of families) {
    if (
      family === 'sans-serif' ||
      family === 'ui-sans-serif' ||
      family === 'system-ui' ||
      /(^|[\s-])(sans|grotesk|grotesque)([\s-]|$)/.test(family) ||
      /^(arial|helvetica|inter|roboto|verdana|tahoma|trebuchet ms|segoe ui|calibri|avenir|futura)$/.test(family)
    ) {
      return 'sans-serif';
    }

    if (
      family === 'serif' ||
      family === 'ui-serif' ||
      /(^|[\s-])serif([\s-]|$)/.test(family) ||
      /^(georgia|cambria|charter|garamond|baskerville|palatino|times|times new roman|merriweather|literata|lora)$/.test(family)
    ) {
      return 'serif';
    }
  }

  return null;
}

function chooseSourceFontStyle(samples: FontFamilySample[]): SourceFontStyle {
  const weights: Record<SourceFontStyle, number> = { serif: 0, 'sans-serif': 0 };

  for (const sample of samples) {
    const style = classifyFontFamily(sample.fontFamily);
    if (style) {
      weights[style] += Math.min(sample.textLength, 1_000);
    }
  }

  return weights['sans-serif'] > weights.serif ? 'sans-serif' : 'serif';
}

async function collectFontFamilySamples(browser: Browser, url: string, articleSamples: string[]): Promise<FontFamilySample[]> {
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);

    return await page.evaluate((expectedParagraphs) => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const expectedPrefixes = expectedParagraphs.map((text) => text.slice(0, 160));
      const visibleParagraphs = [...document.querySelectorAll('p')].filter((paragraph) => {
        const style = getComputedStyle(paragraph);
        const text = normalize(paragraph.textContent ?? '');
        return text.length >= 40 && style.display !== 'none' && style.visibility !== 'hidden';
      });

      let candidates = visibleParagraphs.filter((paragraph) => {
        const text = normalize(paragraph.textContent ?? '');
        return expectedPrefixes.some((prefix) => text.includes(prefix));
      });

      if (candidates.length === 0) {
        const selectors = ['article p', '[role="article"] p', 'main p', '[role="main"] p', 'body p'];
        for (const selector of selectors) {
          candidates = visibleParagraphs.filter((paragraph) => paragraph.matches(selector));
          if (candidates.length > 0) {
            break;
          }
        }
      }

      return candidates
        .map((paragraph) => ({
          fontFamily: getComputedStyle(paragraph).fontFamily,
          textLength: normalize(paragraph.textContent ?? '').length,
        }))
        .sort((left, right) => right.textLength - left.textLength)
        .slice(0, 20);
    }, articleSamples);
  } finally {
    await page.close();
  }
}

async function detectSourceFontStyle(url: string, contentHtml: string): Promise<SourceFontStyle> {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch();
    const samples = await collectFontFamilySamples(browser, url, articleParagraphSamples(contentHtml));
    return chooseSourceFontStyle(samples);
  } catch (error: unknown) {
    console.warn(`Could not detect source font style; using serif: ${errorMessage(error)}`);
    return 'serif';
  } finally {
    await browser?.close();
  }
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

  const imageScalePercent = parseImageScale(flags.get('image-scale'));
  const rawHtml = await fetchHtml(inputUrl);
  const sourceDom = new JSDOM(rawHtml, { url: inputUrl });
  const { document } = sourceDom.window;
  const sourceUrl = canonicalUrl(document, inputUrl);
  const fallbackTitle = meta(document, 'meta[property="og:title"]') || document.title;
  const fallbackAuthor = meta(document, 'meta[name="author"]');
  const metadataDescription =
    meta(document, 'meta[name="description"]') ||
    meta(document, 'meta[property="og:description"]') ||
    meta(document, 'meta[name="twitter:description"]');
  const fallbackDate = meta(document, 'meta[property="article:published_time"]') || document.querySelector('time[datetime]')?.getAttribute('datetime') || '';

  const reader = new Readability(document, { keepClasses: true });
  const article = reader.parse();
  if (!article?.content) {
    throw new Error('Readability could not extract article content');
  }

  const sourceFontStyle = await detectSourceFontStyle(inputUrl, article.content);
  const cleaned = cleanArticleContent(article.content, sourceUrl);
  const title = article.title || fallbackTitle || 'Untitled article';
  const slug = flags.get('slug') ?? slugify(title);
  const outputDir = flags.get('out') ?? 'articles';
  const outputPath = path.join(outputDir, `${slug}.md`);
  const author = article.byline || fallbackAuthor;
  const candidateDescription = metadataDescription || article.excerpt || '';
  const descriptionIsByline = isBylineText(candidateDescription);
  const description =
    descriptionIsByline || descriptionRepeatsOpening(candidateDescription, cleaned.html)
      ? ''
      : candidateDescription;
  const date = fallbackDate;
  const body = markdownFromHtml(cleaned.html);
  const bodyFontSizeAdjustment = flags.has('smaller-body-font') ? -1 : undefined;

  const metadata = {
    title,
    slug,
    source: sourceUrl,
    author,
    date: date.slice(0, 10) || date,
    description,
    sourceFontStyle,
    bodyFontSizeAdjustment,
    imageScalePercent,
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
