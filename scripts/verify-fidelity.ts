#!/usr/bin/env node
import process from 'node:process';
import {
  findLegacyArticles,
  verifyLegacyArticles,
  type VerifyResult,
} from '../src/core/render/fidelity.ts';
import { errorMessage } from './shared.ts';

function report(result: VerifyResult): boolean {
  switch (result.status) {
    case 'pass':
      console.log(`PASS ${result.slug} (${result.characters} normalized chars)`);
      return true;
    case 'skip':
      console.log(`SKIP ${result.slug}: ${result.reason}`);
      return true;
    case 'fail':
      console.error(`FAIL ${result.slug}: ${result.reason}`);
      return false;
  }
}

async function main(): Promise<void> {
  const requestedSlugs = new Set(process.argv.slice(2));
  const articles = await findLegacyArticles('articles', requestedSlugs);
  if (articles.length === 0) {
    const qualifier = requestedSlugs.size > 0 ? ` matching ${[...requestedSlugs].join(', ')}` : '';
    throw new Error(`No articles${qualifier} found.`);
  }

  const results = await verifyLegacyArticles(articles);
  if (!results.every(report)) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
