import { JSDOM } from 'jsdom';
import type { IngestedSourceDraft } from '../domain.ts';
import { normalizeText, versionedSha256 } from '../text.ts';
import { cleanArticleContent } from '../extraction/cleanup.ts';
import { markdownFromHtml } from '../extraction/markdown.ts';
import { cleanUrl } from '../extraction/urls.ts';
import { analyzeMarkdown, plainTextToMarkdown } from './text.ts';

export const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_FEED_ENTRIES = 50;

export interface ParsedFeed {
  kind: 'feed';
  format: 'rss' | 'atom';
  title?: string;
  locator: string;
  collectionHash: `sha256:${string}`;
  totalEntryCount: number;
  entriesTruncated: boolean;
  drafts: IngestedSourceDraft[];
}

function children(element: Element, ...names: string[]): Element[] {
  const expected = new Set(names.map((name) => name.toLowerCase()));
  return [...element.children].filter((child) => expected.has(child.localName.toLowerCase()));
}

function child(element: Element, ...names: string[]): Element | undefined {
  return children(element, ...names)[0];
}

function boundedText(value: string | null | undefined, maximum = 500): string | undefined {
  const normalized = normalizeText(value ?? '');
  return normalized ? [...normalized].slice(0, maximum).join('') : undefined;
}

function normalizedDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : boundedText(value, 100);
}

function rssLink(entry: Element, feedUrl: string): string | undefined {
  const candidate = child(entry, 'link')?.textContent || child(entry, 'guid')?.textContent;
  const cleaned = cleanUrl(candidate?.trim() ?? '', feedUrl);
  return cleaned.startsWith('http:') || cleaned.startsWith('https:') ? cleaned : undefined;
}

function atomLink(entry: Element, feedUrl: string): string | undefined {
  const links = children(entry, 'link');
  const candidate = links.find((link) => !link.getAttribute('rel') || link.getAttribute('rel') === 'alternate')
    ?? links[0];
  const cleaned = cleanUrl(candidate?.getAttribute('href') ?? '', feedUrl);
  return cleaned.startsWith('http:') || cleaned.startsWith('https:') ? cleaned : undefined;
}

function bodyElement(entry: Element, format: 'rss' | 'atom'): Element | undefined {
  return format === 'rss'
    ? child(entry, 'encoded', 'description', 'summary')
    : child(entry, 'content', 'summary');
}

function entryAuthor(entry: Element, format: 'rss' | 'atom'): string | undefined {
  if (format === 'rss') return boundedText(child(entry, 'creator', 'author')?.textContent, 200);
  const author = child(entry, 'author');
  return boundedText(author ? child(author, 'name')?.textContent ?? author.textContent : undefined, 200);
}

function rawBody(body: Element | undefined, title: string): string {
  if (!body) return title;
  return body.children.length > 0 ? body.innerHTML : body.textContent || title;
}

function bodyIsHtml(body: Element | undefined, raw: string): boolean {
  const type = body?.getAttribute('type')?.toLowerCase();
  if (type === 'html' || type === 'xhtml') return true;
  return !type && /<\/?[a-z][^>]*>/iu.test(raw);
}

function markdownBody(body: Element | undefined, title: string, baseUrl: string): {
  content: string;
  rawContent: string;
  rawMediaType: 'text/html' | 'text/plain';
} {
  const raw = rawBody(body, title);
  if (!bodyIsHtml(body, raw)) {
    return { content: plainTextToMarkdown(raw), rawContent: raw, rawMediaType: 'text/plain' };
  }
  const cleaned = cleanArticleContent(raw, baseUrl);
  const content = markdownFromHtml(cleaned.html) || plainTextToMarkdown(title);
  return { content, rawContent: raw, rawMediaType: 'text/html' };
}

function optionalEntryMetadata(
  canonicalUrl: string | undefined,
  author: string | undefined,
  publishedAt: string | undefined,
): Partial<Pick<IngestedSourceDraft, 'canonicalUrl' | 'authors' | 'publishedAt'>> {
  return {
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(author ? { authors: [author] } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

function feedEntryDraft(
  entry: Element,
  format: 'rss' | 'atom',
  feedUrl: string,
  index: number,
): IngestedSourceDraft {
  const title = boundedText(child(entry, 'title')?.textContent) ?? `Feed entry ${index + 1}`;
  const canonicalUrl = format === 'rss' ? rssLink(entry, feedUrl) : atomLink(entry, feedUrl);
  const body = markdownBody(bodyElement(entry, format), title, canonicalUrl ?? feedUrl);
  const analysis = analyzeMarkdown(body.content);
  const author = entryAuthor(entry, format);
  const publishedAt = normalizedDate(boundedText(
    child(entry, 'published', 'updated', 'pubdate', 'date')?.textContent,
    100,
  ));
  return {
    kind: 'feed',
    locator: canonicalUrl ?? `${feedUrl}#entry-${index + 1}`,
    ...optionalEntryMetadata(canonicalUrl, author, publishedAt),
    title,
    content: body.content,
    mediaType: 'text/markdown',
    contentHash: analysis.contentHash,
    textHash: analysis.textHash,
    rawContent: body.rawContent,
    rawMediaType: body.rawMediaType,
    capture: { adapter: `${format}-entry`, adapterVersion: '1' },
  };
}

function feedDocument(xml: string, feedUrl: string): Document {
  if (Buffer.byteLength(xml) > MAX_FEED_BYTES) throw new Error('Feed exceeds the 2 MiB limit');
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error('Feed declarations and entities are not supported');
  try {
    const document = new JSDOM(xml, { contentType: 'application/xml', url: feedUrl }).window.document;
    if (document.querySelector('parsererror')) throw new Error('parse error');
    return document;
  } catch {
    throw new Error('Feed is not valid XML');
  }
}

function feedRoot(document: Document): { root: Element; format: 'rss' | 'atom' } {
  const root = document.documentElement;
  const rootName = root?.localName.toLowerCase();
  if (root && rootName === 'feed') return { root, format: 'atom' };
  if (root && (rootName === 'rss' || rootName === 'rdf')) return { root, format: 'rss' };
  throw new Error('Input is not an RSS or Atom feed');
}

function entryElements(container: Element, format: 'rss' | 'atom'): Element[] {
  const entries = format === 'rss'
    ? [...container.getElementsByTagNameNS('*', 'item')]
    : children(container, 'entry');
  if (entries.length === 0) throw new Error('Feed contains no entries');
  return entries;
}

export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  const { root, format } = feedRoot(feedDocument(xml, feedUrl));
  const container = format === 'rss' ? child(root, 'channel') ?? root : root;
  const allEntries = entryElements(container, format);
  const title = boundedText(child(container, 'title')?.textContent);
  return {
    kind: 'feed', format, ...(title ? { title } : {}), locator: feedUrl,
    collectionHash: versionedSha256(xml),
    totalEntryCount: allEntries.length,
    entriesTruncated: allEntries.length > MAX_FEED_ENTRIES,
    drafts: allEntries.slice(0, MAX_FEED_ENTRIES).map((entry, index) =>
      feedEntryDraft(entry, format, feedUrl, index)),
  };
}
