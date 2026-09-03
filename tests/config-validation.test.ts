import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import {
  collectKindlePreferences,
  collectObsidianPreferences,
  normalizeKindleCredentials,
  normalizeKindleEnvironment,
  normalizeKindlePreferences,
  normalizeObsidianPreferences,
  persistKindleConfiguration,
  persistObsidianConfiguration,
} from '../extensions/pi-reads/configuration.ts';
import { parseKindleConfig, parseKindleSmtpConfig, resolveKindleConfig } from '../src/core/config/kindle.ts';
import { parseObsidianConfig, resolveObsidianConfig } from '../src/core/config/obsidian.ts';
import type { KindleCredentialStore } from '../src/application/kindle-credentials.ts';

const validKindle = {
  deviceLabel: 'Paperwhite',
  defaultFormat: 'epub',
  credentialStore: 'environment',
  credentialProfile: 'personal',
  recipientEnv: 'MY_KINDLE',
  smtp: {
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    userEnv: 'MY_USER',
    passwordEnv: 'MY_PASSWORD',
    fromEnv: 'MY_FROM',
  },
};

test('Kindle destination validators accept focused valid fixtures and apply defaults', () => {
  assert.deepEqual(parseKindleConfig(validKindle), validKindle);
  assert.deepEqual(parseKindleSmtpConfig(validKindle.smtp), validKindle.smtp);
  assert.deepEqual(resolveKindleConfig({}), {
    defaultFormat: 'epub',
    credentialStore: 'environment',
    credentialProfile: 'default',
    recipientEnv: 'PI_READS_KINDLE_ADDRESS',
    smtp: {
      port: 587,
      secure: false,
      userEnv: 'PI_READS_SMTP_USER',
      passwordEnv: 'PI_READS_SMTP_PASSWORD',
      fromEnv: 'PI_READS_SMTP_FROM',
    },
  });
});

test('Kindle destination validators reject malformed fields independently', () => {
  const invalid: Array<[unknown, RegExp]> = [
    [null, /must be a JSON object/u],
    [{ unknown: true }, /unsupported property unknown/u],
    [{ deviceLabel: 'bad\nlabel' }, /single-line/u],
    [{ defaultFormat: 'mobi' }, /epub or pdf/u],
    [{ credentialStore: 'plaintext' }, /system or environment/u],
    [{ credentialProfile: '../unsafe' }, /lowercase letters/u],
    [{ recipientEnv: 'not-valid' }, /uppercase environment variable/u],
    [{ smtp: { host: 'https://smtp.example.test' } }, /hostname/u],
    [{ smtp: { port: 0 } }, /1 to 65535/u],
    [{ smtp: { secure: 'yes' } }, /must be a boolean/u],
    [{ smtp: { passwordEnv: 'bad-name' } }, /uppercase environment variable/u],
  ];
  for (const [fixture, expected] of invalid) {
    assert.throws(() => parseKindleConfig(fixture), expected);
  }
});

test('Obsidian destination validators cover paths, templates, tags, and frontmatter', () => {
  const parsed = parseObsidianConfig({
    vaultPath: '../vault',
    inboxFolder: 'Reading/Inbox',
    attachmentFolder: 'Assets',
    noteNameTemplate: '{{title}} - {{mode}}',
    tags: ['pi-reads', 'review'],
    frontmatter: { status: 'unread', rating: 5, topics: ['python'] },
    openAfterExport: true,
  });
  assert.equal(resolveObsidianConfig(parsed, '/tmp/vault').vaultName, 'vault');
  assert.deepEqual(parsed.frontmatter, { status: 'unread', rating: 5, topics: ['python'] });

  const invalid: Array<[unknown, RegExp]> = [
    [{}, /vaultPath/u],
    [{ vaultPath: '/vault', inboxFolder: '../outside' }, /unsafe path segment/u],
    [{ vaultPath: '/vault', attachmentFolder: '/absolute' }, /vault-relative/u],
    [{ vaultPath: '/vault', noteNameTemplate: '{{unknown}}' }, /unsupported variable/u],
    [{ vaultPath: '/vault', noteNameTemplate: '{{title}' }, /malformed/u],
    [{ vaultPath: '/vault', tags: ['same', 'same'] }, /duplicates/u],
    [{ vaultPath: '/vault', frontmatter: { title: 'replace' } }, /reserved property/u],
    [{ vaultPath: '/vault', openAfterExport: 'yes' }, /must be a boolean/u],
  ];
  for (const [fixture, expected] of invalid) {
    assert.throws(() => parseObsidianConfig(fixture), expected);
  }
});

test('TUI collectors return raw destination answers without normalization or persistence', async () => {
  const kindleInputs = [' Reader ', ' smtp.example.test ', '465'];
  const kindleSelections = ['pdf', 'yes', 'Environment variables — advanced/CI'];
  const kindleContext = {
    ui: {
      async input() { return kindleInputs.shift(); },
      async select() { return kindleSelections.shift(); },
    },
  } as unknown as ExtensionCommandContext;
  const kindle = await collectKindlePreferences(kindleContext, {});
  assert.equal(kindle?.deviceLabel, ' Reader ');
  assert.equal(kindle?.port, '465');

  const obsidianInputs = ['Vault', 'Reading', 'Assets', '{{title}}', 'pi-reads, interview'];
  const obsidianContext = {
    ui: {
      async input() { return obsidianInputs.shift(); },
      async select() { return 'no'; },
    },
  } as unknown as ExtensionCommandContext;
  const obsidian = await collectObsidianPreferences(obsidianContext, {
    vaultPath: '/tmp/vault',
    frontmatter: { status: 'unread' },
  });
  assert.equal(obsidian?.tags, 'pi-reads, interview');
  assert.deepEqual(obsidian?.frontmatter, { status: 'unread' });
});

test('TUI answer normalization is pure and persistence is destination-specific', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-config-handlers-'));
  const configPath = path.join(root, 'pi-reads.json');
  const stored: unknown[] = [];
  const credentialStore: KindleCredentialStore = {
    async getRecipient() { return undefined; },
    async getSmtp() { return undefined; },
    async set(profile, value) { stored.push({ profile, value }); },
    async delete() { return true; },
  };
  try {
    let kindle = normalizeKindlePreferences(undefined, {
      deviceLabel: ' Interview Reader ',
      defaultFormat: 'pdf',
      host: ' smtp.example.test ',
      port: '465',
      secure: 'yes',
      credentialStore: 'Environment variables — advanced/CI',
    });
    kindle = normalizeKindleEnvironment(kindle, {
      recipientEnv: ' TEST_KINDLE ',
      userEnv: ' TEST_USER ',
      passwordEnv: ' TEST_PASSWORD ',
      fromEnv: ' TEST_FROM ',
    });
    assert.equal(kindle.deviceLabel, 'Interview Reader');
    assert.equal(kindle.smtp?.port, 465);
    assert.equal(kindle.recipientEnv, 'TEST_KINDLE');
    await assert.rejects(() => readFile(configPath), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
    await persistKindleConfiguration(configPath, kindle, credentialStore);

    const credentials = normalizeKindleCredentials({
      recipient: 'reader@kindle.com',
      user: 'sender@example.test',
      password: 'test-only-password',
      from: 'sender@example.test',
    });
    await persistKindleConfiguration(configPath, { ...kindle, credentialStore: 'system' }, credentialStore, credentials);
    assert.equal(stored.length, 1);

    const obsidian = normalizeObsidianPreferences({
      vaultPath: '/tmp/vault',
      vaultName: 'Fixture',
      inboxFolder: 'Reading Inbox',
      attachmentFolder: 'Assets',
      noteNameTemplate: '{{title}}',
      tags: 'pi-reads, interview',
      frontmatter: { status: 'unread' },
      openAfterExport: 'no',
    });
    await persistObsidianConfiguration(configPath, obsidian);
    const persisted = JSON.parse(await readFile(configPath, 'utf8')) as {
      kindle: { credentialStore: string };
      obsidian: { tags: string[]; frontmatter: { status: string } };
    };
    assert.equal(persisted.kindle.credentialStore, 'system');
    assert.deepEqual(persisted.obsidian.tags, ['pi-reads', 'interview']);
    assert.equal(persisted.obsidian.frontmatter.status, 'unread');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
