import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertPublicHttpUrl,
  isPrivateOrNonRoutableAddress,
  type ResolveHostname,
} from '../src/core/network.ts';
import { fetchArticleHtml } from '../src/core/ingest/url.ts';

const fixtureHtml = await readFile(new URL('./fixtures/article.html', import.meta.url), 'utf8');
const publicUrl = 'https://public.example.test/article';
const resolvePublic: ResolveHostname = async () => [{ address: '8.8.8.8', family: 4 }];

test('public-network policy rejects representative private and non-routable IPv4 and IPv6 addresses', () => {
  for (const address of [
    '0.0.0.1',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
  ]) {
    assert.equal(isPrivateOrNonRoutableAddress(address), true, address);
  }
  assert.equal(isPrivateOrNonRoutableAddress('8.8.8.8'), false);
  assert.equal(isPrivateOrNonRoutableAddress('2606:4700:4700::1111'), false);
});

test('public-network policy rejects localhost, credentials, and hostnames with private answers', async () => {
  await assert.rejects(
    () => assertPublicHttpUrl(new URL('http://localhost/article'), { label: 'Article URL' }),
    /private or non-routable/u,
  );
  await assert.rejects(
    () => assertPublicHttpUrl(new URL('https://user:secret@public.example.test/article'), {
      label: 'Article URL',
      resolveHostname: resolvePublic,
    }),
    /must not contain credentials/u,
  );
  await assert.rejects(
    () => assertPublicHttpUrl(new URL(publicUrl), {
      label: 'Article URL',
      resolveHostname: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    }),
    /private or non-routable address/u,
  );
});

test('bounded article fetch accepts a deterministic public HTML fixture', async () => {
  const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const fetchFixture = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), redirect: init?.redirect });
    return new Response(fixtureHtml, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(Buffer.byteLength(fixtureHtml)),
      },
    });
  }) as typeof fetch;

  const html = await fetchArticleHtml(publicUrl, undefined, {
    fetch: fetchFixture,
    resolveHostname: resolvePublic,
    maxBytes: Buffer.byteLength(fixtureHtml) + 1,
    timeoutMs: 1_000,
  });
  assert.equal(html, fixtureHtml);
  assert.deepEqual(requests, [{ url: publicUrl, redirect: 'manual' }]);
});

test('article fetch validates each redirect before making the next request', async () => {
  let requests = 0;
  const redirectToPrivate = (async () => {
    requests += 1;
    return new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
    });
  }) as typeof fetch;

  await assert.rejects(
    () => fetchArticleHtml(publicUrl, undefined, {
      fetch: redirectToPrivate,
      resolveHostname: resolvePublic,
      timeoutMs: 1_000,
    }),
    /private or non-routable address/u,
  );
  assert.equal(requests, 1);
});

test('article fetch rejects declared and streamed responses above the byte limit', async () => {
  const declaredOversize = (async () => new Response('small', {
    status: 200,
    headers: { 'content-type': 'text/html', 'content-length': '101' },
  })) as typeof fetch;
  await assert.rejects(
    () => fetchArticleHtml(publicUrl, undefined, {
      fetch: declaredOversize,
      resolveHostname: resolvePublic,
      maxBytes: 100,
      timeoutMs: 1_000,
    }),
    /exceeds the 100 byte limit/u,
  );

  const streamedOversize = (async () => new Response('x'.repeat(101), {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })) as typeof fetch;
  await assert.rejects(
    () => fetchArticleHtml(publicUrl, undefined, {
      fetch: streamedOversize,
      resolveHostname: resolvePublic,
      maxBytes: 100,
      timeoutMs: 1_000,
    }),
    /exceeds the 100 byte limit/u,
  );
});

test('article fetch bounds redirects and reports slow responses actionably', async () => {
  let redirects = 0;
  const redirectLoop = (async () => {
    redirects += 1;
    return new Response(null, { status: 302, headers: { location: '/again' } });
  }) as typeof fetch;
  await assert.rejects(
    () => fetchArticleHtml(publicUrl, undefined, {
      fetch: redirectLoop,
      resolveHostname: resolvePublic,
      maxRedirects: 1,
      timeoutMs: 1_000,
    }),
    /too many redirects/u,
  );
  assert.equal(redirects, 2);

  const slowFetch = ((_: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  })) as typeof fetch;
  await assert.rejects(
    () => fetchArticleHtml(publicUrl, undefined, {
      fetch: slowFetch,
      resolveHostname: resolvePublic,
      timeoutMs: 10,
    }),
    /timed out after 10 ms/u,
  );

  const slowBody = (async () => new Response(new ReadableStream<Uint8Array>({
    pull: () => new Promise(() => undefined),
  }), { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  await assert.rejects(
    () => fetchArticleHtml(publicUrl, undefined, {
      fetch: slowBody,
      resolveHostname: resolvePublic,
      timeoutMs: 10,
    }),
    /timed out after 10 ms/u,
  );
});
