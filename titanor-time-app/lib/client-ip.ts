import { isIP } from 'node:net';

// R07-A — trusted-proxy-aware client IP resolution.
//
// Topology:
//   pilot        browser ──► Caddy (127.0.0.1) ──► app        (1 trusted hop)
//   production   browser ──► Cloudflare ──► Caddy ──► app      (2 trusted hops, from R11)
//
// `X-Forwarded-For` is a left-to-right chain — `[origin client, proxy1, proxy2, …]` — where each
// proxy APPENDS its view of its immediate downstream peer. With N trusted proxies in front of us,
// the real client address is the entry N positions from the right: `xff[xff.length - N]`. Every
// entry further left is attacker-supplied (a client can send any `X-Forwarded-For`) and is never
// trusted. We deliberately do NOT read `CF-Connecting-IP` / `X-Real-IP` — at R11 Caddy is
// configured with `trusted_proxies_strict` + the official Cloudflare CIDRs so the `X-Forwarded-For`
// chain it produces is already correct; this module only needs the hop count.
//
// TITANOR_TRUSTED_PROXY_HOPS — integer, default 1 (pilot). Set to 2 for the Cloudflare+Caddy
// production chain. No live-Caddy change is required to flip it.

const DEFAULT_HOPS = 1;

export function trustedProxyHops(): number {
  const raw = process.env.TITANOR_TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw === '') return DEFAULT_HOPS;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : DEFAULT_HOPS;
}

export function isIpAddress(value: string): boolean {
  const v = value.trim().replace(/^\[|\]$/g, '').replace(/%.+$/, ''); // strip [brackets] and zone id
  return isIP(v) !== 0;
}

export interface ClientIpResult {
  /** The resolved client address, or null when it cannot be trusted / determined. */
  ip: string | null;
  /** true when the X-Forwarded-For chain was shorter than TITANOR_TRUSTED_PROXY_HOPS — i.e. the
   *  request did not arrive through the expected proxy chain (a direct hit, or misconfiguration). */
  chainTooShort: boolean;
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

/** The resolved client IP or null — drop-in for the per-route `clientIp()` helpers this replaces. */
export function clientIp(source: HeaderSource): string | null {
  return resolveClientIp(source).ip;
}

/** A stable rate-limit sub-key for the client. Uses the trusted IP when known; otherwise a fixed
 *  `unknown` bucket (this path is unreachable behind a correctly configured Caddy — every request
 *  into the container carries an X-Forwarded-For). Never returns a client-controlled value. */
export function clientRateLimitKey(source: HeaderSource): string {
  return resolveClientIp(source).ip ?? 'unknown';
}
