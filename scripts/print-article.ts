#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { errorMessage } from './shared.ts';

interface ParsedArgs {
  url: string | null;
  slug: string | null;
  open: boolean;
  smallerBodyFont: boolean;
  imageScale: string | null;
}

function usage(): void {
  console.error(
    'Usage: pnpm article:read <url> --slug <slug> [--smaller-body-font] [--image-scale 1-100] [--open]\n\nFetches the article, builds Astro, verifies fidelity, and writes pdfs/<slug>.pdf. --smaller-body-font reduces article prose from 11pt to 10pt. --image-scale caps images at the given percentage of article width.',
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  let url: string | null = null;
  let slug: string | null = null;
  let open = false;
  let smallerBodyFont = false;
  let imageScale: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === '--open') {
      open = true;
      continue;
    }

    if (value === '--smaller-body-font') {
      smallerBodyFont = true;
      continue;
    }

    if (value === '--slug') {
      slug = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (value === '--image-scale') {
      const percentage = argv[index + 1];
      if (!percentage || percentage.startsWith('--')) {
        throw new Error('--image-scale requires an integer from 1 to 100');
      }
      imageScale = percentage;
      index += 1;
      continue;
    }

    if (!value.startsWith('--') && url === null) {
      url = value;
    }
  }

  return { url, slug, open, smallerBodyFont, imageScale };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      reject(new Error(`${command} ${args.join(' ')} failed with ${suffix}`));
    });
  });
}

async function main(): Promise<void> {
  const { url, slug, open, smallerBodyFont, imageScale } = parseArgs(process.argv.slice(2));
  if (!url || !slug) {
    usage();
    process.exit(1);
  }

  const fetchArgs = [
    'scripts/fetch-article.ts',
    url,
    '--slug',
    slug,
    '--save-html',
    path.join('sources', `${slug}.html`),
  ];
  if (smallerBodyFont) {
    fetchArgs.push('--smaller-body-font');
  }
  if (imageScale !== null) {
    fetchArgs.push('--image-scale', imageScale);
  }

  await run(process.execPath, fetchArgs);

  await run(process.execPath, [path.join('node_modules', 'astro', 'bin', 'astro.mjs'), 'build'], {
    ...process.env,
    ASTRO_TELEMETRY_DISABLED: '1',
  });
  await run(process.execPath, ['scripts/verify-fidelity.ts']);
  await run(process.execPath, ['scripts/render-pdfs.ts', slug]);

  if (open) {
    await run('open', [path.join('pdfs', `${slug}.pdf`)]);
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
