// R06-B — assemble the minimal `prisma` CLI dependency closure into `.prisma-tools/` so the
// production image can run `prisma migrate deploy` / `prisma migrate status` / `prisma migrate
// resolve` (release + emergency recovery) with plain `node` — no `npx`, no `npm install`, no
// network. This is deliberately SEPARATE from the app's query path: the running web server and
// scheduler use `@prisma/client` + its native query engine from `.next/standalone/node_modules`;
// `.prisma-tools/` only ever holds the schema-engine + CLI, invoked out-of-band by the deploy
// script or an operator.
//
// The closure is walked from the lockfile-exact install produced by `npm ci` in the `dependencies`
// stage — it is not a hand-maintained list, so a pinned `prisma` bump carries its own deps along.
//
// Run once, in the Docker builder stage, after `npm run build`. Output: /app/.prisma-tools/.

import { readFileSync, existsSync, mkdirSync, rmSync, symlinkSync, cpSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcModules = join(appDir, 'node_modules');
const outDir = join(appDir, '.prisma-tools');
const outModules = join(outDir, 'node_modules');

// bookworm-slim links against OpenSSL 3.x — the 1.1.x engine variants are dead weight.
const DEAD_ENGINE = /(openssl-1\.1\.x|linux-musl|rhel-openssl|linux-arm64|darwin|windows)/;

function depClosure(rootName) {
  const seen = new Set();
  const stack = [rootName];
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    const pkgJson = join(srcModules, name, 'package.json');
    if (!existsSync(pkgJson)) {
      throw new Error(`R06-B: ${name} not found in node_modules — run \`npm ci\` first`);
    }
    seen.add(name);
    const meta = JSON.parse(readFileSync(pkgJson, 'utf8'));
    for (const dep of Object.keys(meta.dependencies ?? {})) stack.push(dep);
  }
  return [...seen].sort();
}

function pruneDeadEngines(dir) {
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += pruneDeadEngines(full);
    } else if (
      (entry.name.includes('engine') || entry.name.endsWith('.node')) &&
      DEAD_ENGINE.test(entry.name)
    ) {
      unlinkSync(full);
      removed += 1;
    }
  }
  return removed;
}

function dirBytes(dir) {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    bytes += entry.isDirectory() ? dirBytes(full) : statSync(full).size;
  }
  return bytes;
}

function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outModules, { recursive: true });

  const closure = depClosure('prisma');
  for (const name of closure) {
    const src = join(srcModules, name);
    const dst = join(outModules, name);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true, dereference: true });
  }

  // `prisma` bin — build/index.js is the CLI entry (package.json "bin").
  const binDir = join(outModules, '.bin');
  mkdirSync(binDir, { recursive: true });
  symlinkSync(join('..', 'prisma', 'build', 'index.js'), join(binDir, 'prisma'));

  const removed = pruneDeadEngines(outModules);

  // Hard invariants — fail the build if the closure is not actually runnable.
  const cliEntry = join(outModules, 'prisma', 'build', 'index.js');
  if (!existsSync(cliEntry)) throw new Error('R06-B: prisma/build/index.js missing after assembly');
  const enginesDir = join(outModules, '@prisma', 'engines');
  const schemaEngine = readdirSync(enginesDir).find((f) => f.startsWith('schema-engine-'));
  if (!schemaEngine) throw new Error('R06-B: no schema-engine binary in @prisma/engines after prune');

  console.log(
    `R06-B: .prisma-tools assembled — ${closure.length} packages, ${removed} dead engine files pruned, ~${Math.round(dirBytes(outModules) / 1024 / 1024)} MB`
  );
  console.log(`R06-B: schema-engine kept: ${schemaEngine}`);
}

main();
