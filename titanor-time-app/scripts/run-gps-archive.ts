// R08 — GPS archive entry point. Compiled to .runtime/gps-archive.cjs (build-runtime-scripts.mjs)
// and run by ops/titanor-time/gps-archive-titanor-time.sh in a throwaway container:
//
//   node .runtime/gps-archive.cjs write     -> encrypt sealable days into GPS_ARCHIVE_STAGING_DIR
//   node .runtime/gps-archive.cjs promote   -> mark VERIFIED the days the host copied off-box
//
// Fail-closed: exits non-zero without doing anything when GPS_ARCHIVE_ENCRYPTION_KEY is absent or
// malformed. Never prints coordinates or the key — only structured event lines.
import { prisma } from '../lib/prisma';
import { runGpsArchiveWrite, runGpsArchivePromote } from '../lib/gps-archive-runner';

function log(fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...fields }) + '\n');
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'write';
  const stagingDir = process.env.GPS_ARCHIVE_STAGING_DIR || '/app/gps-archive-staging';

  if (mode !== 'write' && mode !== 'promote') {
    log({ event: 'gps_archive_bad_mode', mode });
    process.exit(2);
  }

  try {
    if (mode === 'write') {
      const r = await runGpsArchiveWrite({
        stagingDir,
        sealMarginDays: envInt('GPS_ARCHIVE_SEAL_MARGIN_DAYS', 2),
        maxLookbackDays: envInt('GPS_ARCHIVE_MAX_LOOKBACK_DAYS', 120),
        log
      });
      await prisma.$disconnect();
      process.exit(r.failed.length > 0 ? 1 : 0);
    } else {
      const r = await runGpsArchivePromote({ stagingDir, log });
      await prisma.$disconnect();
      process.exit(r.failed.length > 0 ? 1 : 0);
    }
  } catch (error) {
    log({ event: 'gps_archive_fatal', errorCode: (error as { name?: string })?.name ?? 'GPS_ARCHIVE_FATAL' });
    await prisma.$disconnect().catch(() => {});
    process.exit(3);
  }
}

if (require.main === module) {
  void main();
}
