import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

interface PackageManifest {
  keywords?: string[];
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pi?: {
    extensions?: string[];
    skills?: string[];
  };
}

test('package manifest exposes installable Pi resources and production runtime dependencies', async () => {
  const packagePath = new URL('../package.json', import.meta.url);
  const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as PackageManifest;

  assert.ok(manifest.keywords?.includes('pi-package'));
  assert.ok(manifest.files?.includes('extensions'));
  assert.ok(!manifest.files?.includes('.agents'));
  assert.deepEqual(manifest.pi?.extensions, ['./extensions/pi-reads/index.ts']);
  assert.deepEqual(manifest.pi?.skills, ['./skills/pi-reads']);
  assert.equal(manifest.peerDependencies?.['@earendil-works/pi-coding-agent'], '*');
  assert.equal(manifest.peerDependencies?.['@earendil-works/pi-ai'], '*');
  assert.equal(manifest.peerDependencies?.['@earendil-works/pi-tui'], '*');
  assert.equal(manifest.dependencies?.['@napi-rs/keyring'], '1.3.0');
  assert.ok(manifest.dependencies?.playwright);
  assert.equal(manifest.dependencies?.fflate, '0.8.3');
  assert.equal(manifest.dependencies?.nodemailer, '9.0.5');
  assert.equal(manifest.devDependencies?.playwright, undefined);

  await Promise.all([
    access(new URL('../extensions/pi-reads/index.ts', import.meta.url)),
    access(new URL('../skills/pi-reads/SKILL.md', import.meta.url)),
  ]);
});
