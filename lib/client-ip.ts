import { isIP } from 'node:net';

// R07-B — trusted-proxy-aware client IP resolution for the public site.
//
// `titanorgroup.fi` is served: browser ──► Caddy (127.0.0.1:3100) ──► this app. `X-Forwarded-For`
// is a left-to-right chain where each proxy APPENDS its view of its immediate downstream peer, so
// with N trusted proxies in front of us the real client is the entry N positions from the right:
// `xff[xff.length - N]`. Every entry further left is attacker-supplied and never trusted.
//
// PUBLIC_SITE_TRUSTED_PROXY_HOPS — integer, default 1 (Caddy only). Raise it if a CDN is ever put
// in front of Caddy for this hostname.

const DEFAULT_HOPS = 1;

export function trustedProxyHops(): number {
  const raw = process.env.PUBLIC_SITE_TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw === '') return DEFAULT_HOPS;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : DEFAULT_HOPS;
}

export function isIpAddress(value: string): boolean {
  const v = value.trim().replace(/^\[|\]$/g, '').replace(/%.+$/, '');
  return isIP(v) !== 0;
}

type HeaderSource = Headers | { headers: Headers } | { get(name: string): string | null };

function getHeader(source: HeaderSource, name: string): string | null {
  if ('headers' in source && source.headers && typeof (source.headers as Headers).get === 'function') {
    return (source.headers as Headers).get(name);
  }
  if (typeof (source as Headers).get === 'function') {
    return (source as Headers).get(name);
  }
  return null;
}

export interface ClientIpResult {
  ip: string | null;
  chainTooShort: boolean;
}

export function resolveClientIp(source: HeaderSource): ClientIpResult {
  const hops = trustedProxyHops();
  const chain = (getHeader(source, 'x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (chain.length < hops) {
    return { ip: null, chainTooShort: true };
  }
  const candidate = chain[chain.length - hops];
  return { ip: isIpAddress(candidate) ? candidate.replace(/^\[|\]$/g, '') : null, chainTooShort: false };
}

/** The resolved client IP, or a fixed `unknown` sub-key. Never returns a client-controlled value. */
export function clientRateLimitKey(source: HeaderSource): string {
  return resolveClientIp(source).ip ?? 'unknown';
}
