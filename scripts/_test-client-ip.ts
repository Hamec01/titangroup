// R07-B — public-site trusted-proxy client IP (lib/client-ip). Pure.
import { resolveClientIp, clientRateLimitKey, trustedProxyHops, isIpAddress } from '../lib/client-ip';

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

const ENV = process.env.PUBLIC_SITE_TRUSTED_PROXY_HOPS;
function withHops<T>(hops: string | undefined, fn: () => T): T {
  if (hops === undefined) delete process.env.PUBLIC_SITE_TRUSTED_PROXY_HOPS;
  else process.env.PUBLIC_SITE_TRUSTED_PROXY_HOPS = hops;
  try { return fn(); } finally {
    if (ENV === undefined) delete process.env.PUBLIC_SITE_TRUSTED_PROXY_HOPS;
    else process.env.PUBLIC_SITE_TRUSTED_PROXY_HOPS = ENV;
  }
}

check('isIpAddress v4', isIpAddress('203.0.113.7'));
check('isIpAddress v6', isIpAddress('2001:db8::1'));
check('isIpAddress rejects host', !isIpAddress('evil.example.com'));

withHops('1', () => {
  check('hops=1', trustedProxyHops() === 1);
  check('single entry is the client', resolveClientIp(hdr('203.0.113.7')).ip === '203.0.113.7');
  const forged = resolveClientIp(hdr('9.9.9.9, 203.0.113.7'));
  check('forged leading XFF ignored -> rightmost', forged.ip === '203.0.113.7', forged);
  const direct = resolveClientIp(hdr(undefined));
  check('no XFF -> null + chainTooShort', direct.ip === null && direct.chainTooShort === true, direct);
  check('non-IP in trusted slot -> null', resolveClientIp(hdr('9.9.9.9, junk')).ip === null);
  check('clientRateLimitKey fallback "unknown"', clientRateLimitKey(hdr(undefined)) === 'unknown');
  check('clientRateLimitKey uses trusted IP', clientRateLimitKey(hdr('9.9.9.9, 203.0.113.7')) === '203.0.113.7');
});

withHops('2', () => {
  check('hops=2 CF+Caddy', resolveClientIp(hdr('203.0.113.7, 10.0.0.9')).ip === '203.0.113.7');
  check('hops=2 forged pre-CF ignored', resolveClientIp(hdr('9.9.9.9, 203.0.113.7, 10.0.0.9')).ip === '203.0.113.7');
  check('hops=2 too-short chain -> null', resolveClientIp(hdr('203.0.113.7')).chainTooShort === true);
});

check('hops unset -> 1', withHops(undefined, () => trustedProxyHops()) === 1);
check('hops "abc" -> 1', withHops('abc', () => trustedProxyHops()) === 1);
check('hops "2" -> 2', withHops('2', () => trustedProxyHops()) === 2);

console.log(`\nPASS: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
