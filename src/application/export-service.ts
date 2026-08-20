import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import { chromium } from 'playwright';
import { codeToHtml } from 'shiki';
import type { ArticleRecord, Citation, ExportFormat, ExportRecord, SourceRecord } from '../core/domain.ts';
import {
  createImmutableRecordDirectory,
  createRecordId,
  exportDirectory,
  resolveLibraryPath,
  type RecordIdPrefix,
} from '../core/library.ts';
import { normalizeText, textForHash, versionedSha256 } from '../core/text.ts';
import { LibraryService } from './library-service.ts';

export interface ExportServiceOptions {
  library: LibraryService;
  allowGitWorkingTree?: boolean;
  now?: () => Date;
  createId?: (prefix: RecordIdPrefix) => string;
  printCssPath?: string;
}

export interface PreparedExport {
  record: ExportRecord;
  manifestPath: string;
  artifactPath: string;
}

interface ArticleSources {
  records: Map<string, SourceRecord>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]])/g, '\\$1').replace(/\s+/g, ' ').trim();
}

function artifactDetails(format: Exclude<ExportFormat, 'epub'>): { name: string; mediaType: string } {
  switch (format) {
    case 'markdown':
      return { name: 'article.md', mediaType: 'text/markdown' };
    case 'html':
      return { name: 'article.html', mediaType: 'text/html' };
    case 'pdf':
      return { name: 'article.pdf', mediaType: 'application/pdf' };
  }
}

function sourceLabel(source: SourceRecord): string {
  return source.title || source.origin.canonicalUrl || source.origin.locator;
}

function sourceUrl(source: SourceRecord): string | undefined {
  return source.origin.canonicalUrl;
}

function markdownWithCitationDefinitions(
  article: ArticleRecord,
  body: string,
  sources: ArticleSources,
  includeMetadata = true,
): string {
  const metadata = includeMetadata
    ? [
        '---',
        `piReadsArticleId: ${JSON.stringify(article.id)}`,
        `mode: ${JSON.stringify(article.mode)}`,
        `title: ${JSON.stringify(article.title)}`,
        `slug: ${JSON.stringify(article.slug)}`,
        `sources: ${JSON.stringify(article.sourceIds)}`,
        '---',
        '',
      ].join('\n')
    : '';

  if (article.citations.length === 0) {
    return `${metadata}${body.trim()}\n`;
  }

  const definitions = article.citations.map((citation) => {
    const source = sources.records.get(citation.sourceId);
    if (!source) {
      throw new Error(`Citation ${citation.id} references unavailable source ${citation.sourceId}`);
    }
    const label = escapeMarkdown(sourceLabel(source));
    const url = sourceUrl(source);
    const linked = url ? `[${label}](${url})` : label;
    const locator = citation.locator?.heading ? `, ${escapeMarkdown(citation.locator.heading)}` : '';
    const quote = citation.quote ? ` — “${escapeMarkdown(citation.quote)}”` : '';
    return `[^${citation.id}]: ${linked}${locator}${quote}`;
  });

  return `${metadata}${body.trim()}\n\n${definitions.join('\n')}\n`;
}

function replaceCitationMarkers(body: string, citations: readonly Citation[]): string {
  return citations.reduce((current, citation, index) => {
    const marker = `[^${citation.id}]`;
    const replacement = `<sup class="article-citation"><a href="#${citation.id}">[${index + 1}]</a></sup>`;
    return current.split(marker).join(replacement);
  }, body);
}

async function highlightCodeBlocks(html: string): Promise<string> {
  const dom = new JSDOM(`<!doctype html><main id="content">${html}</main>`);
  const { document } = dom.window;
  for (const pre of [...document.querySelectorAll('pre')]) {
    const code = pre.querySelector(':scope > code');
    if (!code) {
      continue;
    }
    const className = code.getAttribute('class') ?? '';
    const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1] ?? 'text';
    let highlighted: string;
    try {
      highlighted = await codeToHtml(code.textContent ?? '', { lang: language, theme: 'github-light' });
    } catch {
      highlighted = await codeToHtml(code.textContent ?? '', { lang: 'text', theme: 'github-light' });
    }
    const highlightedDocument = new JSDOM(highlighted).window.document;
    const highlightedPre = highlightedDocument.querySelector('pre');
    if (highlightedPre) {
      pre.replaceWith(document.importNode(highlightedPre, true));
    }
  }
  return document.querySelector('#content')?.innerHTML ?? '';
}

function citationListHtml(article: ArticleRecord, sources: ArticleSources): string {
  if (article.citations.length === 0) {
    return '';
  }

  const items = article.citations.map((citation, index) => {
    const source = sources.records.get(citation.sourceId);
    if (!source) {
      throw new Error(`Citation ${citation.id} references unavailable source ${citation.sourceId}`);
    }
    const label = escapeHtml(sourceLabel(source));
    const url = sourceUrl(source);
    const linked = url
      ? `<a href="${escapeHtml(url)}">${label}</a>`
      : label;
    const locator = citation.locator?.heading ? `, ${escapeHtml(citation.locator.heading)}` : '';
    const quote = citation.quote ? `<blockquote>${escapeHtml(citation.quote)}</blockquote>` : '';
    return `<li id="${citation.id}"><span>[${index + 1}] ${linked}${locator}</span>${quote}</li>`;
  });

  return `<section class="article-citations"><h2>Sources</h2><ol>${items.join('')}</ol></section>`;
}

export class ExportService {
  private readonly library: LibraryService;
  private readonly allowGitWorkingTree: boolean;
  private readonly now: () => Date;
  private readonly createId: (prefix: RecordIdPrefix) => string;
  private readonly printCssPath: string;

  constructor(options: ExportServiceOptions) {
    this.library = options.library;
    this.allowGitWorkingTree = options.allowGitWorkingTree ?? false;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((prefix) => createRecordId(prefix));
    this.printCssPath = options.printCssPath ?? fileURLToPath(new URL('../styles/print.css', import.meta.url));
  }

  private async loadSources(article: ArticleRecord): Promise<ArticleSources> {
    const entries = await Promise.all(
      article.sourceIds.map(async (sourceId) => [sourceId, (await this.library.loadSource(sourceId)).source] as const),
    );
    return { records: new Map(entries) };
  }

  async renderMarkdown(articleId: string, options: { includeMetadata?: boolean } = {}): Promise<string> {
    const stored = await this.library.loadArticle(articleId);
    const sources = await this.loadSources(stored.article);
    return markdownWithCitationDefinitions(
      stored.article,
      stored.content,
      sources,
      options.includeMetadata ?? true,
    );
  }

  async renderHtml(articleId: string): Promise<string> {
    const stored = await this.library.loadArticle(articleId);
    const { article, content } = stored;
    const sources = await this.loadSources(article);
    const bodyWithMarkers = replaceCitationMarkers(content, article.citations);
    const bodyHtml = await highlightCodeBlocks(marked.parse(bodyWithMarkers, { async: false }));
    const css = await readFile(this.printCssPath, 'utf8');
    const authors = article.authors?.join(', ') ?? '';
    const sourceLinks = article.sourceIds
      .map((sourceId) => sources.records.get(sourceId))
      .filter((source): source is SourceRecord => Boolean(source))
      .map((source) => {
        const label = escapeHtml(sourceLabel(source));
        const url = sourceUrl(source);
        return url ? `<a href="${escapeHtml(url)}">${label}</a>` : label;
      })
      .join(' · ');
    const fontStyle = article.presentation?.sourceFontStyle === 'sans-serif' ? 'sans-serif' : 'serif';
    const bodyFontSize = article.presentation?.bodyFontSizeAdjustment === -1 ? 'smaller' : 'default';
    const imageScale = article.presentation?.imageScalePercent ?? 100;

    const html = `<!doctype html>
<html lang="${escapeHtml(article.language ?? 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(article.title)}</title>
<style>${css}</style>
</head>
<body data-font-style="${fontStyle}" data-body-font-size="${bodyFontSize}" data-image-sizing="${imageScale < 100 ? 'scaled' : 'default'}" style="--article-image-max-width: ${imageScale}%">
<article class="article-shell">
<header class="article-header">
<h1 class="article-title">${escapeHtml(article.title)}</h1>
${article.description ? `<p class="article-description">${escapeHtml(article.description)}</p>` : ''}
${authors ? `<p class="article-meta">${escapeHtml(authors)}</p>` : ''}
${sourceLinks ? `<p class="article-source">Sources: ${sourceLinks}</p>` : ''}
</header>
<main class="article-body">${bodyHtml}${citationListHtml(article, sources)}</main>
</article>
</body>
</html>
`;

    if (article.mode === 'archive') {
      const dom = new JSDOM(html);
      const articleBody = dom.window.document.querySelector('.article-body');
      if (!articleBody) {
        throw new Error('Rendered archive has no article body');
      }
      const textHash = versionedSha256(normalizeText(textForHash(articleBody)));
      if (textHash !== article.body.textHash) {
        throw new Error(`Archive fidelity mismatch: expected ${article.body.textHash}, got ${textHash}`);
      }
    }

    return html;
  }

  async prepare(articleId: string, format: Exclude<ExportFormat, 'epub'>, signal?: AbortSignal): Promise<PreparedExport> {
    signal?.throwIfAborted();
    const stored = await this.library.loadArticle(articleId);
    const sources = await this.loadSources(stored.article);
    const details = artifactDetails(format);
    let artifact: string | Uint8Array;

    switch (format) {
      case 'markdown':
        artifact = markdownWithCitationDefinitions(stored.article, stored.content, sources);
        break;
      case 'html':
        artifact = await this.renderHtml(articleId);
        break;
      case 'pdf': {
        const html = await this.renderHtml(articleId);
        signal?.throwIfAborted();
        const browser = await chromium.launch().catch((error: unknown) => {
          throw new Error(`Chromium is required for PDF export. Run /reads-install-browser or install Playwright Chromium. ${String(error)}`);
        });
        try {
          const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
          await page.setContent(html, { waitUntil: 'networkidle' });
          await page.emulateMedia({ media: 'print' });
          artifact = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
          });
          await page.close();
        } finally {
          await browser.close();
        }
        break;
      }
    }

    signal?.throwIfAborted();
    const exportId = this.createId('exp');
    const directory = exportDirectory(articleId, exportId);
    const artifactPath = path.posix.join(directory, details.name);
    const contentHash = versionedSha256(artifact);
    const record: ExportRecord = {
      schemaVersion: 1,
      id: exportId,
      articleId,
      format,
      destination: { type: 'local' },
      status: 'prepared',
      artifact: {
        path: artifactPath,
        mediaType: details.mediaType,
        contentHash,
        byteLength: typeof artifact === 'string' ? Buffer.byteLength(artifact) : artifact.byteLength,
      },
      createdAt: this.now().toISOString(),
    };

    await createImmutableRecordDirectory(
      this.library.libraryDir,
      directory,
      [
        { path: details.name, contents: artifact },
        { path: 'manifest.json', contents: `${JSON.stringify(record, null, 2)}\n` },
      ],
      { allowGitWorkingTree: this.allowGitWorkingTree },
    );

    return {
      record,
      manifestPath: resolveLibraryPath(this.library.libraryDir, path.posix.join(directory, 'manifest.json')),
      artifactPath: resolveLibraryPath(this.library.libraryDir, artifactPath),
    };
  }
}
