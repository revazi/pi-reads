import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturePath = path.join(repositoryRoot, 'tests', 'fixtures', 'article.expected.md');
const articlePath = path.join(repositoryRoot, 'articles', 'phase1-fixture.md');

interface CommandResult {
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} failed (${signal ?? code}):\n${stdout}\n${stderr}`));
    });
  });
}

test('synthetic article passes the real Astro and fidelity pipeline', { timeout: 30_000 }, async () => {
  const fixture = await readFile(fixturePath, 'utf8');
  await writeFile(articlePath, fixture, { flag: 'wx' });

  try {
    await run(process.execPath, [path.join('node_modules', 'astro', 'bin', 'astro.mjs'), 'build']);
    const verification = await run(process.execPath, ['scripts/verify-fidelity.ts', 'phase1-fixture']);
    assert.match(verification.stdout, /PASS phase1-fixture/);
  } finally {
    await unlink(articlePath).catch(() => undefined);
  }
});
