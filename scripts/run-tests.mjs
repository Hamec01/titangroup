#!/usr/bin/env node
// R07-B — minimal security-regression test runner for the public site. No database, no browser:
// each scripts/_test-*.ts is a self-contained tsx script that prints `PASS: n/m` and exits 0/1.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const tsx = join(HERE, '..', 'node_modules', '.bin', 'tsx');

const files = readdirSync(HERE)
  .filter((f) => f.startsWith('_test-') && f.endsWith('.ts'))
  .sort();

if (files.length === 0) {
  console.log('no _test-*.ts files');
  process.exit(0);
}

let failed = 0;
for (const f of files) {
  const started = Date.now();
  const r = spawnSync(tsx, [join(HERE, f)], { encoding: 'utf8' });
  const ms = ((Date.now() - started) / 1000).toFixed(1);
  const out = (r.stdout || '') + (r.stderr || '');
  const summary = (out.match(/PASS: \d+\/\d+/) || ['(no summary)'])[0];
  if (r.status === 0) {
    console.log(`  PASS  ${f.padEnd(34)} ${summary}  ${ms}s`);
  } else {
    failed++;
    console.log(`  FAIL  ${f.padEnd(34)} ${summary}  ${ms}s`);
    console.log(out.split('\n').filter((l) => l.includes('FAIL') || l.includes('Error')).map((l) => `        ${l}`).join('\n'));
  }
}

console.log('');
if (failed) {
  console.error(`  ${failed} test file(s) failed\n`);
  process.exit(1);
}
console.log(`  all ${files.length} test files passed\n`);
