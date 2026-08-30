// R06-B — compile the long-lived / operational entry scripts to self-contained CJS bundles so the
// production image can run them with plain `node` — no `tsx`, no TypeScript, no `npx`, and no npm
// download at runtime. Everything each script imports (its `../lib/**` graph) is inlined; only the
// packages that MUST stay real files on disk are left external:
//   - @prisma/client / .prisma/client — the generated client + its native query-engine binary,
//     already forced into .next/standalone by next.config.mjs `outputFileTracingIncludes`.
//   - argon2, sharp — native addons (.node), resolved from .next/standalone/node_modules at runtime.
//
// esbuild is present in the builder stage (a transitive dependency of tsx). This script is invoked
// once, in the Docker builder stage, right after `next build`. Output: .runtime/<name>.cjs.

import { build } from 'esbuild';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(appDir, '.runtime');

// name -> entry. The name is what the runtime (compose command / healthcheck / operator) calls.
const ENTRIES = {
  'attendance-auto-submit-scheduler': 'scripts/attendance-auto-submit-scheduler.ts',
  'attendance-scheduler-healthcheck': 'scripts/attendance-scheduler-healthcheck.ts',
  'attendance-auto-submit-tick': 'scripts/attendance-auto-submit-tick.ts',
  'bootstrap-super-admin': 'scripts/bootstrap-super-admin.ts',
  'reset-password': 'scripts/reset-password.ts'
};

const EXTERNAL = ['@prisma/client', '.prisma/client', '.prisma', 'argon2', 'sharp'];

async function main() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const result = await build({
    entryPoints: Object.fromEntries(
      Object.entries(ENTRIES).map(([name, entry]) => [name, resolve(appDir, entry)])
    ),
    outdir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    // isolatedModules-safe, keeps stack traces readable in operator logs.
    sourcemap: false,
    minify: false,
    external: EXTERNAL,
    tsconfig: resolve(appDir, 'tsconfig.json'),
    logLevel: 'info',
    metafile: true,
    // `require.main === module` guards fire correctly for a bundled CJS entry.
    define: { 'process.env.NODE_ENV': '"production"' }
  });

  // Fail the build if anything outside the allow-list ended up external (that would mean a runtime
  // `require` of a package that is NOT guaranteed present in the slim image).
  const externals = new Set();
  for (const [path, input] of Object.entries(result.metafile.inputs)) {
    void path;
    for (const imp of input.imports) {
      if (imp.external && imp.kind !== 'require-resolve') externals.add(imp.path);
    }
  }
  const unexpected = [...externals].filter(
    (p) => !EXTERNAL.includes(p) && !p.startsWith('node:') && !isBuiltin(p)
  );
  if (unexpected.length > 0) {
    console.error('R06-B: unexpected external packages in runtime bundles:', unexpected);
    process.exit(1);
  }

  await writeFile(resolve(outdir, 'metafile.json'), JSON.stringify(result.metafile, null, 2));
  console.log('R06-B: built runtime bundles ->', Object.keys(ENTRIES).join(', '));
  console.log('R06-B: external (expected):', [...externals].sort().join(', ') || '(none)');
}

function isBuiltin(p) {
  const bare = p.replace(/^node:/, '').split('/')[0];
  return builtinModules.includes(bare);
}

main().catch((error) => {
  console.error('R06-B: runtime script bundling failed');
  console.error(error);
  process.exit(1);
});
