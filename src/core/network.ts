import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { errorMessage } from './errors.ts';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type ResolveHostname = (hostname: string) => Promise<ResolvedAddress[]>;

export interface PublicHttpUrlOptions {
  label?: string;
  resolveHostname?: ResolveHostname;
  signal?: AbortSignal;
}

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96],
  ['64:ff9b:1::', 48],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['2001::', 32],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}
const publicIpv6 = new BlockList();
publicIpv6.addSubnet('2000::', 3, 'ipv6');

export function isPrivateOrNonRoutableAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, '');
  const family = isIP(normalized);
  if (family === 4) return blockedAddresses.check(normalized, 'ipv4');
  if (family === 6) {
    if (normalized.startsWith('::ffff:')) return true;
    return blockedAddresses.check(normalized, 'ipv6') || !publicIpv6.check(normalized, 'ipv6');
  }
  return true;
}

async function defaultResolveHostname(hostname: string): Promise<ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function assertPublicHttpUrl(url: URL, options: PublicHttpUrlOptions = {}): Promise<void> {
  const label = options.label ?? 'Remote URL';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} uses unsupported protocol ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw new Error(`${label} resolves to a private or non-routable host: ${url.href}`);
  }

  let addresses: ResolvedAddress[];
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      addresses = await withAbort((options.resolveHostname ?? defaultResolveHostname)(hostname), options.signal);
    } catch (error: unknown) {
      throw new Error(`${label} hostname could not be resolved: ${errorMessage(error)}`);
    }
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateOrNonRoutableAddress(entry.address))) {
    throw new Error(`${label} resolves to a private or non-routable address: ${url.href}`);
  }
}
