// R07-B — admin mutation routes: auth gate, X-Requested-With CSRF gate, malformed body -> 400 (never 500).
// Runs the real route handlers against an isolated data dir.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

async function main() {
  // Stores compute their JSON path from process.cwd() at module load — chdir before importing.
  const work = mkdtempSync(join(tmpdir(), 'r07b-mut-'));
  mkdirSync(join(work, 'data'), { recursive: true });
  process.chdir(work);
  process.env.ADMIN_SESSION_SECRET = 'test-secret-'.repeat(3);
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;

  const { createAdminSessionToken, getAdminSessionCookieName } = await import('../lib/admin-auth');
  const { NextRequest } = await import('next/server');
  const vacancies = await import('../app/api/admin/vacancies/route');
  const serviceContent = await import('../app/api/admin/service-content/route');
  const images = await import('../app/api/admin/images/route');

  const cookie = `${getAdminSessionCookieName()}=${createAdminSessionToken()}`;

  type Opts = { auth?: boolean; csrf?: boolean; ct?: string; body?: string };
  function make(url: string, method: string, o: Opts = {}): InstanceType<typeof NextRequest> {
    const headers = new Headers();
    headers.set('content-type', o.ct ?? 'application/json');
    if (o.auth !== false) headers.set('cookie', cookie);
    if (o.csrf !== false) headers.set('x-requested-with', 'titanor-admin');
    return new NextRequest(`http://localhost${url}`, { method, headers, body: o.body });
  }

  const validVacancy = JSON.stringify({
    role: 'Welder', location: 'Turku', duration: 'Project', description: 'Marine welding', postedAt: '2026-08-30'
  });

  // ---- vacancies POST ----
  check('vacancies POST unauth -> 401',
    (await vacancies.POST(make('/api/admin/vacancies', 'POST', { auth: false, body: validVacancy }))).status === 401);
  check('vacancies POST no CSRF header -> 403',
    (await vacancies.POST(make('/api/admin/vacancies', 'POST', { csrf: false, body: validVacancy }))).status === 403);
  check('vacancies POST malformed JSON -> 400 (not 500)',
    (await vacancies.POST(make('/api/admin/vacancies', 'POST', { body: '{not json' }))).status === 400);
  check('vacancies POST missing fields -> 400 (not 500)',
    (await vacancies.POST(make('/api/admin/vacancies', 'POST', { body: '{}' }))).status === 400);
  let createdId = '';
  {
    const r = await vacancies.POST(make('/api/admin/vacancies', 'POST', { body: validVacancy }));
    check('vacancies POST authed + CSRF + valid -> 200', r.status === 200, { status: r.status });
    const list = (await r.json()) as Array<{ id: string; role: string }>;
    createdId = list.find((v) => v.role === 'Welder')?.id ?? '';
    check('vacancies POST persisted the row', createdId !== '');
  }

  // ---- vacancies DELETE ----
  check('vacancies DELETE unauth -> 401',
    (await vacancies.DELETE(make('/api/admin/vacancies', 'DELETE', { auth: false, body: '{"id":"x"}' }))).status === 401);
  check('vacancies DELETE no CSRF header -> 403',
    (await vacancies.DELETE(make('/api/admin/vacancies', 'DELETE', { csrf: false, body: '{"id":"x"}' }))).status === 403);
  check('vacancies DELETE malformed JSON -> 400 (not 500)',
    (await vacancies.DELETE(make('/api/admin/vacancies', 'DELETE', { body: 'nope' }))).status === 400);
  check('vacancies DELETE authed + CSRF + valid -> 200',
    (await vacancies.DELETE(make('/api/admin/vacancies', 'DELETE', { body: JSON.stringify({ id: createdId }) }))).status === 200);

  // ---- service-content PUT ----
  check('service-content PUT unauth -> 401',
    (await serviceContent.PUT(make('/api/admin/service-content', 'PUT', { auth: false, body: '{}' }))).status === 401);
  check('service-content PUT no CSRF header -> 403',
    (await serviceContent.PUT(make('/api/admin/service-content', 'PUT', { csrf: false, body: '{}' }))).status === 403);
  check('service-content PUT malformed JSON -> 400 (not 500)',
    (await serviceContent.PUT(make('/api/admin/service-content', 'PUT', { body: '<<<' }))).status === 400);
  check('service-content PUT authed + CSRF -> 200',
    (await serviceContent.PUT(make('/api/admin/service-content', 'PUT', { body: JSON.stringify({ en: { welding: 'Welding work' } }) }))).status === 200);

  // ---- images POST / DELETE (CSRF + malformed only; upload internals are Slice 5) ----
  check('images POST unauth -> 401',
    (await images.POST(make('/api/admin/images', 'POST', { auth: false }))).status === 401);
  check('images POST no CSRF header -> 403',
    (await images.POST(make('/api/admin/images', 'POST', { csrf: false }))).status === 403);
  check('images POST non-multipart body -> 400 (not 500)',
    (await images.POST(make('/api/admin/images', 'POST', { body: '{}' }))).status === 400);
  check('images DELETE unauth -> 401',
    (await images.DELETE(make('/api/admin/images', 'DELETE', { auth: false, body: '{}' }))).status === 401);
  check('images DELETE no CSRF header -> 403',
    (await images.DELETE(make('/api/admin/images', 'DELETE', { csrf: false, body: '{}' }))).status === 403);
  check('images DELETE malformed JSON -> 400 (not 500)',
    (await images.DELETE(make('/api/admin/images', 'DELETE', { body: 'x' }))).status === 400);
  check('images DELETE missing identifier -> 400 (not 500)',
    (await images.DELETE(make('/api/admin/images', 'DELETE', { body: JSON.stringify({ section: 'welding' }) }))).status === 400);

  console.log(`\nPASS: ${pass}/${pass + fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
