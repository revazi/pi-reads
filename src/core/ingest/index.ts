import type { IngestedSourceDraft } from '../domain.ts';
import { versionedSha256 } from '../text.ts';
import { ingestFile } from './file.ts';
import { ingestMarkdown, ingestText } from './text.ts';
import { ingestUrl, type UrlIngestionDependencies } from './url.ts';

export type SourceInput =
  | { kind: 'url'; url: string }
  | { kind: 'text'; text: string; label?: string }
  | { kind: 'markdown'; markdown: string; label?: string }
  | { kind: 'file'; path: string; cwd?: string };

export interface IngestSourceDependencies {
  url?: UrlIngestionDependencies;
}

export async function ingestSource(
  input: SourceInput,
  dependencies: IngestSourceDependencies = {},
  signal?: AbortSignal,
): Promise<IngestedSourceDraft> {
  switch (input.kind) {
    case 'url': {
      const article = await ingestUrl(input.url, dependencies.url, signal);
      return {
        kind: 'url',
        locator: input.url,
        canonicalUrl: article.sourceUrl,
        title: article.title,
        description: article.description || undefined,
        authors: article.author ? [article.author] : undefined,
        publishedAt: article.date || undefined,
        content: article.body,
        mediaType: 'text/markdown',
        contentHash: versionedSha256(article.body),
        textHash: versionedSha256(article.sourceText),
        rawContent: article.rawHtml,
        rawMediaType: 'text/html',
        sourceFontStyle: article.sourceFontStyle,
        capture: {
          adapter: 'url',
          extractor: '@mozilla/readability',
        },
      };
    }
    case 'text':
      return ingestText(input.text, input.label);
    case 'markdown':
      return ingestMarkdown(input.markdown, input.label);
    case 'file':
      return ingestFile(input.path, input.cwd);
    default:
      throw new Error(`Unsupported source input kind: ${String((input as { kind?: unknown }).kind)}`);
  }
}
