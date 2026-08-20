import { sha256 } from '../text.ts';
import type { SourceFontStyle } from '../extraction/fonts.ts';
import type { ExtractedWebArticle } from '../extraction/readability.ts';

export interface LegacyArticleOptions {
  slug?: string;
  sourceFontStyle: SourceFontStyle;
  bodyFontSizeAdjustment?: -1;
  imageScalePercent?: number;
}

type MetadataValue = string | number | null | undefined;

function yamlScalar(value: MetadataValue): string {
  return JSON.stringify(value);
}

function frontmatter(metadata: Record<string, MetadataValue>): string {
  return [
    '---',
    ...Object.entries(metadata)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${yamlScalar(value)}`),
    '---',
    '',
  ].join('\n');
}

export function renderLegacyArticleMarkdown(article: ExtractedWebArticle, options: LegacyArticleOptions): string {
  const metadata = {
    title: article.title,
    slug: options.slug,
    source: article.sourceUrl,
    author: article.author,
    date: article.date.slice(0, 10) || article.date,
    description: article.description,
    sourceFontStyle: options.sourceFontStyle,
    bodyFontSizeAdjustment: options.bodyFontSizeAdjustment,
    imageScalePercent: options.imageScalePercent,
    sourceTextHash: sha256(article.sourceText),
  };

  return `${frontmatter(metadata)}${article.body}\n`;
}
