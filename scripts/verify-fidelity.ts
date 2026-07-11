#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { JSDOM } from 'jsdom';
import { articleSlug, errorMessage, normalizeText, parseFrontmatter, sha256 } from './shared.ts';

interface PassResult {
  status: 'pass';
  articlePath: string;
  slug: string;
  characters: number;
}

interface SkipResult {
  status: 'skip';
  articlePath: string;
  slug: string;
  reason: string;
}

interface FailResult {
  status: 'fail';
  articlePath: string;
  slug: string;
  reason: string;
}

type VerifyResult = PassResult | SkipResult | FailResult;

async function findArticles(): Promise<string[]> {
  const entries = await readdir('articles', { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join('articles', entry.name));
}

async function verifyArticle(articlePath: string): Promise<VerifyResult> {
  const markdown = await readFile(articlePath, 'utf8');
  const metadata = parseFrontmatter(markdown);
  const slug = articleSlug(articlePath, metadata);
  const expectedHash = metadata.sourceTextHash;

  if (typeof expectedHash !== 'string' || !expectedHash) {
    return { status: 'skip', articlePath, slug, reason: 'missing sourceTextHash' };
  }

  const renderedPath = path.join('dist', 'read', slug, 'index.html');
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

  const actualText = normalizeText(body.textContent ?? '');
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

async function main(): Promise<void> {
  const articles = await findArticles();
  if (articles.length === 0) {
    console.error('No articles/*.md files found.');
    process.exit(1);
  }

  const results = await Promise.all(articles.map(verifyArticle));
  let failures = 0;

  for (const result of results) {
    switch (result.status) {
      case 'pass':
        console.log(`PASS ${result.slug} (${result.characters} normalized chars)`);
        break;
      case 'skip':
        console.log(`SKIP ${result.slug}: ${result.reason}`);
        break;
      case 'fail':
        failures += 1;
        console.error(`FAIL ${result.slug}: ${result.reason}`);
        break;
    }
  }

  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
