#!/usr/bin/env node
import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { errorMessage } from './shared.ts';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

interface PackEntry {
  path: string;
  size: number;
}

interface PackReport {
  entryCount: number;
  files: PackEntry[];
  name: string;
  size: number;
  version: string;
}

const REQUIRED_FILES = [
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'examples/pi-reads.example.json',
  'extensions/pi-reads/index.ts',
  'package.json',
  'schemas/v1/article-user-state.schema.json',
  'schemas/v1/citation-diagnostics.schema.json',
  'schemas/v1/config.schema.json',
  'schemas/v1/portable-snapshot.schema.json',
  'scripts/maintain-library.ts',
  'src/application/maintenance-service.ts',
  'src/application/library-verification.ts',
  'src/core/record-validation.ts',
  'docs/library-maintenance.md',
  'schemas/v1/search-index.schema.json',
  'schemas/v1/source-content-index.schema.json',
  'schemas/v1/user-state-snapshot.schema.json',
  'skills/pi-reads/SKILL.md',
] as const;

function forbiddenReason(filePath: string): string | undefined {
  const normalized = filePath.replaceAll('\\', '/');
  const root = normalized.split('/')[0];
  if (['.agents', '.env', 'AGENTS.md', 'articles', 'dist', 'node_modules', 'pdfs', 'phases.md', 'sources', 'tests'].includes(root)) {
    return 'local, generated, test, or agent-only path';
  }
  if (/(?:^|\/)pi-reads\.json$/u.test(normalized)) {
    return 'live configuration file';
  }
  if (/\.(?:epub|pdf|tgz)$/iu.test(normalized)) {
    return 'generated artifact';
  }
  return undefined;
}

async function main(): Promise<void> {
  const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const reports = JSON.parse(stdout) as PackReport[];
  const report = reports[0];
  if (!report || !Array.isArray(report.files)) {
    throw new Error('npm pack did not return a package-content report');
  }

  const paths = new Set(report.files.map((file) => file.path));
  const missing = REQUIRED_FILES.filter((file) => !paths.has(file));
  if (missing.length > 0) {
    throw new Error(`Release package is missing required files: ${missing.join(', ')}`);
  }

  const forbidden = report.files
    .map((file) => ({ path: file.path, reason: forbiddenReason(file.path) }))
    .filter((entry): entry is { path: string; reason: string } => Boolean(entry.reason));
  if (forbidden.length > 0) {
    throw new Error(`Release package contains forbidden files:\n${forbidden.map((entry) => `- ${entry.path}: ${entry.reason}`).join('\n')}`);
  }

  const oversized = report.files.filter((file) => file.size > 1_000_000);
  if (oversized.length > 0) {
    throw new Error(`Release package contains unexpectedly large files: ${oversized.map((file) => file.path).join(', ')}`);
  }

  console.log(
    `PASS ${report.name}@${report.version}: ${report.entryCount} files, ${report.size} bytes; required resources present and local/generated artifacts excluded.`,
  );
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
