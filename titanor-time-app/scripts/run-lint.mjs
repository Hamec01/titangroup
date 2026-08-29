#!/usr/bin/env node
// R02 `lint` gate for Titanor Time. Deliberately dependency-free — Next 16 removed `next lint` and
// this repo carries no ESLint config; a full ESLint flat-config stack is its own task (candidate for
// R07 hardening). What this DOES guarantee on every run / in CI:
//   1. prisma validate            — the shared schema is well-formed
//   2. schema formatting is clean  — `prisma format` would make no change
//   3. test-manifest.json is in sync with scripts/_test-*.ts
//   4. no obvious secret literal has been committed under titanor-time-app/
// Type checking is a separate gate (`npm run typecheck`).

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, '..');
const SCHEMA = join(APP_ROOT, '..', 'prisma', 'schema.prisma');
const PRISMA = join(APP_ROOT, 'node_modules', '.bin', 'prisma');

let failed = 0;
const step = (name, fn) => {
  process.stdout.write(`  ${name} … `);
  try {
    const msg = fn();
    console.log(msg || 'ok');
  } catch (e) {
    failed++;
    console.log('FAIL');
    console.log(String(e.message || e).split('\n').map((l) => `      ${l}`).join('\n'));
  }
};

// prisma validate/format only parse the schema; they still insist DATABASE_URL is defined.
const PRISMA_ENV = { ...process.env, DATABASE_URL: process.env.DATABASE_URL || 'postgresql://u:u@localhost:5432/u' };

step('prisma validate', () => {
  const r = spawnSync(PRISMA, ['validate', '--schema', SCHEMA], { encoding: 'utf8', env: PRISMA_ENV });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim());
});

step('schema formatting', () => {
  const before = readFileSync(SCHEMA, 'utf8');
  const r = spawnSync(PRISMA, ['format', '--schema', SCHEMA], { encoding: 'utf8', env: PRISMA_ENV });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim());
  const after = readFileSync(SCHEMA, 'utf8');
  if (before !== after) throw new Error('prisma/schema.prisma is not formatted — run `npx prisma format` and commit.');
});

step('test-manifest.json in sync', () => {
  const r = spawnSync(process.execPath, [join(HERE, 'run-tests.mjs'), '--check'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stdout || r.stderr || '').trim());
});

step('no committed secrets under titanor-time-app/', () => {
  // Fast smoke only — CI runs an authoritative gitleaks scan over the whole repo history.
  // Patterns are deliberately conservative: real key material, not short doc placeholders.
  const PLACEHOLDER_PW = /^(?:u|x|pass(?:word)?|dev|test|postgres|secret|changeme|your[-_]?password)$/i;
  const patterns = [
    [/-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/, 'private key block'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
    [/\bxox[baprs]-[0-9A-Za-z-]{20,}\b/, 'Slack token'],
    [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
    [/\b(?:IDEMPOTENCY_ENCRYPTION_KEY|PERSONAL_DATA_ENCRYPTION_KEY|ACTIVATION_TOKEN_HMAC_KEY|PASSWORD_RESET_TOKEN_HMAC_KEY|SESSION_SECRET)\s*[:=]\s*['"][A-Za-z0-9+/]{24,}={0,2}['"]/, 'hard-coded crypto key'],
  ];
  const pgUrl = /postgres(?:ql)?:\/\/([a-z0-9_.-]+):([^\s:'"@/]+)@([a-z0-9_.-]+)/gi;
  const skipDir = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage']);
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) { if (!skipDir.has(entry)) walk(p); continue; }
      if (!/\.(ts|tsx|js|mjs|cjs|json|env|sh|yml|yaml|md)$/.test(entry)) continue;
      if (st.size > 2_000_000) continue;
      const rel = relative(APP_ROOT, p);
      // this file itself defines the patterns
      if (rel === join('scripts', 'run-lint.mjs')) continue;
      const text = readFileSync(p, 'utf8');
      for (const [re, label] of patterns) if (re.test(text)) hits.push(`${rel}: ${label}`);
      for (const m of text.matchAll(pgUrl)) {
        const [, , pw, host] = m;
        const local = /^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0|postgres|db|host|hostname|example\.com)$/i.test(host);
        if (!local && !PLACEHOLDER_PW.test(pw) && pw.length >= 6) hits.push(`${rel}: postgres URL with an inline password (${host})`);
      }
    }
  };
  walk(APP_ROOT);
  if (hits.length) throw new Error(`possible secret(s):\n${hits.join('\n')}`);
});

console.log('');
if (failed) { console.error(`  lint: ${failed} check(s) failed\n`); process.exit(1); }
console.log('  lint: all checks passed\n');
