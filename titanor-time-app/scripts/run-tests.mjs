#!/usr/bin/env node
// R02 test runner. Groups scripts/_test-*.ts by lane (see scripts/test-manifest.json) and gives
// every db/scheduler test its own fresh database cloned from a migrated template, so tests never
// see each other's rows and a lane is reproducible on a clean environment.
//
//   node scripts/run-tests.mjs unit                 # no DB, no server
//   node scripts/run-tests.mjs db                   # db + scheduler lanes  (needs TT_TEST_DB_URL)
//   node scripts/run-tests.mjs scheduler            # scheduler lane only   (needs TT_TEST_DB_URL)
//   node scripts/run-tests.mjs browser              # needs TEST_BASE_URL, else all SKIPPED
//   node scripts/run-tests.mjs unit db              # several lanes
//   node scripts/run-tests.mjs all                  # unit + db + scheduler (NOT browser/manual)
//   node scripts/run-tests.mjs --list               # print the catalog
//   node scripts/run-tests.mjs --check              # manifest <-> filesystem drift check (CI gate)
//
// TT_TEST_DB_URL   postgresql://user:pass@host:port/anydb — a throwaway PostgreSQL 16 server.
//                  The runner connects to its `postgres` maintenance DB and CREATE/DROPs its own
//                  per-test databases. It REFUSES a URL that looks like pilot or production.
// TT_TEST_TIMEOUT_MS   per-test timeout, default 240000.
// TT_TEST_KEEP_DBS     if set, leaves the per-run databases in place for debugging.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, '..');
const SCHEMA = join(APP_ROOT, '..', 'prisma', 'schema.prisma');
const PRISMA_BIN = join(APP_ROOT, 'node_modules', '.bin', 'prisma');
const TSX_BIN = join(APP_ROOT, 'node_modules', '.bin', 'tsx');
const MANIFEST = JSON.parse(readFileSync(join(HERE, 'test-manifest.json'), 'utf8'));
const TIMEOUT_MS = Number(process.env.TT_TEST_TIMEOUT_MS || 240_000);

const RUN_LANE = { unit: ['unit'], scheduler: ['scheduler'], db: ['db', 'scheduler'], browser: ['browser'], all: ['unit', 'db', 'scheduler'] };

function die(msg) {
  console.error(`\n  run-tests: ${msg}\n`);
  process.exit(2);
}

// ---- manifest <-> filesystem drift ---------------------------------------------------------------
function onDisk() {
  return readdirSync(HERE).filter((f) => f.startsWith('_test-') && f.endsWith('.ts')).sort();
}
function checkManifest() {
  const disk = new Set(onDisk());
  const listed = new Set(MANIFEST.tests.map((t) => t.file));
  const missing = [...disk].filter((f) => !listed.has(f));
  const stale = [...listed].filter((f) => !disk.has(f));
  const badLane = MANIFEST.tests.filter((t) => !['unit', 'db', 'scheduler', 'browser', 'manual', 'helper'].includes(t.lane));
  let ok = true;
  if (missing.length) { ok = false; console.error(`  test files missing from test-manifest.json:\n    ${missing.join('\n    ')}`); }
  if (stale.length) { ok = false; console.error(`  test-manifest.json lists files that no longer exist:\n    ${stale.join('\n    ')}`); }
  if (badLane.length) { ok = false; console.error(`  bad lane values:\n    ${badLane.map((t) => `${t.file}: ${t.lane}`).join('\n    ')}`); }
  if (ok) console.log(`  test-manifest.json: OK — ${MANIFEST.tests.length} entries, all ${disk.size} test files accounted for.`);
  process.exit(ok ? 0 : 1);
}

function printList() {
  for (const lane of ['unit', 'db', 'scheduler', 'browser', 'manual', 'helper']) {
    const rows = MANIFEST.tests.filter((t) => t.lane === lane);
    if (!rows.length) continue;
    console.log(`\n${lane}  (${rows.length})`);
    for (const r of rows) console.log(`  ${r.file}${r.note ? `  — ${r.note}` : ''}`);
  }
  console.log('');
  process.exit(0);
}

// ---- db plumbing --------------------------------------------------------------------------------
function parseDbUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { die(`TT_TEST_DB_URL is not a valid URL`); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) die(`TT_TEST_DB_URL must be a postg:// URL`);
  const safe = `${u.hostname}:${u.port || 5432}${u.pathname}`;
  const blob = `${u.hostname} ${u.port} ${u.pathname}`.toLowerCase();
  if (/pilot|prod|t97|titanor-time-db/.test(blob) || u.port === '55497') {
    die(`TT_TEST_DB_URL (${safe}) looks like a pilot/production database — refusing. Point it at a throwaway PostgreSQL 16 server.`);
  }
  const maint = new URL(raw);
  maint.pathname = '/postgres';
  return { safe, serverNoDb: (db) => { const x = new URL(raw); x.pathname = `/${db}`; return x.toString(); }, maintUrl: maint.toString() };
}
function sql(maintUrl, statement) {
  const r = spawnSync(PRISMA_BIN, ['db', 'execute', '--url', maintUrl, '--stdin'], { input: statement, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`SQL failed (${statement.split(' ').slice(0, 3).join(' ')}…): ${(r.stderr || r.stdout || '').trim()}`);
}
function dropDb(maintUrl, name) {
  try { sql(maintUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } catch (e) { console.error(`  warn: could not drop ${name}: ${e.message}`); }
}

// ---- running one test -------------------------------------------------------------------------
function runTest(file, extraEnv) {
  const started = Date.now();
  const r = spawnSync(TSX_BIN, [join(HERE, file)], {
    cwd: APP_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ms = Date.now() - started;
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  const pass = !timedOut && r.status === 0;
  return { pass, ms, timedOut, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

// ---- lanes -----------------------------------------------------------------------------------
async function runDbLanes(lanes) {
  const raw = process.env.TT_TEST_DB_URL;
  if (!raw) die(`the ${lanes.join('/')} lane needs a database.\n           Set TT_TEST_DB_URL to a throwaway PostgreSQL 16 server, e.g.\n             docker run -d --name tt-testdb -e POSTGRES_PASSWORD=dev -p 127.0.0.1:55440:5432 postgres:16\n             export TT_TEST_DB_URL=postgresql://postgres:dev@127.0.0.1:55440/postgres`);
  const { safe, serverNoDb, maintUrl } = parseDbUrl(raw);
  const runId = Date.now().toString(36) + randomBytes(2).toString('hex');
  const tmpl = `tt_tmpl_${runId}`;
  const keys = {};
  for (const k of ['IDEMPOTENCY_ENCRYPTION_KEY', 'ACTIVATION_TOKEN_HMAC_KEY', 'PERSONAL_DATA_ENCRYPTION_KEY', 'PASSWORD_RESET_TOKEN_HMAC_KEY']) {
    keys[k] = process.env[k] || randomBytes(32).toString('base64');
  }
  const created = [];
  const cleanup = () => {
    if (process.env.TT_TEST_KEEP_DBS) { console.log(`\n  TT_TEST_KEEP_DBS set — leaving ${tmpl} and ${created.length} run DBs`); return; }
    for (const d of created) dropDb(maintUrl, d);
    dropDb(maintUrl, tmpl);
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  console.log(`  target server: ${safe}   template: ${tmpl}`);
  sql(maintUrl, `CREATE DATABASE "${tmpl}"`);
  const dep = spawnSync(PRISMA_BIN, ['migrate', 'deploy', '--schema', SCHEMA], {
    cwd: APP_ROOT, env: { ...process.env, DATABASE_URL: serverNoDb(tmpl) }, encoding: 'utf8',
  });
  if (dep.status !== 0) { console.error(dep.stdout, dep.stderr); die(`prisma migrate deploy failed against the template DB`); }
  console.log(`  template migrated — every test below gets its own clone\n`);

  const tests = MANIFEST.tests.filter((t) => lanes.includes(t.lane));
  const results = [];
  let i = 0;
  for (const t of tests) {
    const db = `tt_t_${runId}_${i++}`;
    let res;
    try {
      sql(maintUrl, `CREATE DATABASE "${db}" TEMPLATE "${tmpl}"`);
      created.push(db);
      res = runTest(t.file, { DATABASE_URL: serverNoDb(db), ...keys });
    } catch (e) {
      res = { pass: false, ms: 0, timedOut: false, out: e.message };
    } finally {
      if (!process.env.TT_TEST_KEEP_DBS) { dropDb(maintUrl, db); created.pop(); }
    }
    results.push({ ...t, ...res });
    const tag = res.pass ? 'PASS' : res.timedOut ? 'TIMEOUT' : 'FAIL';
    console.log(`  ${tag.padEnd(7)} ${t.file.padEnd(48)} ${(res.ms / 1000).toFixed(1)}s`);
    if (!res.pass) console.log(indent(res.out));
  }
  return results;
}

function runUnitLane() {
  const tests = MANIFEST.tests.filter((t) => t.lane === 'unit');
  const results = [];
  for (const t of tests) {
    const res = runTest(t.file, {});
    results.push({ ...t, ...res });
    const tag = res.pass ? 'PASS' : res.timedOut ? 'TIMEOUT' : 'FAIL';
    console.log(`  ${tag.padEnd(7)} ${t.file.padEnd(48)} ${(res.ms / 1000).toFixed(1)}s`);
    if (!res.pass) console.log(indent(res.out));
  }
  return results;
}

function runBrowserLane() {
  const tests = MANIFEST.tests.filter((t) => t.lane === 'browser');
  const base = process.env.TEST_BASE_URL;
  if (!base) {
    console.log(`  SKIPPED — TEST_BASE_URL is not set. The browser lane needs a running standalone`);
    console.log(`  server (+ Chromium). It runs at pilot acceptance / R12 (TZ 18.2 item 10).\n`);
    return tests.map((t) => ({ ...t, pass: true, skipped: true, ms: 0, out: '' }));
  }
  const results = [];
  for (const t of tests) {
    const res = runTest(t.file, { TEST_BASE_URL: base });
    results.push({ ...t, ...res });
    console.log(`  ${(res.pass ? 'PASS' : 'FAIL').padEnd(7)} ${t.file.padEnd(48)} ${(res.ms / 1000).toFixed(1)}s`);
    if (!res.pass) console.log(indent(res.out));
  }
  return results;
}

const indent = (s) => s.split('\n').map((l) => `      | ${l}`).join('\n');

// ---- main ------------------------------------------------------------------------------------
const args = process.argv.slice(2);
if (!args.length) die(`usage: run-tests.mjs <unit|db|scheduler|browser|all|--list|--check> …`);
if (args.includes('--check')) checkManifest();
if (args.includes('--list')) printList();

const lanes = new Set();
for (const a of args) {
  if (!RUN_LANE[a]) die(`unknown lane "${a}" — expected one of: ${Object.keys(RUN_LANE).join(', ')}, --list, --check`);
  RUN_LANE[a].forEach((l) => lanes.add(l));
}

let all = [];
if (lanes.has('unit')) { console.log(`\n== unit ==`); all = all.concat(runUnitLane()); }
if (lanes.has('db') || lanes.has('scheduler')) {
  const dbLanes = [lanes.has('db') ? 'db' : null, lanes.has('scheduler') ? 'scheduler' : null].filter(Boolean);
  console.log(`\n== ${dbLanes.join(' + ')} ==`);
  all = all.concat(await runDbLanes(dbLanes));
}
if (lanes.has('browser')) { console.log(`\n== browser ==`); all = all.concat(runBrowserLane()); }

const failed = all.filter((r) => !r.pass);
const skipped = all.filter((r) => r.skipped);
console.log(`\n${'='.repeat(60)}`);
console.log(`  ${all.length - failed.length - skipped.length} passed · ${failed.length} failed · ${skipped.length} skipped`);
if (skipped.length) console.log(`  skipped: ${skipped.map((s) => s.file).join(', ')}`);
if (failed.length) { console.log(`  FAILED:  ${failed.map((s) => s.file).join(', ')}`); process.exit(1); }
console.log('  OK');
