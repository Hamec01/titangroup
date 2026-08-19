import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { prisma } from '../lib/prisma';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4A CSV Export Schema Foundation" (+ its
// "FOLLOW-UP — align ExportItem with canonical worked-time semantics" addendum) — permanent
// regression for the schema-only slice: no API, no generation, no download. Every check here
// exercises the actual DB constraints/triggers on disposable PostgreSQL 16, not application-level
// validation (there is none yet — T8.4B).
//
// FOLLOW-UP checks are labelled "FU-n" (n matching that addendum's own 1-15 numbered scenario list)
// to avoid colliding with this file's pre-existing 1-23 numbering from the original T8.4A task —
// several FU items (1/2/12/13/15) are already fully exercised by the original numbered checks below
// (1/2, 14b, 18-19, 4-5 respectively) and are only cross-referenced, not duplicated.

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 600) : '');
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function makeUserWithRole(tag: string, roleName: string) {
  const user = await prisma.user.create({ data: { username: `${roleName.toLowerCase()}-${tag}-${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN' } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = randomBytes(32).toString('base64url');
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
  return { user, token };
}

let fixtureAdmin: { id: string };
async function ensureAdminUser() {
  if (fixtureAdmin) return fixtureAdmin;
  const { user } = await makeUserWithRole('fixture', 'ADMIN');
  fixtureAdmin = user;
  return user;
}

async function makeEmployee(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `TEST-T84A-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}

async function makeSite(tag: string) {
  return prisma.workSite.create({ data: { name: `T84A Site ${tag} ${randomUUID().slice(0, 4)}` } });
}

async function makePeriod(startDate: Date, endDate: Date) {
  const admin = await ensureAdminUser();
  return prisma.payrollPeriod.create({ data: { startDate, endDate, status: 'OPEN', openedByUserId: admin.id } });
}

interface FixtureVersion {
  employeeId: string;
  siteId: string;
  periodId: string;
  timesheetVersionId: string;
}

/** Builds one Employee + WorkSite + Timesheet + TimesheetVersion (FINAL_APPROVED, one 8h segment)
 * on a fresh, non-overlapping period — everything an ExportItem's FKs need. */
async function makeFixtureVersion(tag: string, year: number): Promise<FixtureVersion> {
  const admin = await ensureAdminUser();
  const emp = await makeEmployee(tag);
  const site = await makeSite(tag);
  const period = await makePeriod(new Date(`${year}-01-01`), new Date(`${year}-01-14`));
  const asg = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, isPrimary: true, validFrom: new Date(`${year}-01-01`), validTo: new Date(`${year}-01-14`), assignedByUserId: admin.id } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'FINAL_APPROVED' } });
  const version = await prisma.timesheetVersion.create({ data: { timesheetId: ts.id, employeeId: emp.id, versionNumber: 1, source: 'WORKER', createdByUserId: admin.id, submissionSource: 'MANUAL' } });
  await prisma.timesheet.update({ where: { id: ts.id }, data: { currentVersionId: version.id } });
  const date = new Date(`${year}-01-02`);
  const day = await prisma.timesheetDay.create({ data: { timesheetVersionId: version.id, date, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetPlannedShift.create({ data: { timesheetVersionId: version.id, employeeId: emp.id, date, siteId: site.id, sourceAssignmentId: asg.id, plannedBreakMinutes: 0 } });
  await prisma.workSegment.create({ data: { timesheetDayId: day.id, timesheetVersionId: version.id, employeeId: emp.id, date, startAt: new Date(`${year}-01-02T08:00:00Z`), endAt: new Date(`${year}-01-02T16:00:00Z`), siteId: site.id, sourceAssignmentId: asg.id, crossesMidnight: false } });
  return { employeeId: emp.id, siteId: site.id, periodId: period.id, timesheetVersionId: version.id };
}

// Returned as a plain Uint8Array<ArrayBuffer>, matching lib/idempotency.ts's own established
// workaround for the same ecosystem type gap (Buffer's backing ArrayBufferLike is wider than
// Prisma's generated Bytes field type wants).
function fakeCsvContent(rows: string[]): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(`date,employeeNumber,siteName,grossMinutes\n${rows.join('\n')}\n`, 'utf8');
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out as Uint8Array<ArrayBuffer>;
}

function goodItemFields(v: FixtureVersion, dateStr: string) {
  return {
    employeeId: v.employeeId,
    timesheetVersionId: v.timesheetVersionId,
    siteId: v.siteId,
    date: new Date(dateStr),
    employeeNumberSnapshot: 'TEST-0001',
    employeeNameSnapshot: 'Test Worker',
    siteNameSnapshot: 'Test Site',
    grossMinutes: 480,
    paidBreakMinutes: 30,
    unpaidBreakMinutes: 30,
    workedMinutes: 450, // canonical: gross - unpaid (480 - 30) — paid breaks stay inside worked time
    segmentCount: 1
  };
}

async function expectReject(name: string, fn: () => Promise<unknown>, identifierOrCode: string) {
  try {
    await fn();
    check(name, false, 'expected rejection, got success');
  } catch (err) {
    const anyErr = err as { message?: string; code?: string; meta?: unknown };
    const message = err instanceof Error ? err.message : String(err);
    const found = message.includes(identifierOrCode) || (typeof anyErr.code === 'string' && anyErr.code === identifierOrCode) || JSON.stringify(anyErr.meta ?? {}).includes(identifierOrCode);
    check(name, found, { code: anyErr.code, meta: anyErr.meta, message: message.slice(-300) });
  }
}

async function main() {
  // ===============================================================================================
  // 1/2: migrate deploy from scratch, then repeated with no pending migrations. The actual `prisma
  // migrate deploy` CLI invocations happen outside this script (they're prerequisites for even
  // connecting here) — this checks the DB-level artifact they must have left behind: both new
  // migrations recorded as applied, cleanly, with nothing rolled back.
  // ===============================================================================================
  {
    const rows = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"
      WHERE migration_name IN ('20260819150000_add_export_batch_schema', '20260819160000_seed_export_permissions')
    `;
    check('1: both new migrations are recorded in _prisma_migrations', rows.length === 2, rows.length);
    check('2: both new migrations finished cleanly with nothing rolled back', rows.every((r) => r.finished_at !== null && r.rolled_back_at === null), rows);
  }

  const admin = await ensureAdminUser();

  // ===============================================================================================
  // 3: Prisma models correspond to DB — a plain round-trip create+read through the generated client
  // proves the client's types match the actual table shape (would fail to compile/run otherwise).
  // ===============================================================================================
  {
    const v = await makeFixtureVersion('ModelCheck', 2090);
    const period = await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: v.periodId } });
    const content = fakeCsvContent(['2090-01-02,TEST-0001,Test Site,480']);
    const batch = await prisma.exportBatch.create({
      data: {
        periodId: v.periodId,
        format: 'CSV_V1',
        kind: 'FULL',
        createdByUserId: admin.id,
        fileName: 'export.csv',
        fileHash: sha256Hex(content),
        fileSizeBytes: content.byteLength,
        rowCount: 1,
        content
      }
    });
    const item = await prisma.exportItem.create({ data: { exportBatchId: batch.id, ...goodItemFields(v, '2090-01-02') } });
    check('3: ExportBatch round-trips through the Prisma client', batch.periodId === v.periodId && batch.format === 'CSV_V1' && batch.kind === 'FULL', batch);
    check('3b: ExportItem round-trips through the Prisma client', item.exportBatchId === batch.id && item.workedMinutes === 450, item);
    check('3c: period.status still OPEN (period-status gating is application-layer, not DB-enforced in T8.4A)', period.status === 'OPEN', period.status);
  }

  // ===============================================================================================
  // 4/5: exactly 6 RolePermission (3 permissions x ADMIN/SUPER_ADMIN), FOREMAN/WORKER get none
  // ===============================================================================================
  {
    const grants = await prisma.rolePermission.findMany({
      where: { permission: { code: { in: ['period.export', 'export.create', 'export.read'] } } },
      select: { role: { select: { name: true } }, permission: { select: { code: true } } }
    });
    check('4: exactly 6 RolePermission grants for the three new permissions', grants.length === 6, grants.length);
    const roleNames = new Set(grants.map((g) => g.role.name));
    check('4b: only ADMIN and SUPER_ADMIN hold any of the three grants', roleNames.size === 2 && roleNames.has('ADMIN') && roleNames.has('SUPER_ADMIN'), [...roleNames]);
    check('5: FOREMAN holds zero of the three new grants', !grants.some((g) => g.role.name === 'FOREMAN'));
    check('5b: WORKER holds zero of the three new grants', !grants.some((g) => g.role.name === 'WORKER'));
  }

  // ===============================================================================================
  // 6: valid FULL batch + items insert cleanly
  // ===============================================================================================
  let fullBatchId: string;
  let fullBatchPeriodId: string;
  {
    const v = await makeFixtureVersion('FullOk', 2091);
    fullBatchPeriodId = v.periodId;
    const content = fakeCsvContent(['2091-01-02,TEST-0001,Test Site,480']);
    const batch = await prisma.exportBatch.create({
      data: { periodId: v.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'export.csv', fileHash: sha256Hex(content), fileSizeBytes: content.byteLength, rowCount: 1, content }
    });
    fullBatchId = batch.id;
    const item = await prisma.exportItem.create({ data: { exportBatchId: batch.id, ...goodItemFields(v, '2091-01-02') } });
    check('6: valid FULL batch inserts', !!batch.id);
    check('6b: valid item inserts', !!item.id);
  }

  // ===============================================================================================
  // 7: second FULL for the same period is rejected (ux_export_batch_full_per_period). Prisma reports
  // a partial unique index by its covered column list ("periodId"), not its raw index name.
  // ===============================================================================================
  {
    const content = fakeCsvContent(['x']);
    await expectReject(
      '7: second FULL batch for the same period is rejected',
      () => prisma.exportBatch.create({ data: { periodId: fullBatchPeriodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(content), fileSizeBytes: content.byteLength, rowCount: 0, content } }),
      'periodId'
    );
  }

  // ===============================================================================================
  // 8: FULL with correctsBatchId set is rejected (ck_export_batch_kind_correction_shape)
  // ===============================================================================================
  {
    const v = await makeFixtureVersion('FullWithCorrects', 2092);
    const content = fakeCsvContent(['x']);
    await expectReject(
      '8: FULL batch with correctsBatchId set is rejected',
      () => prisma.exportBatch.create({ data: { periodId: v.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, correctsBatchId: fullBatchId, fileName: 'x.csv', fileHash: sha256Hex(content), fileSizeBytes: content.byteLength, rowCount: 0, content } }),
      'ck_export_batch_kind_correction_shape'
    );
  }

  // ===============================================================================================
  // 9: CORRECTION without correctsBatchId is rejected. In principle CK-37 (ck_export_batch_kind_
  // correction_shape) is the constraint that names this shape violation — but Postgres runs BEFORE
  // ROW triggers ahead of CHECK validation, and FN-25/TRG-30 (fn_export_batch_correction_chain_check)
  // gates on NEW.kind = 'CORRECTION' alone (not on correctsBatchId being non-null), so it always looks
  // up the predecessor first. "id = NULL" matches no row, so the trigger raises PREDECESSOR_NOT_FOUND
  // before CK-37 is ever evaluated. The row is still rejected either way; CK-37 remains reachable (and
  // is the actual failure reason) for the other half of its predicate — FULL with correctsBatchId set,
  // see scenario 8 above. Documented in 05_RAW_SQL_REGISTER.md CK-37's entry.
  // ===============================================================================================
  {
    const content = fakeCsvContent(['x']);
    await expectReject(
      '9: CORRECTION batch without correctsBatchId is rejected',
      () => prisma.exportBatch.create({ data: { periodId: fullBatchPeriodId, format: 'CSV_V1', kind: 'CORRECTION', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(content), fileSizeBytes: content.byteLength, rowCount: 0, content } }),
      'EXPORT_BATCH_CORRECTION_PREDECESSOR_NOT_FOUND'
    );
  }

  // ===============================================================================================
  // 10: cross-period correctsBatchId is rejected (fn_export_batch_correction_chain_check)
  // ===============================================================================================
  {
    const otherV = await makeFixtureVersion('CrossPeriod', 2093);
    const content = fakeCsvContent(['x']);
    await expectReject(
      '10: CORRECTION referencing a FULL batch of a DIFFERENT period is rejected',
      () => prisma.exportBatch.create({ data: { periodId: otherV.periodId, format: 'CSV_V1', kind: 'CORRECTION', correctsBatchId: fullBatchId, createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(content), fileSizeBytes: content.byteLength, rowCount: 0, content } }),
      'EXPORT_BATCH_CORRECTION_PERIOD_MISMATCH'
    );
  }

  // ===============================================================================================
  // 11: self-reference and cycle are rejected
  // ===============================================================================================
  {
    // Self-reference: correctsBatchId cannot equal id. Since id is server-generated, we can only
    // reach this by first creating a legitimate CORRECTION, then attempting a second CORRECTION
    // that (im)properly references itself is impossible pre-insert — so this specifically tests the
    // CHECK's predicate via a direct raw SQL attempt with a client-supplied id (the only way to
    // construct the exact self-reference condition Prisma's own API can't express — Prisma always
    // lets Postgres generate id via DEFAULT).
    // As with scenario 9, FN-25's BEFORE INSERT predecessor lookup runs before CK-38
    // (ck_export_batch_no_self_correction) is checked — and a row can never find itself via
    // "id = <its own not-yet-inserted id>", so the observed rejection is PREDECESSOR_NOT_FOUND, not
    // the CK-38 name. CK-38 stays as a defense-in-depth backstop should the trigger logic ever change.
    const explicitId = randomUUID();
    const content = fakeCsvContent(['x']);
    await expectReject(
      '11: self-referencing correctsBatchId is rejected',
      () =>
        prisma.$executeRaw`INSERT INTO "ExportBatch" ("id", "periodId", "format", "kind", "createdByUserId", "correctsBatchId", "fileName", "fileHash", "fileSizeBytes", "rowCount", "content")
          VALUES (${explicitId}::uuid, ${fullBatchPeriodId}::uuid, 'CSV_V1'::"ExportFormat", 'CORRECTION'::"ExportBatchKind", ${admin.id}::uuid, ${explicitId}::uuid, 'x.csv', ${sha256Hex(content)}, ${content.byteLength}, 0, ${content})`,
      'EXPORT_BATCH_CORRECTION_PREDECESSOR_NOT_FOUND'
    );

    // Cycle (defense-in-depth, structurally unreachable via normal INSERT — proven by attempting it
    // directly): build A (CORRECTION of fullBatch), then attempt to force B's correctsBatchId to
    // point to A while ALSO trying to retroactively make A point to B — since rows are immutable and
    // UPDATE is banned, the only way to even attempt a "cycle" shape is a hand-crafted raw INSERT
    // referencing a not-yet-committed id in the same transaction, which the trigger's own recursive
    // walk must still reject if it ever occurred.
    const correctionA = await prisma.exportBatch.create({
      data: { periodId: fullBatchPeriodId, format: 'CSV_V1', kind: 'CORRECTION', correctsBatchId: fullBatchId, createdByUserId: admin.id, fileName: 'a.csv', fileHash: sha256Hex(content), fileSizeBytes: content.byteLength, rowCount: 0, content }
    });
    // correctionA.correctsBatchId = fullBatchId already. A genuine cycle would require fullBatchId's
    // own correctsBatchId to (somehow) become correctionA.id — impossible (fullBatch is FULL, CK-37
    // forces correctsBatchId IS NULL forever, and it's immutable). This confirms the structural
    // impossibility claim empirically rather than asserting it.
    const fullBatchAfter = await prisma.exportBatch.findUniqueOrThrow({ where: { id: fullBatchId } });
    check('11b: the FULL batch a correction points to can never itself gain a correctsBatchId (structural cycle prevention)', fullBatchAfter.correctsBatchId === null, fullBatchAfter.correctsBatchId);
    void correctionA;
  }

  // ===============================================================================================
  // 12: invalid hash is rejected
  // ===============================================================================================
  {
    const v = await makeFixtureVersion('BadHash', 2094);
    const content = fakeCsvContent(['x']);
    await expectReject(
      '12: fileHash not 64 lowercase hex chars is rejected',
      () => prisma.exportBatch.create({ data: { periodId: v.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: 'NOT-A-HASH', fileSizeBytes: content.byteLength, rowCount: 0, content } }),
      'ck_export_batch_file_hash_format'
    );
  }

  // ===============================================================================================
  // 13: content/fileSize mismatch is rejected
  // ===============================================================================================
  {
    const v = await makeFixtureVersion('SizeMismatch', 2095);
    const content = fakeCsvContent(['x']);
    await expectReject(
      '13: fileSizeBytes not matching octet_length(content) is rejected',
      () => prisma.exportBatch.create({ data: { periodId: v.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(content), fileSizeBytes: content.byteLength + 1, rowCount: 0, content } }),
      'ck_export_batch_file_size_matches_content'
    );
  }

  // ===============================================================================================
  // 14: negative numbers are rejected (ExportBatch.rowCount/fileSizeBytes, ExportItem minute fields)
  // ===============================================================================================
  {
    const v = await makeFixtureVersion('NegativeBatch', 2096);
    const content = fakeCsvContent(['x']);
    await expectReject(
      '14: negative rowCount is rejected',
      () => prisma.exportBatch.create({ data: { periodId: v.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(content), fileSizeBytes: content.byteLength, rowCount: -1, content } }),
      'ck_export_batch_counts_nonnegative'
    );

    const v2 = await makeFixtureVersion('NegativeItem', 2097);
    const content2 = fakeCsvContent(['x']);
    const batch2 = await prisma.exportBatch.create({ data: { periodId: v2.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(content2), fileSizeBytes: content2.byteLength, rowCount: 1, content: content2 } });
    // unpaidBreakMinutes (not grossMinutes) made negative here, with grossMinutes left at
    // goodItemFields' default 480: a negative value is trivially <= any non-negative gross, so
    // ck_export_item_minute_bounds (FU-4) stays satisfied and this isolates
    // ck_export_item_minutes_nonnegative specifically — negative grossMinutes itself would also
    // (correctly) trip ck_export_item_minute_bounds first, since every other field would then
    // exceed it, which would no longer isolate this specific constraint.
    await expectReject(
      '14b: negative unpaidBreakMinutes on an item is rejected',
      () => prisma.exportItem.create({ data: { exportBatchId: batch2.id, ...goodItemFields(v2, '2097-01-02'), unpaidBreakMinutes: -5 } }),
      'ck_export_item_minutes_nonnegative'
    );
  }

  // ===============================================================================================
  // 15 (original numbering, now retired): the arithmetic-equality formula CHECK
  // (ck_export_item_worked_minutes_formula) that scenario 15 used to test was REMOVED by the
  // FOLLOW-UP corrective migration (20260819170000_fix_export_item_worked_minutes_bounds) — it was
  // both semantically wrong (subtracted paid breaks, contradicting lib/reporting/worked-time.ts) and
  // structurally impossible to hold in general after independent per-column rounding (see that
  // migration's own header comment and the FU-3..FU-11 block below). Slot intentionally left empty
  // rather than renumbering every later original-scheme check.
  // ===============================================================================================

  // ===============================================================================================
  // FOLLOW-UP — align ExportItem with canonical worked-time semantics
  // (docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4A FOLLOW-UP")
  // ===============================================================================================

  // FU-1/FU-2: clean migrate deploy + repeat (no pending) — the corrective migration's own artifact,
  // same technique as scenarios 1/2 above.
  {
    const rows = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"
      WHERE migration_name = '20260819170000_fix_export_item_worked_minutes_bounds'
    `;
    check('FU-1: the corrective migration is recorded in _prisma_migrations', rows.length === 1, rows.length);
    check('FU-2: the corrective migration finished cleanly with nothing rolled back', rows[0]?.finished_at != null && rows[0]?.rolled_back_at === null, rows[0]);
  }

  // FU-3/FU-4: the old arithmetic-equality CHECK is gone, the new bounds CHECK exists.
  {
    const cons = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE conrelid = '"ExportItem"'::regclass AND contype = 'c'
    `;
    const names = new Set(cons.map((c) => c.conname));
    check('FU-3: ck_export_item_worked_minutes_formula no longer exists', !names.has('ck_export_item_worked_minutes_formula'), [...names]);
    check('FU-4: ck_export_item_minute_bounds exists', names.has('ck_export_item_minute_bounds'), [...names]);
  }

  // FU-5/FU-6/FU-7: canonical worked-time semantics (paid breaks stay INSIDE worked time) are
  // accepted — none of these would have passed the old, removed arithmetic-equality CHECK.
  {
    const v5 = await makeFixtureVersion('FU5', 2100);
    const batch5 = await prisma.exportBatch.create({ data: { periodId: v5.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(fakeCsvContent(['x'])), fileSizeBytes: fakeCsvContent(['x']).byteLength, rowCount: 1, content: fakeCsvContent(['x']) } });
    const item5 = await prisma.exportItem.create({ data: { exportBatchId: batch5.id, ...goodItemFields(v5, '2100-01-02'), grossMinutes: 60, paidBreakMinutes: 15, unpaidBreakMinutes: 0, workedMinutes: 60 } });
    check('FU-5: gross=60,paid=15,unpaid=0,worked=60 (paid break stays inside worked time) is accepted', !!item5.id);

    const v6 = await makeFixtureVersion('FU6', 2101);
    const batch6 = await prisma.exportBatch.create({ data: { periodId: v6.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(fakeCsvContent(['x'])), fileSizeBytes: fakeCsvContent(['x']).byteLength, rowCount: 1, content: fakeCsvContent(['x']) } });
    const item6 = await prisma.exportItem.create({ data: { exportBatchId: batch6.id, ...goodItemFields(v6, '2101-01-02'), grossMinutes: 60, paidBreakMinutes: 0, unpaidBreakMinutes: 15, workedMinutes: 45 } });
    check('FU-6: gross=60,paid=0,unpaid=15,worked=45 (gross - unpaid, no paid break) is accepted', !!item6.id);

    const v7 = await makeFixtureVersion('FU7', 2102);
    const batch7 = await prisma.exportBatch.create({ data: { periodId: v7.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(fakeCsvContent(['x'])), fileSizeBytes: fakeCsvContent(['x']).byteLength, rowCount: 1, content: fakeCsvContent(['x']) } });
    const item7 = await prisma.exportItem.create({ data: { exportBatchId: batch7.id, ...goodItemFields(v7, '2102-01-02'), grossMinutes: 60, paidBreakMinutes: 10, unpaidBreakMinutes: 15, workedMinutes: 45 } });
    check('FU-7: gross=60,paid=10,unpaid=15,worked=45 (both break kinds present, paid ignored in worked) is accepted', !!item7.id);
  }

  // FU-8: adversarial independent rounding — grossMs=31000ms rounds to grossMinutes=1, but
  // workedMs=2000ms (after subtracting unpaidBreakMs=29000ms) rounds to workedMinutes=0. This is
  // exactly the counterexample that makes ANY arithmetic equality between the three rounded columns
  // impossible in general (documented in the corrective migration's own header comment) — the new
  // bounds CHECK (0 <= 1) must still accept it.
  {
    const v8 = await makeFixtureVersion('FU8', 2103);
    const batch8 = await prisma.exportBatch.create({ data: { periodId: v8.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(fakeCsvContent(['x'])), fileSizeBytes: fakeCsvContent(['x']).byteLength, rowCount: 1, content: fakeCsvContent(['x']) } });
    const item8 = await prisma.exportItem.create({ data: { exportBatchId: batch8.id, ...goodItemFields(v8, '2103-01-02'), grossMinutes: 1, paidBreakMinutes: 0, unpaidBreakMinutes: 0, workedMinutes: 0 } });
    check('FU-8: adversarial rounding gross=1,paid=0,unpaid=0,worked=0 is accepted', !!item8.id);
  }

  // FU-9/FU-10/FU-11: each of worked/paid/unpaid individually exceeding gross is rejected.
  {
    const v9 = await makeFixtureVersion('FU9', 2104);
    const batch9 = await prisma.exportBatch.create({ data: { periodId: v9.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(fakeCsvContent(['x'])), fileSizeBytes: fakeCsvContent(['x']).byteLength, rowCount: 1, content: fakeCsvContent(['x']) } });
    await expectReject(
      'FU-9: workedMinutes > grossMinutes is rejected',
      () => prisma.exportItem.create({ data: { exportBatchId: batch9.id, ...goodItemFields(v9, '2104-01-02'), grossMinutes: 60, paidBreakMinutes: 0, unpaidBreakMinutes: 0, workedMinutes: 61 } }),
      'ck_export_item_minute_bounds'
    );

    const v10 = await makeFixtureVersion('FU10', 2105);
    const batch10 = await prisma.exportBatch.create({ data: { periodId: v10.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(fakeCsvContent(['x'])), fileSizeBytes: fakeCsvContent(['x']).byteLength, rowCount: 1, content: fakeCsvContent(['x']) } });
    await expectReject(
      'FU-10: paidBreakMinutes > grossMinutes is rejected',
      () => prisma.exportItem.create({ data: { exportBatchId: batch10.id, ...goodItemFields(v10, '2105-01-02'), grossMinutes: 60, paidBreakMinutes: 61, unpaidBreakMinutes: 0, workedMinutes: 60 } }),
      'ck_export_item_minute_bounds'
    );

    const v11 = await makeFixtureVersion('FU11', 2106);
    const batch11 = await prisma.exportBatch.create({ data: { periodId: v11.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(fakeCsvContent(['x'])), fileSizeBytes: fakeCsvContent(['x']).byteLength, rowCount: 1, content: fakeCsvContent(['x']) } });
    await expectReject(
      'FU-11: unpaidBreakMinutes > grossMinutes is rejected',
      () => prisma.exportItem.create({ data: { exportBatchId: batch11.id, ...goodItemFields(v11, '2106-01-02'), grossMinutes: 60, paidBreakMinutes: 0, unpaidBreakMinutes: 61, workedMinutes: 0 } }),
      'ck_export_item_minute_bounds'
    );
  }

  // FU-12 (negative values still rejected): already exercised by scenario 14b above
  // (ck_export_item_minutes_nonnegative, untouched by the corrective migration).
  // FU-13 (ExportBatch/ExportItem still immutable): already exercised by scenarios 18/19 above.
  // FU-15 (permissions unchanged): already exercised by scenarios 4/4b/5/5b above — the corrective
  // migration is DDL-only on ExportItem, it does not touch Permission/RolePermission at all.
  // FU-14 (dump/restore preserves the new constraint) is exercised as a separate procedure against a
  // second disposable PostgreSQL instance, outside this script — see the session's own report.

  // ===============================================================================================
  // 16: duplicate daily item is rejected
  // ===============================================================================================
  {
    const v = await makeFixtureVersion('DupItem', 2099);
    const content = fakeCsvContent(['x']);
    const batch = await prisma.exportBatch.create({ data: { periodId: v.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(content), fileSizeBytes: content.byteLength, rowCount: 2, content } });
    await prisma.exportItem.create({ data: { exportBatchId: batch.id, ...goodItemFields(v, '2099-01-02') } });
    await expectReject(
      '16: duplicate (exportBatchId, employeeId, siteId, date) is rejected',
      () => prisma.exportItem.create({ data: { exportBatchId: batch.id, ...goodItemFields(v, '2099-01-02') } }),
      'employeeId","siteId","date'
    );
  }

  // ===============================================================================================
  // 17: TimesheetVersion of another employee is rejected (composite FK)
  // ===============================================================================================
  {
    const v1 = await makeFixtureVersion('CompositeFkA', 2000);
    const v2 = await makeFixtureVersion('CompositeFkB', 2001);
    const content = fakeCsvContent(['x']);
    const batch = await prisma.exportBatch.create({ data: { periodId: v1.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(content), fileSizeBytes: content.byteLength, rowCount: 1, content } });
    await expectReject(
      "17: timesheetVersionId belonging to a DIFFERENT employeeId than the item's own employeeId is rejected",
      () => prisma.exportItem.create({ data: { exportBatchId: batch.id, ...goodItemFields(v1, '2000-01-02'), timesheetVersionId: v2.timesheetVersionId } }),
      'ExportItem_timesheetVersionId_employeeId_fkey'
    );
  }

  // ===============================================================================================
  // 18/19: UPDATE/DELETE ExportBatch and ExportItem are rejected
  // ===============================================================================================
  {
    const v = await makeFixtureVersion('ImmutableCheck', 2002);
    const content = fakeCsvContent(['x']);
    const batch = await prisma.exportBatch.create({ data: { periodId: v.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(content), fileSizeBytes: content.byteLength, rowCount: 1, content } });
    const item = await prisma.exportItem.create({ data: { exportBatchId: batch.id, ...goodItemFields(v, '2002-01-02') } });

    await expectReject('18: UPDATE ExportBatch is rejected', () => prisma.exportBatch.update({ where: { id: batch.id }, data: { fileName: 'renamed.csv' } }), 'EXPORT_BATCH_IMMUTABLE');
    await expectReject('18b: DELETE ExportBatch is rejected', () => prisma.exportBatch.delete({ where: { id: batch.id } }), 'EXPORT_BATCH_IMMUTABLE');
    await expectReject('19: UPDATE ExportItem is rejected', () => prisma.exportItem.update({ where: { id: item.id }, data: { grossMinutes: 1 } }), 'EXPORT_ITEM_IMMUTABLE');
    await expectReject('19b: DELETE ExportItem is rejected', () => prisma.exportItem.delete({ where: { id: item.id } }), 'EXPORT_ITEM_IMMUTABLE');
  }

  // ===============================================================================================
  // 20: related Employee/Site/TimesheetVersion/User cannot be deleted through export history.
  // A live delete attempt against Employee/WorkSite/TimesheetVersion in this fixture graph is
  // ALWAYS blocked by more than one RESTRICT FK simultaneously (Employment, SiteAssignment,
  // Timesheet.currentVersionId, etc. — all pre-existing, all also RESTRICT) — Postgres doesn't
  // guarantee which one it reports first, so asserting a specific constraint name on a raw delete
  // is not a reliable way to isolate the NEW ExportItem/ExportBatch FKs specifically. Two checks:
  // (a) the delete IS blocked end-to-end (proves "cannot bypass export history" holds in practice,
  // whichever FK fires), and (b) direct pg_constraint introspection proves the four NEW FKs
  // themselves are ON DELETE RESTRICT (proves it precisely, independent of fixture graph ordering).
  // ===============================================================================================
  {
    const v = await makeFixtureVersion('NoOrphan', 2003);
    const content = fakeCsvContent(['x']);
    const batch = await prisma.exportBatch.create({ data: { periodId: v.periodId, format: 'CSV_V1', kind: 'FULL', createdByUserId: admin.id, fileName: 'x.csv', fileHash: sha256Hex(content), fileSizeBytes: content.byteLength, rowCount: 1, content } });
    await prisma.exportItem.create({ data: { exportBatchId: batch.id, ...goodItemFields(v, '2003-01-02') } });

    await expectReject('20a: deleting an Employee referenced by ExportItem is blocked end-to-end', () => prisma.employee.delete({ where: { id: v.employeeId } }), 'P2003');
    await expectReject('20b: deleting a WorkSite referenced by ExportItem is blocked end-to-end', () => prisma.workSite.delete({ where: { id: v.siteId } }), 'P2003');
    await expectReject('20c: deleting a TimesheetVersion referenced by ExportItem is blocked end-to-end', () => prisma.timesheetVersion.delete({ where: { id: v.timesheetVersionId } }), 'P2003');
    await expectReject('20d: deleting the User referenced as createdByUserId is blocked end-to-end', () => prisma.user.delete({ where: { id: admin.id } }), 'P2003');

    const fkRows = await prisma.$queryRaw<{ conname: string; confdeltype: string }[]>`
      SELECT conname, confdeltype FROM pg_constraint
      WHERE conname IN ('ExportItem_employeeId_fkey', 'ExportItem_siteId_fkey', 'ExportItem_timesheetVersionId_employeeId_fkey', 'ExportBatch_createdByUserId_fkey')
    `;
    const byName = new Map(fkRows.map((r) => [r.conname, r.confdeltype]));
    check('20e: ExportItem_employeeId_fkey is ON DELETE RESTRICT (confdeltype=r)', byName.get('ExportItem_employeeId_fkey') === 'r', byName.get('ExportItem_employeeId_fkey'));
    check('20f: ExportItem_siteId_fkey is ON DELETE RESTRICT (confdeltype=r)', byName.get('ExportItem_siteId_fkey') === 'r', byName.get('ExportItem_siteId_fkey'));
    check('20g: ExportItem_timesheetVersionId_employeeId_fkey is ON DELETE RESTRICT (confdeltype=r)', byName.get('ExportItem_timesheetVersionId_employeeId_fkey') === 'r', byName.get('ExportItem_timesheetVersionId_employeeId_fkey'));
    check('20h: ExportBatch_createdByUserId_fkey is ON DELETE RESTRICT (confdeltype=r)', byName.get('ExportBatch_createdByUserId_fkey') === 'r', byName.get('ExportBatch_createdByUserId_fkey'));
  }

  // ===============================================================================================
  // 22: no AuditEvent changes from all the read-only checks above
  // ===============================================================================================
  {
    const auditCount = await prisma.auditEvent.count();
    check('22: AuditEvent count is 0 (schema-only slice, zero write path touches it)', auditCount === 0, auditCount);
  }

  // ===============================================================================================
  // 23: schema/migration contains no GPS coordinates, payloadHash, deviceInstallationId, requestId
  // ===============================================================================================
  {
    const fs = await import('node:fs');
    const migrationSql = fs.readFileSync(new URL('../../prisma/migrations/20260819150000_add_export_batch_schema/migration.sql', import.meta.url), 'utf8');
    const permissionSql = fs.readFileSync(new URL('../../prisma/migrations/20260819160000_seed_export_permissions/migration.sql', import.meta.url), 'utf8');
    const followupSql = fs.readFileSync(new URL('../../prisma/migrations/20260819170000_fix_export_item_worked_minutes_bounds/migration.sql', import.meta.url), 'utf8');
    const forbidden = ['latitude', 'longitude', 'payloadHash', 'deviceInstallationId', 'deviceSequence', 'requestId', 'clientEventId'];
    for (const term of forbidden) {
      check(`23: forbidden term "${term}" absent from the schema migration`, !migrationSql.includes(term));
      check(`23b: forbidden term "${term}" absent from the permissions migration`, !permissionSql.includes(term));
      check(`23c: forbidden term "${term}" absent from the follow-up corrective migration`, !followupSql.includes(term));
    }
  }

  console.log(JSON.stringify({ pass, fail }, null, 2));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error('SCRIPT ERROR', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
