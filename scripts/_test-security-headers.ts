// R07-B — the security header contract and robots policy. Asserts the next.config surface so a
// later edit cannot quietly drop a header; the live headers are re-checked over HTTP by the
// deploy script.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import robots from '../app/robots';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

async function main() {
  // @ts-expect-error — next.config.mjs ships no type declaration; shape is asserted below.
  const mod = (await import('../next.config.mjs')) as { default: Record<string, unknown> };
  const cfg = mod.default;

  check('poweredByHeader is disabled', cfg.poweredByHeader === false);
  check('output is standalone for a non-Vercel build', cfg.output === 'standalone');

  const rules = await (cfg.headers as () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>)();
  const all = rules.find((r) => r.source === '/:path*');
  check('a /:path* rule applies to every route', Boolean(all));

  const map = new Map((all?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]));
  check('X-Content-Type-Options: nosniff', map.get('x-content-type-options') === 'nosniff');
  check('X-Frame-Options set', (map.get('x-frame-options') ?? '') === 'SAMEORIGIN');
  check('Referrer-Policy set', map.get('referrer-policy') === 'strict-origin-when-cross-origin');
  check('Cross-Origin-Opener-Policy: same-origin', map.get('cross-origin-opener-policy') === 'same-origin');
  check('Permissions-Policy locks down geolocation', /geolocation=\(\)/.test(map.get('permissions-policy') ?? ''));
  check('Permissions-Policy locks down camera', /camera=\(\)/.test(map.get('permissions-policy') ?? ''));
  check('HSTS present with a 2y max-age', /max-age=63072000/.test(map.get('strict-transport-security') ?? ''));
  check('no X-Robots-Tag (the marketing site stays indexable)', !map.has('x-robots-tag'));

  const r = robots();
  const disallow = Array.isArray(r.rules) ? [] : ([] as string[]).concat((r.rules?.disallow as string[] | string) ?? []);
  check('robots keeps the admin portal out of the index', disallow.includes('/ship-admin-portal'));
  check('robots disallows /api/', disallow.includes('/api/'));
  check('robots disallows /uploads/', disallow.includes('/uploads/'));
  check('robots still allows the site root', (Array.isArray(r.rules) ? undefined : r.rules?.allow) === '/');

  // A static public/ file shadows the dynamic route and would silently revert the policy above.
  const publicDir = join(process.cwd(), 'public');
  check('no static public/robots.txt shadowing app/robots.ts', !existsSync(join(publicDir, 'robots.txt')));
  check('no static public/sitemap.xml shadowing app/sitemap.ts', !existsSync(join(publicDir, 'sitemap.xml')));

  console.log(`\nPASS: ${pass}/${pass + fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
