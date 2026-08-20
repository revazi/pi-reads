import { detectSourceFontStyle, type SourceFontStyle } from '../extraction/fonts.ts';
import { extractWebArticle, type ExtractedWebArticle } from '../extraction/readability.ts';
import { assertHttpUrl } from '../extraction/urls.ts';

export interface IngestedUrlArticle extends ExtractedWebArticle {
  sourceFontStyle: SourceFontStyle;
}

export interface UrlIngestionDependencies {
  fetchHtml?: (url: string, signal?: AbortSignal) => Promise<string>;
  detectFontStyle?: (url: string, contentHtml: string) => Promise<SourceFontStyle>;
}

export async function fetchArticleHtml(url: string, signal?: AbortSignal): Promise<string> {
  assertHttpUrl(url);
  const response = await fetch(url, {
    headers: {
      'user-agent': 'pi-reads/1.0',
      accept: 'text/html,application/xhtml+xml',
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    throw new Error(`Unsupported URL content type: ${contentType}`);
  }

  return response.text();
}

export async function ingestUrl(
  inputUrl: string,
  dependencies: UrlIngestionDependencies = {},
  signal?: AbortSignal,
): Promise<IngestedUrlArticle> {
  assertHttpUrl(inputUrl);
  signal?.throwIfAborted();
  const fetchHtml = dependencies.fetchHtml ?? fetchArticleHtml;
  const detectFontStyle = dependencies.detectFontStyle ?? detectSourceFontStyle;
  const rawHtml = await fetchHtml(inputUrl, signal);
  signal?.throwIfAborted();
  const article = extractWebArticle(inputUrl, rawHtml);
  const sourceFontStyle = await detectFontStyle(inputUrl, article.readableContentHtml);
  signal?.throwIfAborted();

  return { ...article, sourceFontStyle };
}
