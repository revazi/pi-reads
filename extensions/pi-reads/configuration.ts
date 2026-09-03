import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import { updateKindleConfig, updateLibraryDir, updateObsidianConfig } from '../../src/application/config-service.ts';
import type { KindleCredentialStore, KindleSmtpCredentials } from '../../src/application/kindle-credentials.ts';
import { parseConfig } from '../../src/core/config.ts';
import { resolveKindleConfig } from '../../src/core/config/kindle.ts';
import { resolveObsidianConfig } from '../../src/core/config/obsidian.ts';
import type { KindleConfig, ObsidianConfig } from '../../src/core/domain.ts';
import type { ReadsServices } from './runtime.ts';

export interface KindlePreferenceInput {
  deviceLabel: string;
  defaultFormat: string;
  host: string;
  port: string;
  secure: string;
  credentialStore: string;
}

export interface KindleEnvironmentInput {
  recipientEnv: string;
  userEnv: string;
  passwordEnv: string;
  fromEnv: string;
}

export interface KindleCredentialInput {
  recipient: string;
  user: string;
  password: string;
  from: string;
}

export interface ObsidianPreferenceInput {
  vaultPath: string;
  vaultName: string;
  inboxFolder: string;
  attachmentFolder: string;
  noteNameTemplate: string;
  tags: string;
  frontmatter: ObsidianConfig['frontmatter'];
  openAfterExport: string;
}

const COLLECTION_CANCELLED = Symbol('collection-cancelled');

async function collectedInput(value: Promise<string | undefined>): Promise<string> {
  const answer = await value;
  if (answer === undefined) throw COLLECTION_CANCELLED;
  return answer;
}

async function collectedSelection(value: Promise<string | undefined>): Promise<string> {
  const answer = await value;
  if (!answer) throw COLLECTION_CANCELLED;
  return answer;
}

async function requiredCollectedInput(value: Promise<string | undefined>): Promise<string> {
  const answer = await collectedInput(value);
  if (!answer.trim()) throw COLLECTION_CANCELLED;
  return answer;
}

async function collectOrCancel<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error === COLLECTION_CANCELLED) return undefined;
    throw error;
  }
}

async function secretInput(ctx: ExtensionCommandContext, title: string): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    let value = '';
    return {
      render(width: number): string[] {
        const bullets = '•'.repeat([...value].length);
        return [
          truncateToWidth(theme.fg('accent', title), width),
          truncateToWidth(`› ${bullets}${CURSOR_MARKER}${theme.fg('accent', '█')}`, width),
        ];
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.enter)) return done(value);
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) return done(undefined);
        if (matchesKey(data, Key.backspace)) {
          value = [...value].slice(0, -1).join('');
          tui.requestRender();
          return;
        }
        let inserted = data;
        if (inserted.startsWith('\u001b[200~') && inserted.endsWith('\u001b[201~')) inserted = inserted.slice(6, -6);
        else if (inserted.includes('\u001b')) return;
        inserted = inserted.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '');
        if (inserted) {
          value += inserted;
          tui.requestRender();
        }
      },
      invalidate() {},
    };
  });
}

function kindleDefaults(current: KindleConfig | undefined, suppliedHost?: string): KindleConfig {
  const resolved = resolveKindleConfig(current ?? {});
  const host = suppliedHost ?? resolved.smtp.host;
  return {
    ...resolved,
    smtp: { ...resolved.smtp, ...(host ? { host } : {}) },
  };
}

export function normalizeKindlePreferences(
  current: KindleConfig | undefined,
  input: KindlePreferenceInput,
): KindleConfig {
  const defaults = kindleDefaults(current, input.host.trim() || undefined);
  const config: KindleConfig = {
    ...(input.deviceLabel.trim() ? { deviceLabel: input.deviceLabel.trim() } : {}),
    defaultFormat: input.defaultFormat as 'epub' | 'pdf',
    credentialStore: input.credentialStore.startsWith('System') ? 'system' : 'environment',
    credentialProfile: defaults.credentialProfile,
    recipientEnv: defaults.recipientEnv,
    smtp: {
      ...(input.host.trim() ? { host: input.host.trim() } : {}),
      port: Number(input.port),
      secure: input.secure === 'yes',
      userEnv: defaults.smtp?.userEnv,
      passwordEnv: defaults.smtp?.passwordEnv,
      fromEnv: defaults.smtp?.fromEnv,
    },
  };
  return parseConfig({ schemaVersion: 1, kindle: config }).kindle!;
}

export function normalizeKindleEnvironment(
  config: KindleConfig,
  input: KindleEnvironmentInput,
): KindleConfig {
  const normalized: KindleConfig = {
    ...config,
    recipientEnv: input.recipientEnv.trim(),
    smtp: {
      ...config.smtp,
      userEnv: input.userEnv.trim(),
      passwordEnv: input.passwordEnv.trim(),
      fromEnv: input.fromEnv.trim(),
    },
  };
  return parseConfig({ schemaVersion: 1, kindle: normalized }).kindle!;
}

function emailAddress(value: string, name: string, kindleOnly = false): string {
  const normalized = value.trim();
  const pattern = kindleOnly ? /^[^\s@]+@kindle\.com$/iu : /^[^\s@]+@[^\s@]+$/u;
  if (/[\r\n]/u.test(normalized) || !pattern.test(normalized)) {
    throw new Error(`${name} must be a valid ${kindleOnly ? 'kindle.com ' : ''}email address`);
  }
  return normalized;
}

export function normalizeKindleCredentials(input: KindleCredentialInput): {
  recipient: string;
  smtp: KindleSmtpCredentials;
} {
  if (!input.password.trim()) throw new Error('SMTP password is required');
  return {
    recipient: emailAddress(input.recipient, 'Send-to-Kindle address', true),
    smtp: {
      user: emailAddress(input.user, 'SMTP username'),
      password: input.password.trim(),
      from: emailAddress(input.from, 'SMTP From address'),
    },
  };
}

export function normalizeObsidianPreferences(input: ObsidianPreferenceInput): ObsidianConfig {
  const config: ObsidianConfig = {
    vaultPath: input.vaultPath.trim(),
    vaultName: input.vaultName.trim(),
    inboxFolder: input.inboxFolder.trim(),
    attachmentFolder: input.attachmentFolder.trim(),
    noteNameTemplate: input.noteNameTemplate.trim(),
    tags: input.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    frontmatter: input.frontmatter ?? {},
    openAfterExport: input.openAfterExport === 'yes',
  };
  return parseConfig({ schemaVersion: 1, obsidian: config }).obsidian!;
}

export async function collectKindlePreferences(
  ctx: ExtensionCommandContext,
  defaults: KindleConfig,
): Promise<KindlePreferenceInput | undefined> {
  return collectOrCancel(async () => {
    const deviceLabel = await collectedInput(ctx.ui.input('Kindle device label (optional)', defaults.deviceLabel ?? ''));
    const formats = defaults.defaultFormat === 'pdf' ? ['pdf', 'epub'] : ['epub', 'pdf'];
    const defaultFormat = await collectedSelection(ctx.ui.select('Default Kindle format', formats));
    const host = await collectedInput(ctx.ui.input('SMTP host', defaults.smtp?.host ?? 'smtp.mail.me.com'));
    const port = await collectedInput(ctx.ui.input('SMTP port', String(defaults.smtp?.port ?? 587)));
    const secure = await collectedSelection(ctx.ui.select(
      'Use implicit SMTP TLS?',
      defaults.smtp?.secure ? ['yes', 'no'] : ['no', 'yes'],
    ));
    const credentialStore = await collectedSelection(ctx.ui.select('Kindle credentials', [
      'System credential store — configure once (recommended)',
      'Environment variables — advanced/CI',
    ]));
    return { deviceLabel, defaultFormat, host, port, secure, credentialStore };
  });
}

async function collectKindleEnvironment(
  ctx: ExtensionCommandContext,
  config: KindleConfig,
): Promise<KindleEnvironmentInput | undefined> {
  return collectOrCancel(async () => ({
    recipientEnv: await collectedInput(ctx.ui.input('Kindle recipient environment variable', config.recipientEnv)),
    userEnv: await collectedInput(ctx.ui.input('SMTP username environment variable', config.smtp?.userEnv)),
    passwordEnv: await collectedInput(ctx.ui.input('SMTP password environment variable', config.smtp?.passwordEnv)),
    fromEnv: await collectedInput(ctx.ui.input('Approved sender environment variable', config.smtp?.fromEnv)),
  }));
}

async function collectKindleCredentials(ctx: ExtensionCommandContext): Promise<KindleCredentialInput | undefined> {
  return collectOrCancel(async () => {
    const recipient = await requiredCollectedInput(ctx.ui.input('Send-to-Kindle address', ''));
    const user = await requiredCollectedInput(ctx.ui.input('SMTP username / approved sender', ''));
    const password = await requiredCollectedInput(secretInput(ctx, 'SMTP app-specific password'));
    const from = await requiredCollectedInput(ctx.ui.input('SMTP From address', user.trim()));
    return { recipient, user, password, from };
  });
}

export async function persistKindleConfiguration(
  configPath: string,
  config: KindleConfig,
  credentialStore: KindleCredentialStore,
  credentials?: ReturnType<typeof normalizeKindleCredentials>,
): Promise<void> {
  if (credentials) await credentialStore.set(config.credentialProfile ?? 'default', credentials);
  await updateKindleConfig(configPath, config);
}

function notifyKindleConfiguration(ctx: ExtensionCommandContext, configPath: string, config: KindleConfig): void {
  if (config.credentialStore === 'system') {
    ctx.ui.notify(
      `Kindle preferences saved. Addresses and SMTP credentials are protected by the system credential store and load automatically.\nConfig: ${configPath}`,
      'info',
    );
    return;
  }
  const envNames = [
    config.recipientEnv,
    config.smtp?.userEnv,
    config.smtp?.passwordEnv,
    config.smtp?.fromEnv,
    ...(config.smtp?.host ? [] : ['PI_READS_SMTP_HOST']),
  ].filter((name): name is string => Boolean(name));
  ctx.ui.notify(`Kindle preferences saved.\nRequired environment variables: ${envNames.join(', ')}\nConfig: ${configPath}`, 'info');
}

async function configureKindle(
  configPath: string,
  current: KindleConfig | undefined,
  credentialStore: KindleCredentialStore,
  ctx: ExtensionCommandContext,
  suppliedHost?: string,
): Promise<void> {
  let config = kindleDefaults(current, suppliedHost);
  let credentials: ReturnType<typeof normalizeKindleCredentials> | undefined;
  if (ctx.hasUI && !suppliedHost) {
    const preferences = await collectKindlePreferences(ctx, config);
    if (!preferences) return;
    config = normalizeKindlePreferences(current, preferences);
    if (config.credentialStore === 'system') {
      const input = await collectKindleCredentials(ctx);
      if (!input) return;
      credentials = normalizeKindleCredentials(input);
    } else {
      const input = await collectKindleEnvironment(ctx, config);
      if (!input) return;
      config = normalizeKindleEnvironment(config, input);
    }
  }
  await persistKindleConfiguration(configPath, config, credentialStore, credentials);
  notifyKindleConfiguration(ctx, configPath, config);
}

function obsidianDefaults(current: ObsidianConfig | undefined, vaultPath: string): ObsidianConfig {
  return resolveObsidianConfig(current ?? { vaultPath }, vaultPath);
}

export async function collectObsidianPreferences(
  ctx: ExtensionCommandContext,
  defaults: ObsidianConfig,
): Promise<ObsidianPreferenceInput | undefined> {
  return collectOrCancel(async () => ({
    vaultPath: defaults.vaultPath,
    vaultName: await collectedInput(ctx.ui.input('Obsidian vault name', defaults.vaultName)),
    inboxFolder: await collectedInput(ctx.ui.input('Reading inbox folder', defaults.inboxFolder)),
    attachmentFolder: await collectedInput(ctx.ui.input('Attachment folder', defaults.attachmentFolder)),
    noteNameTemplate: await collectedInput(ctx.ui.input('Note name template', defaults.noteNameTemplate)),
    tags: await collectedInput(ctx.ui.input('Tags (comma-separated)', defaults.tags?.join(', ') ?? '')),
    frontmatter: defaults.frontmatter,
    openAfterExport: await collectedSelection(ctx.ui.select('Open note after export?', ['no', 'yes'])),
  }));
}

export async function persistObsidianConfiguration(configPath: string, config: ObsidianConfig): Promise<void> {
  await updateObsidianConfig(configPath, config);
}

function obsidianInputFromDefaults(defaults: ObsidianConfig): ObsidianPreferenceInput {
  return {
    vaultPath: defaults.vaultPath,
    vaultName: defaults.vaultName ?? '',
    inboxFolder: defaults.inboxFolder ?? '',
    attachmentFolder: defaults.attachmentFolder ?? '',
    noteNameTemplate: defaults.noteNameTemplate ?? '',
    tags: defaults.tags?.join(', ') ?? '',
    frontmatter: defaults.frontmatter,
    openAfterExport: defaults.openAfterExport ? 'yes' : 'no',
  };
}

async function resolveObsidianInput(
  current: ObsidianConfig | undefined,
  ctx: ExtensionCommandContext,
  suppliedVaultPath?: string,
): Promise<ObsidianPreferenceInput | undefined> {
  const vaultPath = suppliedVaultPath ?? await ctx.ui.input('Obsidian vault path', current?.vaultPath ?? '');
  if (!vaultPath?.trim()) return undefined;
  const defaults = obsidianDefaults(current, vaultPath.trim());
  return ctx.hasUI && !suppliedVaultPath
    ? collectObsidianPreferences(ctx, defaults)
    : obsidianInputFromDefaults(defaults);
}

async function configureObsidian(
  configPath: string,
  current: ObsidianConfig | undefined,
  ctx: ExtensionCommandContext,
  suppliedVaultPath?: string,
): Promise<void> {
  const input = await resolveObsidianInput(current, ctx, suppliedVaultPath);
  if (!input) {
    ctx.ui.notify('Obsidian configuration was not changed', 'warning');
    return;
  }
  const config = normalizeObsidianPreferences(input);
  await persistObsidianConfiguration(configPath, config);
  ctx.ui.notify(`Obsidian vault: ${config.vaultPath}\nConfig: ${configPath}`, 'info');
}

async function configureLibraryPath(
  value: string,
  services: ReadsServices,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const usesKeyword = /^library(?:\s|$)/iu.test(value);
  const explicitPath = usesKeyword ? value.replace(/^library\s*/iu, '').trim() : value;
  if (usesKeyword && !explicitPath) {
    ctx.ui.notify('Usage: /reads-config library <path>', 'error');
    return;
  }
  if (explicitPath) {
    await updateLibraryDir(services.configPath, explicitPath);
    ctx.ui.notify(`Pi Reads library: ${explicitPath}\nConfig: ${services.configPath}`, 'info');
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify('Usage: /reads-config library <path>, /reads-config obsidian <vault-path>, or /reads-config kindle <smtp-host>', 'error');
    return;
  }
  const libraryDir = await ctx.ui.input('Pi Reads library directory', services.libraryDir);
  if (!libraryDir?.trim()) {
    ctx.ui.notify('Library directory was not changed', 'warning');
    return;
  }
  await updateLibraryDir(services.configPath, libraryDir.trim());
  ctx.ui.notify(`Pi Reads library: ${libraryDir.trim()}\nConfig: ${services.configPath}`, 'info');
}

async function configureInteractiveTarget(
  services: ReadsServices,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const target = await ctx.ui.select('Configure Pi Reads', [
    'Library directory', 'Obsidian destination', 'Kindle delivery',
  ]);
  if (target === 'Kindle delivery') {
    await configureKindle(
      services.configPath,
      services.kindleConfig,
      await services.getKindleCredentialStore(),
      ctx,
    );
    return;
  }
  if (target === 'Obsidian destination') {
    await configureObsidian(services.configPath, services.obsidianConfig, ctx);
    return;
  }
  if (target === 'Library directory') await configureLibraryPath('', services, ctx);
}

export async function executeReadsConfiguration(
  args: string,
  services: ReadsServices,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const value = args.trim();
  if (/^kindle(?:\s|$)/iu.test(value)) {
    const host = value.replace(/^kindle\s*/iu, '').trim();
    if (!host && !ctx.hasUI) {
      ctx.ui.notify('Usage: /reads-config kindle <smtp-host>', 'error');
      return;
    }
    await configureKindle(
      services.configPath,
      services.kindleConfig,
      await services.getKindleCredentialStore(),
      ctx,
      host || undefined,
    );
    return;
  }
  if (/^obsidian(?:\s|$)/iu.test(value)) {
    const vaultPath = value.replace(/^obsidian\s*/iu, '').trim();
    if (!vaultPath) {
      ctx.ui.notify('Usage: /reads-config obsidian <vault-path>', 'error');
      return;
    }
    await configureObsidian(services.configPath, services.obsidianConfig, ctx, vaultPath);
    return;
  }
  if (!value && ctx.hasUI) return configureInteractiveTarget(services, ctx);
  return configureLibraryPath(value, services, ctx);
}
