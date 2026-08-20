import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { cleanArticleContent, descriptionRepeatsOpening, isBylineText } from './cleanup.ts';
import { markdownFromHtml } from './markdown.ts';
import { canonicalUrl } from './urls.ts';

export interface ExtractedWebArticle {
  inputUrl: string;
  sourceUrl: string;
  title: string;
  author: string;
  date: string;
  description: string;
  body: string;
  sourceText: string;
  cleanedHtml: string;
  readableContentHtml: string;
  rawHtml: string;
}

function meta(document: Document, selector: string): string {
  const element = document.querySelector(selector);
  const content = element?.getAttribute('content');
  return content?.trim() ?? '';
}

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return slug || 'article';
}

export function extractWebArticle(inputUrl: string, rawHtml: string): ExtractedWebArticle {
  const sourceDom = new JSDOM(rawHtml, { url: inputUrl });
  const { document } = sourceDom.window;
  const sourceUrl = canonicalUrl(document, inputUrl);
  const fallbackTitle = meta(document, 'meta[property="og:title"]') || document.title;
  const fallbackAuthor = meta(document, 'meta[name="author"]');
  const metadataDescription =
    meta(document, 'meta[name="description"]') ||
    meta(document, 'meta[property="og:description"]') ||
    meta(document, 'meta[name="twitter:description"]');
  const fallbackDate =
    meta(document, 'meta[property="article:published_time"]') ||
    document.querySelector('time[datetime]')?.getAttribute('datetime') ||
    '';

  const reader = new Readability(document, { keepClasses: true });
  const article = reader.parse();
  if (!article?.content) {
    throw new Error('Readability could not extract article content');
  }

  const cleaned = cleanArticleContent(article.content, sourceUrl);
  const title = article.title || fallbackTitle || 'Untitled article';
  const author = article.byline || fallbackAuthor;
  const candidateDescription = metadataDescription || article.excerpt || '';
  const description =
    isBylineText(candidateDescription) || descriptionRepeatsOpening(candidateDescription, cleaned.html)
      ? ''
      : candidateDescription;

  return {
    inputUrl,
    sourceUrl,
    title,
    author,
    date: fallbackDate,
    description,
    body: markdownFromHtml(cleaned.html),
    sourceText: cleaned.text,
    cleanedHtml: cleaned.html,
    readableContentHtml: article.content,
    rawHtml,
  };
}
