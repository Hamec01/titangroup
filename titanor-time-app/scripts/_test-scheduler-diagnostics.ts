// R06-A — the scheduler runtime's tick outcome classification and the enriched heartbeat, against
// a real disposable PostgreSQL 16. Renames a table to simulate a schema drift — throwaway DB only.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '../lib/prisma';
import { runOneTickCore } from '../lib/attendance-scheduler-runtime';
import type { AttendanceAutoSubmitTickResult } from '../lib/attendance-auto-submit';
import {
  newHeartbeat,
  writeHeartbeatRecord,
  readHeartbeatRecord,
  writeHeartbeat as legacyWriteHeartbeat
} from '../lib/attendance-scheduler-heartbeat';

process.env.ATTENDANCE_SCHEDULER_HEARTBEAT_PATH = join(mkdtempSync(join(tmpdir(), 'r06a-hb-')), 'heartbeat.json');

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x !== undefined ? JSON.stringify(x).slice(0, 200) : ''); }
};

const OK_RESULT: AttendanceAutoSubmitTickResult = {
  scanned: 0, due: 0, submittedClean: 0, submittedWithExceptions: 0,
  skippedAlreadySubmitted: 0, skippedNotActionable: 0, noop: 0, failed: 0
} as AttendanceAutoSubmitTickResult;

const noopLog = () => {};

async function main() {
  // 1. successful tick
  const ok = await runOneTickCore(async () => OK_RESULT, noopLog);
  check('1: successful tick -> kind ok', ok.kind === 'ok', ok);

  // 2. generic error -> other
  const generic = await runOneTickCore(async () => { throw new Error('boom'); }, noopLog);
  check('2: generic throw -> top_level_error / other', generic.kind === 'top_level_error' && generic.errorClass === 'other', generic);

  // 3. real schema drift -> schema_incompatible. Rename a table the tick will query.
  await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" RENAME TO "AuditEvent__r06a"`);
  const schemaErr = await runOneTickCore(async () => {
    await prisma.auditEvent.findFirst();
    return OK_RESULT;
  }, noopLog);
  check('3: query on a missing table -> schema_incompatible', schemaErr.kind === 'top_level_error' && schemaErr.errorClass === 'schema_incompatible', schemaErr);
  await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent__r06a" RENAME TO "AuditEvent"`);
  check('3: restored', (await runOneTickCore(async () => { await prisma.auditEvent.findFirst(); return OK_RESULT; }, noopLog)).kind === 'ok');

  // 4. heartbeat round-trip (format 2)
  const started = new Date('2026-08-30T11:00:00.000Z');
  const record = newHeartbeat(9999, started);
  record.lastTickAt = '2026-08-30T11:05:00.000Z';
  record.lastTickCompletedAt = '2026-08-30T11:05:00.000Z';
  record.lastOutcome = 'ok';
  record.consecutiveFailures = 0;
  await writeHeartbeatRecord(record);
  const read = await readHeartbeatRecord();
  check('4: format-2 round-trips exactly', JSON.stringify(read) === JSON.stringify(record), read);
  check('4: pid + processStartedAt preserved', read?.pid === 9999 && read?.processStartedAt === started.toISOString());

  // 5. legacy format-1 heartbeat is read degraded, not dropped
  await legacyWriteHeartbeat(new Date('2026-08-30T11:07:00.000Z')); // shim writes a format-2 record now
  const afterLegacyShim = await readHeartbeatRecord();
  check('5: legacy writeHeartbeat shim produces a valid format-2 record', afterLegacyShim?.format === 2 && afterLegacyShim.lastOutcome === 'ok' && afterLegacyShim.lastTickCompletedAt === '2026-08-30T11:07:00.000Z', afterLegacyShim);

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
