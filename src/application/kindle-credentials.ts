export interface KindleSmtpCredentials {
  user: string;
  password: string;
  from: string;
}

export interface KindleCredentials {
  recipient: string;
  smtp: KindleSmtpCredentials;
}

export interface KindleCredentialStore {
  getRecipient(profile: string, signal?: AbortSignal): Promise<string | undefined>;
  getSmtp(profile: string, signal?: AbortSignal): Promise<KindleSmtpCredentials | undefined>;
  set(profile: string, credentials: KindleCredentials, signal?: AbortSignal): Promise<void>;
  delete(profile: string, signal?: AbortSignal): Promise<boolean>;
}

export function validateCredentialProfile(profile: string): string {
  const normalized = profile.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(normalized)) {
    throw new Error('Kindle credential profile must use lowercase letters, digits, dots, underscores, or hyphens');
  }
  return normalized;
}
