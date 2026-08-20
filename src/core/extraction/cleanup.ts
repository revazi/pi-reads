import { JSDOM } from 'jsdom';
import { BLOCK_TAGS, normalizeText, textForHash } from '../text.ts';
import { cleanUrl } from './urls.ts';

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

export interface CleanedArticleContent {
  html: string;
  text: string;
}

export function getLanguage(element: Element): string {
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

export function isBylineText(value: string): boolean {
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

function comparisonText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

export function cleanArticleContent(contentHtml: string, sourceUrl: string): CleanedArticleContent {
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

export function descriptionRepeatsOpening(description: string, contentHtml: string): boolean {
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
