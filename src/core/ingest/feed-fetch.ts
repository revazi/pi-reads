import { assertPublicHttpUrl, type ResolveHostname } from '../network.ts';
import { MAX_FEED_BYTES } from './feed.ts';
import { assertAcceptedResponse, readBoundedResponseText } from './http-response.ts';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FEED_MEDIA_TYPES = ['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml', 'text/plain'];

export interface FeedFetchOptions {
  fetch?: typeof fetch;
  resolveHostname?: ResolveHostname;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

function feedUrl(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`Invalid feed URL: ${value}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Unsupported feed URL protocol: ${parsed.protocol}`);
  if (parsed.username || parsed.password) throw new Error('Feed URL must not contain credentials');
  return parsed;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function redirectLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Feed redirect limit must be a non-negative integer');
  return value;
}

interface ResolvedFeedFetchOptions {
  fetch: typeof fetch;
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
  resolveHostname?: ResolveHostname;
}

function options(input: FeedFetchOptions): ResolvedFeedFetchOptions {
  return {
    fetch: input.fetch ?? fetch,
    maxBytes: positiveInteger(input.maxBytes ?? MAX_FEED_BYTES, 'Feed byte limit'),
    maxRedirects: redirectLimit(input.maxRedirects ?? 5),
    timeoutMs: positiveInteger(input.timeoutMs ?? 20_000, 'Feed timeout'),
    ...(input.resolveHostname ? { resolveHostname: input.resolveHostname } : {}),
  };
}

function redirectedUrl(response: Response, current: URL, original: string, redirects: number, maximum: number): URL {
  const location = response.headers.get('location');
  if (!location) throw new Error(`Feed redirect is missing a location: ${current.href}`);
  if (redirects === maximum) throw new Error(`Feed URL has too many redirects: ${original}`);
  try { return feedUrl(new URL(location, current).href); }
  catch { throw new Error(`Feed redirect has an invalid location: ${location}`); }
}

async function feedResponse(
  initial: URL,
  original: string,
  resolved: ResolvedFeedFetchOptions,
  signal: AbortSignal,
): Promise<{ response: Response; url: URL }> {
  let current = initial;
  for (let redirects = 0; redirects <= resolved.maxRedirects; redirects += 1) {
    await assertPublicHttpUrl(current, {
      label: 'Feed URL',
      ...(resolved.resolveHostname ? { resolveHostname: resolved.resolveHostname } : {}),
      signal,
    });
    const response = await resolved.fetch(current, {
      headers: { 'user-agent': 'pi-reads/1.0', accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9' },
      redirect: 'manual', signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, url: current };
    await response.body?.cancel();
    current = redirectedUrl(response, current, original, redirects, resolved.maxRedirects);
  }
  throw new Error(`Feed URL has too many redirects: ${original}`);
}

export async function fetchFeedXml(
  value: string,
  signal?: AbortSignal,
  inputOptions: FeedFetchOptions = {},
): Promise<string> {
  const resolved = options(inputOptions);
  const timeout = AbortSignal.timeout(resolved.timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const fetched = await feedResponse(feedUrl(value), value, resolved, requestSignal);
    await assertAcceptedResponse(fetched.response, fetched.url, {
      resource: 'feed', contentLabel: 'feed', mediaTypes: FEED_MEDIA_TYPES,
    });
    return await readBoundedResponseText(fetched.response, fetched.url, resolved.maxBytes, requestSignal, 'Feed', true);
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) throw new Error(`Feed request timed out after ${resolved.timeoutMs} ms: ${value}`);
    throw error;
  }
}
