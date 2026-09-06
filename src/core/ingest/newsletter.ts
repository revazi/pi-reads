import path from 'node:path';
import { JSDOM } from 'jsdom';
import PostalMime, { type Address, type Email } from 'postal-mime';
import type { IngestedSourceDraft } from '../domain.ts';
import { normalizeText } from '../text.ts';
import { cleanArticleContent } from '../extraction/cleanup.ts';
import { markdownFromHtml } from '../extraction/markdown.ts';
import { cleanUrl } from '../extraction/urls.ts';
import { readBoundedRegularFile } from './filesystem.ts';
import { analyzeMarkdown, plainTextToMarkdown } from './text.ts';

const MAX_NEWSLETTER_BYTES = 10 * 1024 * 1024;

function header(message: Email, ...names: string[]): string | undefined {
  const wanted = new Set(names);
  return message.headers.find((item) => wanted.has(item.key))?.value;
}

function httpHeaderUrl(value: string | undefined, base: string): string | undefined {
  const candidate = value?.match(/<([^>]+)>/u)?.[1] ?? value;
  const cleaned = cleanUrl(candidate?.trim() ?? '', base);
  return cleaned.startsWith('http:') || cleaned.startsWith('https:') ? cleaned : undefined;
}

function htmlCanonical(html: string | undefined, base: string): string | undefined {
  if (!html) return undefined;
  const document = new JSDOM(html, { url: base }).window.document;
  return httpHeaderUrl(document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? undefined, base);
}

function canonicalNewsletterUrl(message: Email): string | undefined {
  const fallbackBase = 'https://newsletter.invalid/';
  return httpHeaderUrl(header(message, 'archived-at', 'list-archive', 'content-location'), fallbackBase)
    ?? htmlCanonical(message.html, fallbackBase);
}

function addressNames(address: Address | undefined): string[] | undefined {
  if (!address) return undefined;
  const mailboxes = 'group' in address ? address.group ?? [] : [address];
  const names = mailboxes.map((mailbox) => normalizeText(mailbox.name || mailbox.address)).filter(Boolean);
  return names.length > 0 ? [...new Set(names)] : undefined;
}

function messageDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function newsletterMarkdown(message: Email, baseUrl: string): string {
  if (message.html?.trim()) {
    const cleaned = cleanArticleContent(message.html, baseUrl);
    const markdown = markdownFromHtml(cleaned.html);
    if (markdown) return markdown;
  }
  if (message.text?.trim()) return plainTextToMarkdown(message.text);
  throw new Error('Newsletter email has no readable text or HTML body');
}

function optionalMessageMetadata(
  message: Email,
  canonicalUrl: string | undefined,
): Partial<Pick<IngestedSourceDraft, 'canonicalUrl' | 'authors' | 'publishedAt'>> {
  const authors = addressNames(message.from);
  const publishedAt = messageDate(message.date);
  return {
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(authors ? { authors } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

export async function ingestNewsletterFile(
  filePath: string,
  cwd = process.cwd(),
  signal?: AbortSignal,
): Promise<IngestedSourceDraft> {
  if (!filePath.trim()) throw new Error('Newsletter file path is required');
  const absolutePath = path.resolve(cwd, filePath);
  if (path.extname(absolutePath).toLowerCase() !== '.eml') throw new Error('Newsletter input must be a local .eml file');
  const bytes = await readBoundedRegularFile(absolutePath, MAX_NEWSLETTER_BYTES, 'Newsletter email', signal);
  let raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`Newsletter email is not valid UTF-8: ${filePath}`); }
  signal?.throwIfAborted();
  const message = await PostalMime.parse(bytes, {
    attachmentEncoding: 'arraybuffer',
    maxHeadersSize: 256 * 1024,
    maxNestingDepth: 20,
    maxRfc822NestingDepth: 3,
  });
  signal?.throwIfAborted();
  const canonicalUrl = canonicalNewsletterUrl(message);
  const title = normalizeText(message.subject ?? '') || path.basename(absolutePath, '.eml');
  const content = newsletterMarkdown(message, canonicalUrl ?? 'https://newsletter.invalid/');
  const analysis = analyzeMarkdown(content);
  return {
    kind: 'newsletter',
    locator: absolutePath,
    ...optionalMessageMetadata(message, canonicalUrl),
    title: [...title].slice(0, 500).join(''),
    content,
    mediaType: 'text/markdown',
    contentHash: analysis.contentHash,
    textHash: analysis.textHash,
    rawContent: raw,
    rawMediaType: 'message/rfc822',
    capture: { adapter: 'newsletter-eml', adapterVersion: '1', extractor: 'postal-mime', extractorVersion: '3' },
  };
}
