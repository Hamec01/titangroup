// R07-A — trusted-proxy-aware client IP resolution (lib/client-ip). Pure, no DB.
import { resolveClientIp, clientIp, clientRateLimitKey, trustedProxyHops, isIpAddress } from '../lib/client-ip';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

function hdr(xff?: string): Headers {
  const h = new Headers();
  if (xff !== undefined) h.set('x-forwarded-for', xff);
  return h;
}

const ENV = process.env.TITANOR_TRUSTED_PROXY_HOPS;
function withHops<T>(hops: string | undefined, fn: () => T): T {
  if (hops === undefined) delete process.env.TITANOR_TRUSTED_PROXY_HOPS;
  else process.env.TITANOR_TRUSTED_PROXY_HOPS = hops;
  try {
    return fn();
  } finally {
    if (ENV === undefined) delete process.env.TITANOR_TRUSTED_PROXY_HOPS;
    else process.env.TITANOR_TRUSTED_PROXY_HOPS = ENV;
  }
}

// ---- isIpAddress ----
check('isIpAddress v4', isIpAddress('203.0.113.7'));
check('isIpAddress v6', isIpAddress('2001:db8::1'));
check('isIpAddress v4-mapped v6', isIpAddress('::ffff:203.0.113.7'));
check('isIpAddress rejects host', !isIpAddress('evil.example.com'));
check('isIpAddress rejects junk', !isIpAddress('not-an-ip'));
check('isIpAddress rejects out-of-range octet', !isIpAddress('999.1.1.1'));

// ---- hops = 1 (pilot: browser -> Caddy -> app) ----
withHops('1', () => {
  check('hops=1 parsed', trustedProxyHops() === 1);
  // Caddy appended the real browser IP; that is the ONLY entry.
  check('h1: single entry is the client', resolveClientIp(hdr('203.0.113.7')).ip === '203.0.113.7');
  // Client forged a leading value; Caddy appended the real IP on the right. Must ignore the forgery.
  const forged = resolveClientIp(hdr('9.9.9.9, 203.0.113.7'));
  check('h1: forged leading XFF is ignored', forged.ip === '203.0.113.7', forged);
  check('h1: forged chain not flagged short', forged.chainTooShort === false);
  // A direct hit on the container with no XFF at all — cannot trust anything.
  const direct = resolveClientIp(hdr(undefined));
  check('h1: no XFF -> null + chainTooShort', direct.ip === null && direct.chainTooShort === true, direct);
  check('h1: empty XFF -> null', resolveClientIp(hdr('')).ip === null);
  // The trusted position holds a non-IP -> null, but the chain length was fine.
  const bad = resolveClientIp(hdr('9.9.9.9, garbage'));
  check('h1: non-IP in trusted slot -> null, not short', bad.ip === null && bad.chainTooShort === false, bad);
  check('h1: clientRateLimitKey falls back to "unknown"', clientRateLimitKey(hdr(undefined)) === 'unknown');
  check('h1: clientRateLimitKey uses the IP', clientRateLimitKey(hdr('9.9.9.9, 203.0.113.7')) === '203.0.113.7');
  check('h1: clientIp convenience', clientIp(hdr('9.9.9.9, 203.0.113.7')) === '203.0.113.7');
});

// ---- hops = 2 (production: browser -> Cloudflare -> Caddy -> app) ----
withHops('2', () => {
  check('hops=2 parsed', trustedProxyHops() === 2);
  // Chain is [browser, cf-edge]; the client is 2 from the right = index 0.
  check('h2: CF+Caddy chain', resolveClientIp(hdr('203.0.113.7, 10.0.0.9')).ip === '203.0.113.7');
  // Client forged a value before Cloudflare; still 2 trusted hops from the right.
  const forged = resolveClientIp(hdr('9.9.9.9, 203.0.113.7, 10.0.0.9'));
  check('h2: forged pre-CF value ignored', forged.ip === '203.0.113.7', forged);
  // Someone hits the app directly with only one entry -> chain shorter than 2 trusted hops.
  const short = resolveClientIp(hdr('203.0.113.7'));
  check('h2: too-short chain -> null + flag', short.ip === null && short.chainTooShort === true, short);
});

// ---- env fallbacks ----
check('hops: unset -> 1', withHops(undefined, () => trustedProxyHops()) === 1);
check('hops: "" -> 1', withHops('', () => trustedProxyHops()) === 1);
check('hops: "abc" -> 1', withHops('abc', () => trustedProxyHops()) === 1);
check('hops: "0" -> 1', withHops('0', () => trustedProxyHops()) === 1);
check('hops: "99" -> 1 (out of range)', withHops('99', () => trustedProxyHops()) === 1);
check('hops: "3" -> 3', withHops('3', () => trustedProxyHops()) === 3);

console.log(`\nPASS: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
