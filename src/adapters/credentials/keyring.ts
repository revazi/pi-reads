import { AsyncEntry } from '@napi-rs/keyring';
import {
  validateCredentialProfile,
  type KindleCredentials,
  type KindleCredentialStore,
  type KindleSmtpCredentials,
} from '../../application/kindle-credentials.ts';

const SERVICE_NAME = 'pi-reads';

export interface CredentialEntry {
  getPassword(signal?: AbortSignal): Promise<string | undefined>;
  setPassword(password: string, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}

export type CredentialEntryFactory = (service: string, account: string) => CredentialEntry;

function accountName(profile: string, kind: 'recipient' | 'smtp'): string {
  return `kindle:${validateCredentialProfile(profile)}:${kind}`;
}

function parseSmtpCredentials(value: string): KindleSmtpCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('Stored Kindle SMTP credentials are invalid; run /reads-config to replace them');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored Kindle SMTP credentials are invalid; run /reads-config to replace them');
  }
  const candidate = parsed as Record<string, unknown>;
  const keys = ['user', 'password', 'from'] as const;
  if (keys.some((key) => typeof candidate[key] !== 'string' || !(candidate[key] as string).trim())) {
    throw new Error('Stored Kindle SMTP credentials are incomplete; run /reads-config to replace them');
  }
  return {
    user: candidate.user as string,
    password: candidate.password as string,
    from: candidate.from as string,
  };
}

export class SystemKindleCredentialStore implements KindleCredentialStore {
  private readonly createEntry: CredentialEntryFactory;

  constructor(createEntry: CredentialEntryFactory = (service, account) => new AsyncEntry(service, account)) {
    this.createEntry = createEntry;
  }

  private entry(profile: string, kind: 'recipient' | 'smtp'): CredentialEntry {
    return this.createEntry(SERVICE_NAME, accountName(profile, kind));
  }

  async getRecipient(profile: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    try {
      return await this.entry(profile, 'recipient').getPassword(signal);
    } catch {
      throw new Error('Could not read the Kindle recipient from the system credential store');
    }
  }

  async getSmtp(profile: string, signal?: AbortSignal): Promise<KindleSmtpCredentials | undefined> {
    signal?.throwIfAborted();
    let stored: string | undefined;
    try {
      stored = await this.entry(profile, 'smtp').getPassword(signal);
    } catch {
      throw new Error('Could not read Kindle SMTP credentials from the system credential store');
    }
    return stored === undefined ? undefined : parseSmtpCredentials(stored);
  }

  async set(profile: string, credentials: KindleCredentials, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      await this.entry(profile, 'recipient').setPassword(credentials.recipient, signal);
      await this.entry(profile, 'smtp').setPassword(JSON.stringify(credentials.smtp), signal);
    } catch {
      throw new Error('Could not save Kindle credentials in the system credential store');
    }
  }

  async delete(profile: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const results = await Promise.all(['recipient', 'smtp'].map(async (kind) => {
      try {
        return await this.entry(profile, kind as 'recipient' | 'smtp').deleteCredential(signal);
      } catch {
        return false;
      }
    }));
    return results.some(Boolean);
  }
}
