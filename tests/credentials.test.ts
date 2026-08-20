import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SystemKindleCredentialStore,
  type CredentialEntry,
  type CredentialEntryFactory,
} from '../src/adapters/credentials/keyring.ts';

class MemoryEntry implements CredentialEntry {
  value: string | undefined;

  async getPassword(): Promise<string | undefined> {
    return this.value;
  }

  async setPassword(password: string): Promise<void> {
    this.value = password;
  }

  async deleteCredential(): Promise<boolean> {
    const existed = this.value !== undefined;
    this.value = undefined;
    return existed;
  }
}

test('system Kindle credential store keeps validated recipient and SMTP profile entries', async () => {
  const entries = new Map<string, MemoryEntry>();
  const createEntry: CredentialEntryFactory = (service, account) => {
    const key = `${service}/${account}`;
    const current = entries.get(key) ?? new MemoryEntry();
    entries.set(key, current);
    return current;
  };
  const store = new SystemKindleCredentialStore(createEntry);
  const credentials = {
    recipient: ['fixture-reader', 'kindle.com'].join('@'),
    smtp: {
      user: ['fixture-sender', 'example.test'].join('@'),
      password: 'fixture-app-password',
      from: ['fixture-sender', 'example.test'].join('@'),
    },
  };

  assert.equal(await store.getRecipient('default'), undefined);
  assert.equal(await store.getSmtp('default'), undefined);
  await store.set('default', credentials);
  assert.equal(await store.getRecipient('default'), credentials.recipient);
  assert.deepEqual(await store.getSmtp('default'), credentials.smtp);
  assert.equal(entries.size, 2);
  assert.ok(entries.has('pi-reads/kindle:default:recipient'));
  assert.ok(entries.has('pi-reads/kindle:default:smtp'));
  assert.equal(await store.delete('default'), true);
  assert.equal(await store.getRecipient('default'), undefined);
  assert.equal(await store.getSmtp('default'), undefined);
  await assert.rejects(
    () => store.getRecipient('../unsafe'),
    /credential store/,
  );
});

test('system Kindle credential store fails closed without exposing corrupt values', async () => {
  const entry = new MemoryEntry();
  entry.value = '{not-valid-json';
  const store = new SystemKindleCredentialStore((_service, account) =>
    account.endsWith(':smtp') ? entry : new MemoryEntry());
  await assert.rejects(
    () => store.getSmtp('default'),
    (error: unknown) => {
      assert.match(String(error), /credentials are invalid/);
      assert.doesNotMatch(String(error), /not-valid-json/);
      return true;
    },
  );
});
