import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseConfig } from '../src/core/config.ts';

interface PackageManifest {
  name?: string;
  version?: string;
  author?: string;
  bugs?: { url?: string };
  contributors?: string[];
  dependencies?: Record<string, string>;
  files?: string[];
  homepage?: string;
  license?: string;
  repository?: { type?: string; url?: string };
}

async function repositoryFile(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('release metadata, attribution, and sample configuration are complete and secret-free', async () => {
  const manifest = JSON.parse(await repositoryFile('package.json')) as PackageManifest;
  assert.equal(manifest.name, 'pi-reads');
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.author, 'Revaz Zakalashvili');
  assert.ok(manifest.contributors?.includes('Irakli Janiashvili'));
  assert.equal(manifest.repository?.type, 'git');
  assert.match(manifest.repository?.url ?? '', /github\.com\/revazi\/pi-reads/);
  assert.match(manifest.homepage ?? '', /github\.com\/revazi\/pi-reads/);
  assert.match(manifest.bugs?.url ?? '', /github\.com\/revazi\/pi-reads\/issues/);
  assert.ok(manifest.files?.includes('examples'));
  assert.ok(manifest.files?.includes('SECURITY.md'));

  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    assert.doesNotMatch(version, /^(?:latest|next|\*)$|^[~^]/u, `${name} must use an exact runtime version`);
  }

  const sampleText = await repositoryFile('examples/pi-reads.example.json');
  const sample = parseConfig(JSON.parse(sampleText) as unknown);
  assert.equal(sample.schemaVersion, 1);
  assert.equal(sample.kindle?.recipientEnv, 'PI_READS_KINDLE_ADDRESS');
  assert.equal(sample.kindle?.smtp?.passwordEnv, 'PI_READS_SMTP_PASSWORD');
  assert.doesNotMatch(sampleText, /@kindle\.com|password\s*[:=]\s*["'][^"']+/iu);

  const readme = await repositoryFile('README.md');
  assert.match(readme, /^# Pi Reads$/mu);
  assert.match(readme, /Irakli Janiashvili/);
  assert.match(readme, /article:read/);
  assert.match(readme, /visible-text hash/);

  await Promise.all([
    repositoryFile('LICENSE'),
    repositoryFile('SECURITY.md'),
    repositoryFile('CHANGELOG.md'),
    repositoryFile('CONTRIBUTING.md'),
    repositoryFile('docs/releasing.md'),
  ]);
});
