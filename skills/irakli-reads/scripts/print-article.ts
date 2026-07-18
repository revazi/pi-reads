#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectRoot(): string {
  const filePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filePath), '../../..');
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });

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
  if (process.argv.length < 3 || process.argv.includes('--help')) {
    console.error("Usage: node skills/irakli-reads/scripts/print-article.ts '<URL>' --slug '<slug>' [--smaller-body-font] [--image-scale 1-100] [--open]");
    process.exit(1);
  }

  await run(process.execPath, ['scripts/print-article.ts', ...process.argv.slice(2)], projectRoot());
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
