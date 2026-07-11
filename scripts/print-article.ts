#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { errorMessage } from './shared.ts';

interface ParsedArgs {
  url: string | null;
  slug: string | null;
  open: boolean;
}

function usage(): void {
  console.error(
    'Usage: pnpm article:read <url> --slug <slug> [--open]\n\nFetches the article, builds Astro, verifies fidelity, and writes pdfs/<slug>.pdf.',
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  let url: string | null = null;
  let slug: string | null = null;
  let open = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === '--open') {
      open = true;
      continue;
    }

    if (value === '--slug') {
      slug = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (!value.startsWith('--') && url === null) {
      url = value;
    }
  }

  return { url, slug, open };
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
  const { url, slug, open } = parseArgs(process.argv.slice(2));
  if (!url || !slug) {
    usage();
    process.exit(1);
  }

  await run(process.execPath, [
    'scripts/fetch-article.ts',
    url,
    '--slug',
    slug,
    '--save-html',
    path.join('sources', `${slug}.html`),
  ]);

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
