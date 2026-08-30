import { inferSourceFontStyle, type SourceFontStyle } from '../extraction/fonts.ts';
import { extractWebArticle, type ExtractedWebArticle } from '../extraction/readability.ts';
import { assertHttpUrl } from '../extraction/urls.ts';
import { assertPublicHttpUrl, type ResolveHostname } from '../network.ts';

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

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      operation();
    };
    const abort = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined);
      finish(() => reject(signal.reason));
    };
    signal.addEventListener('abort', abort, { once: true });
    reader.read().then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function responseText(
  response: Response,
  url: URL,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const lengthHeader = response.headers.get('content-length');
  const declaredLength = lengthHeader === null ? undefined : Number(lengthHeader);
  if (declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Article response exceeds the ${maxBytes} byte limit: ${url.href}`);
  }
  if (!response.body) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Article response exceeds the ${maxBytes} byte limit: ${url.href}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

interface ResolvedArticleFetchOptions {
  fetch: typeof fetch;
  maxBytes: number;
  maxRedirects: number;
  resolveHostname?: ResolveHostname;
  timeoutMs: number;
}

function resolveArticleFetchOptions(options: ArticleFetchOptions): ResolvedArticleFetchOptions {
  const resolved = {
    fetch: options.fetch ?? fetch,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_ARTICLE_BYTES,
    maxRedirects: options.maxRedirects ?? DEFAULT_ARTICLE_REDIRECTS,
    ...(options.resolveHostname ? { resolveHostname: options.resolveHostname } : {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_ARTICLE_TIMEOUT_MS,
  };
  if (!Number.isSafeInteger(resolved.maxBytes) || resolved.maxBytes < 1) throw new Error('Article byte limit must be a positive integer');
  if (!Number.isSafeInteger(resolved.maxRedirects) || resolved.maxRedirects < 0) throw new Error('Article redirect limit must be a non-negative integer');
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs < 1) throw new Error('Article timeout must be a positive integer');
  return resolved;
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

async function assertHtmlResponse(response: Response, url: URL): Promise<void> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Could not fetch article ${url.href}: HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    await response.body?.cancel();
    throw new Error(`Unsupported URL content type: ${contentType}`);
  }
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
    await assertHtmlResponse(fetched.response, fetched.url);
    return await responseText(fetched.response, fetched.url, resolved.maxBytes, requestSignal);
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
