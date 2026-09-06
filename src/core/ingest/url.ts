import { inferSourceFontStyle, type SourceFontStyle } from '../extraction/fonts.ts';
import { extractWebArticle, type ExtractedWebArticle } from '../extraction/readability.ts';
import { assertHttpUrl } from '../extraction/urls.ts';
import { assertPublicHttpUrl, type ResolveHostname } from '../network.ts';
import { assertAcceptedResponse, readBoundedResponseText } from './http-response.ts';

export interface IngestedUrlArticle extends ExtractedWebArticle {
  sourceFontStyle: SourceFontStyle;
}

export interface UrlIngestionDependencies {
  fetchHtml?: (url: string, signal?: AbortSignal) => Promise<string>;
}

export interface ArticleFetchOptions {
  fetch?: typeof fetch;
  resolveHostname?: ResolveHostname;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_ARTICLE_BYTES = 10 * 1024 * 1024;
const DEFAULT_ARTICLE_REDIRECTS = 5;
const DEFAULT_ARTICLE_TIMEOUT_MS = 20_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface ResolvedArticleFetchOptions {
  fetch: typeof fetch;
  maxBytes: number;
  maxRedirects: number;
  resolveHostname?: ResolveHostname;
  timeoutMs: number;
}

function positiveArticleOption(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function articleRedirectLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Article redirect limit must be a non-negative integer');
  return value;
}

function resolveArticleFetchOptions(options: ArticleFetchOptions): ResolvedArticleFetchOptions {
  return {
    fetch: options.fetch ?? fetch,
    maxBytes: positiveArticleOption(options.maxBytes ?? DEFAULT_MAX_ARTICLE_BYTES, 'Article byte limit'),
    maxRedirects: articleRedirectLimit(options.maxRedirects ?? DEFAULT_ARTICLE_REDIRECTS),
    ...(options.resolveHostname ? { resolveHostname: options.resolveHostname } : {}),
    timeoutMs: positiveArticleOption(options.timeoutMs ?? DEFAULT_ARTICLE_TIMEOUT_MS, 'Article timeout'),
  };
}

async function fetchArticleResponse(
  initialUrl: URL,
  originalUrl: string,
  options: ResolvedArticleFetchOptions,
  signal: AbortSignal,
): Promise<{ response: Response; url: URL }> {
  let current = initialUrl;
  for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
    await assertPublicHttpUrl(current, {
      label: 'Article URL',
      ...(options.resolveHostname ? { resolveHostname: options.resolveHostname } : {}),
      signal,
    });
    const response = await options.fetch(current, {
      headers: {
        'user-agent': 'pi-reads/1.0',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'manual',
      signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, url: current };

    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error(`Article redirect is missing a location: ${current.href}`);
    if (redirects === options.maxRedirects) throw new Error(`Article URL has too many redirects: ${originalUrl}`);
    try {
      current = new URL(location, current);
    } catch {
      throw new Error(`Article redirect has an invalid location: ${location}`);
    }
  }
  throw new Error(`Article URL has too many redirects: ${originalUrl}`);
}

export async function fetchArticleHtml(
  url: string,
  signal?: AbortSignal,
  options: ArticleFetchOptions = {},
): Promise<string> {
  const initialUrl = assertHttpUrl(url);
  const resolved = resolveArticleFetchOptions(options);
  const timeoutSignal = AbortSignal.timeout(resolved.timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    const fetched = await fetchArticleResponse(initialUrl, url, resolved, requestSignal);
    await assertAcceptedResponse(fetched.response, fetched.url, {
      resource: 'article', contentLabel: 'URL', mediaTypes: ['text/html', 'application/xhtml+xml'],
    });
    return await readBoundedResponseText(fetched.response, fetched.url, resolved.maxBytes, requestSignal, 'Article');
  } catch (error: unknown) {
    if (timeoutSignal.aborted && !signal?.aborted) {
      throw new Error(`Article request timed out after ${resolved.timeoutMs} ms: ${url}`);
    }
    throw error;
  }
}

export async function ingestUrl(
  inputUrl: string,
  dependencies: UrlIngestionDependencies = {},
  signal?: AbortSignal,
): Promise<IngestedUrlArticle> {
  assertHttpUrl(inputUrl);
  signal?.throwIfAborted();
  const fetchHtml = dependencies.fetchHtml ?? fetchArticleHtml;
  const rawHtml = await fetchHtml(inputUrl, signal);
  signal?.throwIfAborted();
  const article = extractWebArticle(inputUrl, rawHtml);
  const sourceFontStyle = inferSourceFontStyle(article.readableContentHtml, rawHtml);
  signal?.throwIfAborted();

  return { ...article, sourceFontStyle };
}
