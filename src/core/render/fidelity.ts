import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { articleSlug, parseFrontmatter } from '../frontmatter.ts';
import { normalizeText, sha256, textForHash } from '../text.ts';

export interface PassResult {
  status: 'pass';
  articlePath: string;
  slug: string;
  characters: number;
}

export interface SkipResult {
  status: 'skip';
  articlePath: string;
  slug: string;
  reason: string;
}

export interface FailResult {
  status: 'fail';
  articlePath: string;
  slug: string;
  reason: string;
}

export type VerifyResult = PassResult | SkipResult | FailResult;

export interface VerifyArticleOptions {
  distDir?: string;
}

export async function findLegacyArticles(
  articleDir = 'articles',
  requestedSlugs: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const entries = await readdir(articleDir, { withFileTypes: true });
  const matched: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    const articlePath = path.join(articleDir, entry.name);
    if (requestedSlugs.size > 0) {
      const markdown = await readFile(articlePath, 'utf8');
      const slug = articleSlug(articlePath, parseFrontmatter(markdown));
      if (!requestedSlugs.has(slug)) {
        continue;
      }
    }
    matched.push(articlePath);
  }

  return matched.sort((left, right) => left.localeCompare(right));
}

export async function verifyLegacyArticle(
  articlePath: string,
  options: VerifyArticleOptions = {},
): Promise<VerifyResult> {
  const markdown = await readFile(articlePath, 'utf8');
  const metadata = parseFrontmatter(markdown);
  const slug = articleSlug(articlePath, metadata);
  const expectedHash = metadata.sourceTextHash;

  if (typeof expectedHash !== 'string' || !expectedHash) {
    return { status: 'skip', articlePath, slug, reason: 'missing sourceTextHash' };
  }

  const renderedPath = path.join(options.distDir ?? 'dist', 'read', slug, 'index.html');
  let rendered: string;
  try {
    rendered = await readFile(renderedPath, 'utf8');
  } catch {
    return { status: 'fail', articlePath, slug, reason: `missing ${renderedPath}; run pnpm build first` };
  }

  const dom = new JSDOM(rendered);
  const body = dom.window.document.querySelector('.article-body');
  if (!body) {
    return { status: 'fail', articlePath, slug, reason: 'rendered page has no .article-body' };
  }

  const actualText = normalizeText(textForHash(body));
  const actualHash = sha256(actualText);
  if (actualHash !== expectedHash) {
    return {
      status: 'fail',
      articlePath,
      slug,
      reason: `text hash mismatch: expected ${expectedHash}, got ${actualHash}`,
    };
  }

  return { status: 'pass', articlePath, slug, characters: actualText.length };
}

export async function verifyLegacyArticles(
  articlePaths: readonly string[],
  options: VerifyArticleOptions = {},
): Promise<VerifyResult[]> {
  return Promise.all(articlePaths.map((articlePath) => verifyLegacyArticle(articlePath, options)));
}
