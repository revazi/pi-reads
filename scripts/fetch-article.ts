#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { slugify } from '../src/core/extraction/readability.ts';
import { ingestUrl } from '../src/core/ingest/url.ts';
import { renderLegacyArticleMarkdown } from '../src/core/render/legacy-markdown.ts';
import { errorMessage } from './shared.ts';

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string>;
}

function usage(): void {
  console.error(
    'Usage: pnpm article:fetch <url> [--slug slug] [--smaller-body-font] [--image-scale 1-100] [--out articles] [--save-html sources/name.html] [--save-clean-html sources/name.clean.html] [--save-text sources/name.txt]\n\nFetches a web article, extracts readable content, cleans links, and writes Markdown without LLM rewriting. --smaller-body-font reduces article prose from 11pt to 10pt. --image-scale caps images at the given percentage of article width without enlarging smaller images.',
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }

    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(key, 'true');
      continue;
    }

    flags.set(key, next);
    index += 1;
  }

  return { positional, flags };
}

function parseImageScale(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const percentage = Number(value);
  if (value === 'true' || !Number.isInteger(percentage) || percentage < 1 || percentage > 100) {
    throw new Error('--image-scale must be an integer from 1 to 100');
  }

  return percentage;
}

async function saveOptionalFile(filePath: string | undefined, contents: string): Promise<void> {
  if (!filePath || filePath === 'true') {
    return;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const inputUrl = positional[0];

  if (!inputUrl || flags.has('help')) {
    usage();
    process.exit(inputUrl ? 0 : 1);
  }

  const imageScalePercent = parseImageScale(flags.get('image-scale'));
  const article = await ingestUrl(inputUrl);
  const slug = flags.get('slug') ?? slugify(article.title);
  const outputDir = flags.get('out') ?? 'articles';
  const outputPath = path.join(outputDir, `${slug}.md`);
  const bodyFontSizeAdjustment: -1 | undefined = flags.has('smaller-body-font') ? -1 : undefined;
  const markdown = renderLegacyArticleMarkdown(article, {
    slug,
    sourceFontStyle: article.sourceFontStyle,
    bodyFontSizeAdjustment,
    imageScalePercent,
  });

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, markdown, 'utf8');

  await saveOptionalFile(flags.get('save-html'), article.rawHtml);
  await saveOptionalFile(flags.get('save-clean-html'), article.cleanedHtml);
  await saveOptionalFile(flags.get('save-text'), article.sourceText);

  console.log(`Wrote ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
