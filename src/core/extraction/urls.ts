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

export function cleanUrl(value: string, baseUrl: string): string {
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

export function canonicalUrl(document: Document, inputUrl: string): string {
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
  return cleanUrl(canonical ?? inputUrl, inputUrl) || inputUrl;
}

export function assertHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid article URL: ${value}`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported article URL protocol: ${url.protocol}`);
  }

  return url;
}
