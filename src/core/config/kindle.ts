import type { KindleConfig } from '../domain.ts';
import {
  assertEnvironmentName,
  assertJsonObject,
  assertKnownKeys,
  assertOptionalString,
  definedProperties,
} from './shared.ts';

const KINDLE_KEYS = new Set(['deviceLabel', 'defaultFormat', 'credentialStore', 'credentialProfile', 'recipientEnv', 'smtp']);
const SMTP_KEYS = new Set(['host', 'port', 'secure', 'userEnv', 'passwordEnv', 'fromEnv']);

export interface ResolvedKindleConfig {
  deviceLabel?: string;
  defaultFormat: 'epub' | 'pdf';
  credentialStore: 'system' | 'environment';
  credentialProfile: string;
  recipientEnv: string;
  smtp: {
    host?: string;
    port: number;
    secure: boolean;
    userEnv: string;
    passwordEnv: string;
    fromEnv: string;
  };
}

function parseKindleFormat(value: unknown): 'epub' | 'pdf' | undefined {
  if (value === undefined || value === 'epub' || value === 'pdf') return value;
  throw new Error('kindle.defaultFormat must be epub or pdf');
}

function parseCredentialStore(value: unknown): 'system' | 'environment' | undefined {
  if (value === undefined || value === 'system' || value === 'environment') return value;
  throw new Error('kindle.credentialStore must be system or environment');
}

function parseCredentialProfile(value: unknown): string | undefined {
  assertOptionalString(value, 'kindle.credentialProfile');
  if (value !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) {
    throw new Error('kindle.credentialProfile must use lowercase letters, digits, dots, underscores, or hyphens');
  }
  return value;
}

function parseSmtpHost(value: unknown): string | undefined {
  assertOptionalString(value, 'kindle.smtp.host');
  if (value !== undefined && (/[@/\s]/u.test(value) || value.includes('://'))) {
    throw new Error('kindle.smtp.host must be a hostname, not a URL or email address');
  }
  return value;
}

function parseSmtpPort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) {
    throw new Error('kindle.smtp.port must be an integer from 1 to 65535');
  }
  return value as number;
}

function parseSmtpSecure(value: unknown): boolean | undefined {
  if (value === undefined || typeof value === 'boolean') return value;
  throw new Error('kindle.smtp.secure must be a boolean');
}

export function parseKindleSmtpConfig(value: unknown): KindleConfig['smtp'] {
  if (value === undefined) return undefined;
  assertJsonObject(value, 'kindle.smtp');
  assertKnownKeys(value, SMTP_KEYS, 'kindle.smtp');
  const host = parseSmtpHost(value.host);
  const port = parseSmtpPort(value.port);
  const secure = parseSmtpSecure(value.secure);
  assertEnvironmentName(value.userEnv, 'kindle.smtp.userEnv');
  assertEnvironmentName(value.passwordEnv, 'kindle.smtp.passwordEnv');
  assertEnvironmentName(value.fromEnv, 'kindle.smtp.fromEnv');
  return definedProperties({
    host,
    port,
    secure,
    userEnv: value.userEnv,
    passwordEnv: value.passwordEnv,
    fromEnv: value.fromEnv,
  }) as KindleConfig['smtp'];
}

export function parseKindleConfig(value: unknown): KindleConfig {
  assertJsonObject(value, 'kindle');
  assertKnownKeys(value, KINDLE_KEYS, 'kindle');
  assertOptionalString(value.deviceLabel, 'kindle.deviceLabel');
  if (typeof value.deviceLabel === 'string' && /[\r\n]/u.test(value.deviceLabel)) {
    throw new Error('kindle.deviceLabel must be a single-line string');
  }
  assertEnvironmentName(value.recipientEnv, 'kindle.recipientEnv');
  const defaultFormat = parseKindleFormat(value.defaultFormat);
  const credentialStore = parseCredentialStore(value.credentialStore);
  const credentialProfile = parseCredentialProfile(value.credentialProfile);
  const smtp = parseKindleSmtpConfig(value.smtp);
  return definedProperties({
    deviceLabel: value.deviceLabel,
    defaultFormat,
    credentialStore,
    credentialProfile,
    recipientEnv: value.recipientEnv,
    smtp,
  }) as KindleConfig;
}

export function resolveKindleConfig(config: KindleConfig): ResolvedKindleConfig {
  const {
    deviceLabel,
    defaultFormat = 'epub',
    credentialStore = 'environment',
    credentialProfile = 'default',
    recipientEnv = 'PI_READS_KINDLE_ADDRESS',
    smtp: configuredSmtp = {},
  } = config;
  const {
    host,
    port = 587,
    secure = false,
    userEnv = 'PI_READS_SMTP_USER',
    passwordEnv = 'PI_READS_SMTP_PASSWORD',
    fromEnv = 'PI_READS_SMTP_FROM',
  } = configuredSmtp;
  const smtp = { port, secure, userEnv, passwordEnv, fromEnv, ...definedProperties({ host }) };
  return { defaultFormat, credentialStore, credentialProfile, recipientEnv, smtp, ...definedProperties({ deviceLabel }) };
}
