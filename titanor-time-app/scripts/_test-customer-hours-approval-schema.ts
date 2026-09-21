import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';

// UT2 (Titanor Time — единый табель и подтверждение часов по заказчику, checkpoint UT2-B) —
// permanent regression for the schema-only CustomerHoursApprovalBatch/CustomerHoursApprovalItem
// slice: no API, no reconciliation service, no UI yet (a later, separate checkpoint). Every check
// here exercises the actual DB constraints/FKs/triggers/permission seed on disposable PostgreSQL
// 16, never a text search over the migration file. See docs/titanor-time/05_RAW_SQL_REGISTER.md
// CK-59..CK-66 / UX-05..UX-06 / FN-27..FN-28 / TRG-32..TRG-33 for the registered identifiers this
// file proves are real.

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 600) : '');
  }
}

async function expectReject(name: string, fn: () => Promise<unknown>, identifierOrCode: string) {
  try {
    await fn();
    check(name, false, 'expected rejection, got success');
  } catch (err) {
    const anyErr = err as { message?: string; code?: string; meta?: unknown };
    const message = err instanceof Error ? err.message : String(err);
    const found = message.includes(identifierOrCode) || (typeof anyErr.code === 'string' && anyErr.code === identifierOrCode) || JSON.stringify(anyErr.meta ?? {}).includes(identifierOrCode);
    check(name, found, { code: anyErr.code, meta: anyErr.meta, message: message.slice(-400) });
  }
}

let fixtureAdmin: { id: string } | null = null;
async function ensureAdminUser() {
  if (fixtureAdmin) return fixtureAdmin;
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const user = await prisma.user.create({ data: { username: `cha-admin-${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  fixtureAdmin = user;
  return user;
}

// One fixed Monday week, reused everywhere an item's own weekStart/weekEnd need to be VALID —
// nothing FK-ties CustomerHoursApprovalItem.weekStart/weekEnd to PayrollPeriod's own date range,
// so period dates and item week dates are chosen independently.
const WEEK_START = new Date('2094-01-04'); // confirmed Monday
const WEEK_END = new Date('2094-01-10'); // WEEK_START + 6

interface Fixture {
  admin: { id: string };
  employeeId: string;
  siteId: string;
  workAreaId: string;
  timesheetId: string;
  periodId: string;
}

/** One Employee + WorkSite + WorkArea + PayrollPeriod + (DRAFT) Timesheet — everything a
 *  CustomerHoursApprovalItem's FKs need. Each call uses a fresh Employee, so distinct fixtures
 *  never collide on the per-employee PayrollPeriod overlap trigger even when reusing the same
 *  calendar dates. */
async function makeFixture(tag: string): Promise<Fixture> {
  const admin = await ensureAdminUser();
  const emp = await prisma.employee.create({ data: { employeeNumber: `CHA-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01') } });
  const site = await prisma.workSite.create({ data: { name: `CHA Site ${tag} ${randomUUID().slice(0, 4)}` } });
  const workArea = await prisma.workArea.create({ data: { siteId: site.id, name: `CHA WA ${tag}` } });
  const period = await prisma.payrollPeriod.create({ data: { startDate: WEEK_START, endDate: WEEK_END, status: 'OPEN', openedByUserId: admin.id } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
  return { admin, employeeId: emp.id, siteId: site.id, workAreaId: workArea.id, timesheetId: ts.id, periodId: period.id };
}

async function makeBatch(adminId: string, tag: string) {
  return prisma.customerHoursApprovalBatch.create({
    data: { approvedByUserId: adminId, requestId: randomUUID(), idempotencyKey: randomUUID(), selectionSnapshot: { tag }, itemCount: 1, workedMinutes: 480 }
  });
}

function goodItemFields(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    timesheetId: f.timesheetId,
    employeeId: f.employeeId,
    siteId: f.siteId,
    workAreaId: f.workAreaId,
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    sourceKind: 'VERSION' as const,
    sourceId: randomUUID(),
    sourceRevision: null,
    fingerprint: '0'.repeat(64),
    workedMinutes: 480,
    grossMinutes: 510,
    breakMinutes: 30,
    snapshot: { schemaVersion: 1 },
    ...overrides
  };
}

async function main() {
  // ===============================================================================================
  // 0: migration recorded cleanly in _prisma_migrations
  // ===============================================================================================
  {
    const rows = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"
      WHERE migration_name = '20260921120000_add_customer_hours_approval'
    `;
    check('0: migration is recorded in _prisma_migrations', rows.length === 1, rows);
    check('0b: migration finished cleanly, nothing rolled back', rows[0]?.finished_at != null && rows[0]?.rolled_back_at === null, rows[0]);
  }

  // ===============================================================================================
  // 1/2: valid DRAFT item and valid VERSION item round-trip through the Prisma client
  // ===============================================================================================
  {
    const f = await makeFixture('DraftOk');
    const batch = await makeBatch(f.admin.id, 'DraftOk');
    const item = await prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f, { sourceKind: 'DRAFT', sourceRevision: BigInt(1) }) } });
    check('1: valid DRAFT item creates (sourceRevision required and set)', item.sourceKind === 'DRAFT' && item.sourceRevision === BigInt(1), { sourceKind: item.sourceKind, sourceRevision: item.sourceRevision?.toString() });
  }
  {
    const f = await makeFixture('VersionOk');
    const batch = await makeBatch(f.admin.id, 'VersionOk');
    const item = await prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f) } });
    check('2: valid VERSION item creates (sourceRevision null)', item.sourceKind === 'VERSION' && item.sourceRevision === null, item.sourceRevision);
  }

  // ===============================================================================================
  // 3: CK-59 ck_customer_hours_approval_item_week_range — weekEnd != weekStart + 6
  // ===============================================================================================
  {
    const f = await makeFixture('CK59');
    const batch = await makeBatch(f.admin.id, 'CK59');
    await expectReject(
      '3 (CK-59): weekEnd != weekStart+6 is rejected',
      () => prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f, { weekEnd: new Date('2094-01-12') }) } }),
      'ck_customer_hours_approval_item_week_range'
    );
  }

  // ===============================================================================================
  // 4: CK-60 ck_customer_hours_approval_item_week_start_monday — weekStart is a Tuesday, weekEnd
  //    still exactly weekStart+6, to isolate from CK-59.
  // ===============================================================================================
  {
    const f = await makeFixture('CK60');
    const batch = await makeBatch(f.admin.id, 'CK60');
    await expectReject(
      '4 (CK-60): weekStart not a Monday is rejected',
      () => prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f, { weekStart: new Date('2094-01-05'), weekEnd: new Date('2094-01-11') }) } }),
      'ck_customer_hours_approval_item_week_start_monday'
    );
  }

  // ===============================================================================================
  // 5: CK-61 ck_customer_hours_approval_item_minutes_nonnegative — workedMinutes negative, balance
  //    kept true (grossMinutes = workedMinutes + breakMinutes) to isolate from CK-62.
  // ===============================================================================================
  {
    const f = await makeFixture('CK61');
    const batch = await makeBatch(f.admin.id, 'CK61');
    await expectReject(
      '5 (CK-61): negative workedMinutes is rejected',
      () => prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f, { workedMinutes: -1, breakMinutes: 1, grossMinutes: 0 }) } }),
      'ck_customer_hours_approval_item_minutes_nonnegative'
    );
  }

  // ===============================================================================================
  // 6: CK-62 ck_customer_hours_approval_item_minutes_balance — grossMinutes != worked + break, all
  //    individually nonnegative to isolate from CK-61.
  // ===============================================================================================
  {
    const f = await makeFixture('CK62');
    const batch = await makeBatch(f.admin.id, 'CK62');
    await expectReject(
      '6 (CK-62): grossMinutes != workedMinutes + breakMinutes is rejected',
      () => prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f, { workedMinutes: 100, breakMinutes: 50, grossMinutes: 200 }) } }),
      'ck_customer_hours_approval_item_minutes_balance'
    );
  }

  // ===============================================================================================
  // 7: CK-63 ck_customer_hours_approval_item_source_revision_shape — VERSION with sourceRevision set
  // ===============================================================================================
  {
    const f = await makeFixture('CK63');
    const batch = await makeBatch(f.admin.id, 'CK63');
    await expectReject(
      '7 (CK-63): sourceKind=VERSION with sourceRevision set is rejected',
      () => prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f, { sourceKind: 'VERSION', sourceRevision: BigInt(5) }) } }),
      'ck_customer_hours_approval_item_source_revision_shape'
    );
    await expectReject(
      '7b (CK-63): sourceKind=DRAFT with sourceRevision null is rejected',
      () => prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f, { sourceKind: 'DRAFT', sourceRevision: null }) } }),
      'ck_customer_hours_approval_item_source_revision_shape'
    );
  }

  // ===============================================================================================
  // 8: CK-64 ck_customer_hours_approval_item_superseded_shape — approvalState=CURRENT with
  //    supersededAt set (via a direct raw INSERT — the Prisma client's create() has no field for
  //    approvalState/supersededAt on a fresh row via the typed API in a way that reaches this
  //    shape any other way; raw SQL is the only way to construct the exact violating shape).
  // ===============================================================================================
  {
    const f = await makeFixture('CK64');
    const batch = await makeBatch(f.admin.id, 'CK64');
    const g = goodItemFields(f);
    await expectReject(
      '8 (CK-64): approvalState=CURRENT with supersededAt set is rejected',
      () => prisma.$executeRaw`
        INSERT INTO "CustomerHoursApprovalItem"
          ("batchId","timesheetId","employeeId","siteId","workAreaId","weekStart","weekEnd","sourceKind","sourceId","sourceRevision","fingerprint","workedMinutes","grossMinutes","breakMinutes","snapshot","approvalState","supersededAt","supersededBySourceId")
        VALUES
          (${batch.id}::uuid, ${g.timesheetId}::uuid, ${g.employeeId}::uuid, ${g.siteId}::uuid, ${g.workAreaId}::uuid, ${g.weekStart}, ${g.weekEnd}, 'VERSION'::"CustomerHoursApprovalSourceKind", ${g.sourceId}::uuid, NULL, ${g.fingerprint}, ${g.workedMinutes}, ${g.grossMinutes}, ${g.breakMinutes}, ${JSON.stringify(g.snapshot)}::jsonb, 'CURRENT'::"CustomerHoursApprovalState", now(), ${randomUUID()}::uuid)
      `,
      'ck_customer_hours_approval_item_superseded_shape'
    );
  }

  // ===============================================================================================
  // 9: CK-65 ck_customer_hours_approval_item_fingerprint_format
  // ===============================================================================================
  {
    const f = await makeFixture('CK65');
    const batch = await makeBatch(f.admin.id, 'CK65');
    await expectReject(
      '9 (CK-65): fingerprint not 64 lowercase hex chars is rejected',
      () => prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f, { fingerprint: 'NOT-A-HASH'.padEnd(64, 'x') }) } }),
      'ck_customer_hours_approval_item_fingerprint_format'
    );
  }

  // ===============================================================================================
  // 10: CK-66 ck_customer_hours_approval_batch_counts_nonnegative
  // ===============================================================================================
  {
    const f = await makeFixture('CK66');
    await expectReject(
      '10 (CK-66): negative Batch.itemCount is rejected',
      () => prisma.customerHoursApprovalBatch.create({ data: { approvedByUserId: f.admin.id, requestId: randomUUID(), idempotencyKey: randomUUID(), selectionSnapshot: {}, itemCount: -1, workedMinutes: 0 } }),
      'ck_customer_hours_approval_batch_counts_nonnegative'
    );
    await expectReject(
      '10b (CK-66): negative Batch.workedMinutes is rejected',
      () => prisma.customerHoursApprovalBatch.create({ data: { approvedByUserId: f.admin.id, requestId: randomUUID(), idempotencyKey: randomUUID(), selectionSnapshot: {}, itemCount: 0, workedMinutes: -1 } }),
      'ck_customer_hours_approval_batch_counts_nonnegative'
    );
  }

  // ===============================================================================================
  // 11: composite FK #1 — timesheetId belonging to a DIFFERENT employeeId than the item's own
  // ===============================================================================================
  {
    const fA = await makeFixture('FkTsA');
    const fB = await makeFixture('FkTsB');
    const batch = await makeBatch(fA.admin.id, 'FkTs');
    await expectReject(
      "11: timesheetId belonging to a different employeeId than the item's own employeeId is rejected",
      () => prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(fA, { timesheetId: fB.timesheetId }) } }),
      'CustomerHoursApprovalItem_timesheetId_employeeId_fkey'
    );
  }

  // ===============================================================================================
  // 12: composite FK #2 — workAreaId belonging to a site DIFFERENT from the item's own siteId
  // ===============================================================================================
  {
    const fA = await makeFixture('FkWaA');
    const fB = await makeFixture('FkWaB');
    const batch = await makeBatch(fA.admin.id, 'FkWa');
    await expectReject(
      "12: workAreaId belonging to a different siteId than the item's own siteId is rejected",
      () => prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(fA, { workAreaId: fB.workAreaId }) } }),
      'CustomerHoursApprovalItem_siteId_workAreaId_fkey'
    );
  }

  // ===============================================================================================
  // 13: UX-05 ux_customer_hours_approval_item_active_with_customer — two CURRENT items, identical
  //     (employeeId,timesheetId,siteId,workAreaId,weekStart)
  // ===============================================================================================
  {
    const f = await makeFixture('Ux05');
    const batch = await makeBatch(f.admin.id, 'Ux05');
    await prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f) } });
    await expectReject(
      '13 (UX-05): a second CURRENT item with the same (employeeId,timesheetId,siteId,workAreaId,weekStart) is rejected',
      () => prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f, { sourceId: randomUUID() }) } }),
      'P2002'
    );
  }

  // ===============================================================================================
  // 14: UX-06 ux_customer_hours_approval_item_active_no_customer — two CURRENT items, both
  //     workAreaId=null, identical (employeeId,timesheetId,siteId,weekStart)
  // ===============================================================================================
  {
    const f = await makeFixture('Ux06');
    const batch = await makeBatch(f.admin.id, 'Ux06');
    await prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f, { workAreaId: null }) } });
    await expectReject(
      '14 (UX-06): a second CURRENT item with workAreaId=null and the same (employeeId,timesheetId,siteId,weekStart) is rejected',
      () => prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f, { workAreaId: null, sourceId: randomUUID() }) } }),
      'P2002'
    );
  }

  // ===============================================================================================
  // 15: no conflict between different workAreaId at the same site/week — proves the two-index
  //     split doesn't over-block distinct customers.
  // ===============================================================================================
  {
    const f = await makeFixture('NoConflict');
    const workArea2 = await prisma.workArea.create({ data: { siteId: f.siteId, name: 'CHA WA2 NoConflict' } });
    const batch = await makeBatch(f.admin.id, 'NoConflict');
    const item1 = await prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f) } });
    const item2 = await prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f, { workAreaId: workArea2.id, sourceId: randomUUID() }) } });
    check('15: two CURRENT items, same site/week, different workAreaId, both insert', !!item1.id && !!item2.id, { item1: item1.id, item2: item2.id });
  }

  // ===============================================================================================
  // 16: valid CURRENT -> SUPERSEDED transition
  // ===============================================================================================
  let transitionedItemId: string;
  {
    const f = await makeFixture('GoodTransition');
    const batch = await makeBatch(f.admin.id, 'GoodTransition');
    const item = await prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f) } });
    transitionedItemId = item.id;
    const updated = await prisma.customerHoursApprovalItem.update({
      where: { id: item.id },
      data: { approvalState: 'SUPERSEDED', supersededAt: new Date(), supersededBySourceId: randomUUID() }
    });
    check('16: CURRENT -> SUPERSEDED with correct supersededAt/supersededBySourceId succeeds', updated.approvalState === 'SUPERSEDED' && updated.supersededAt !== null && updated.supersededBySourceId !== null, updated);
  }

  // ===============================================================================================
  // 17: any content field change is rejected, even alongside a correct CURRENT -> SUPERSEDED shape
  // ===============================================================================================
  {
    const f = await makeFixture('ContentGuard');
    const batch = await makeBatch(f.admin.id, 'ContentGuard');
    const item = await prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f) } });
    await expectReject(
      '17: SUPERSEDED transition that also changes workedMinutes is rejected',
      () => prisma.customerHoursApprovalItem.update({ where: { id: item.id }, data: { approvalState: 'SUPERSEDED', supersededAt: new Date(), supersededBySourceId: randomUUID(), workedMinutes: 1 } }),
      'CUSTOMER_HOURS_APPROVAL_ITEM_IMMUTABLE_FIELD_CHANGED'
    );
    await expectReject(
      '17b: SUPERSEDED transition that also changes fingerprint is rejected',
      () => prisma.customerHoursApprovalItem.update({ where: { id: item.id }, data: { approvalState: 'SUPERSEDED', supersededAt: new Date(), supersededBySourceId: randomUUID(), fingerprint: '1'.repeat(64) } }),
      'CUSTOMER_HOURS_APPROVAL_ITEM_IMMUTABLE_FIELD_CHANGED'
    );
    const stillCurrent = await prisma.customerHoursApprovalItem.findUniqueOrThrow({ where: { id: item.id } });
    check('17c: the row is still CURRENT after both rejected attempts', stillCurrent.approvalState === 'CURRENT', stillCurrent.approvalState);
  }

  // ===============================================================================================
  // 18: CURRENT -> CURRENT no-op UPDATE is rejected (no early return for byte-identical rows —
  //     owner correction, UT2-B)
  // ===============================================================================================
  {
    const f = await makeFixture('NoopCurrent');
    const batch = await makeBatch(f.admin.id, 'NoopCurrent');
    const item = await prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f) } });
    await expectReject(
      '18: CURRENT -> CURRENT UPDATE (approvalState re-written to its own value, nothing else changed) is rejected',
      () => prisma.customerHoursApprovalItem.update({ where: { id: item.id }, data: { approvalState: 'CURRENT' } }),
      'CUSTOMER_HOURS_APPROVAL_ITEM_IMMUTABLE_FIELD_CHANGED'
    );
  }

  // ===============================================================================================
  // 19: SUPERSEDED -> SUPERSEDED no-op UPDATE is rejected (byte-identical values re-written)
  // ===============================================================================================
  {
    await expectReject(
      '19: SUPERSEDED -> SUPERSEDED UPDATE with the SAME approvalState value re-written is rejected',
      () => prisma.customerHoursApprovalItem.update({ where: { id: transitionedItemId }, data: { approvalState: 'SUPERSEDED' } }),
      'CUSTOMER_HOURS_APPROVAL_ITEM_ALREADY_SUPERSEDED'
    );
  }

  // ===============================================================================================
  // 20: a repeat supersede attempt (genuinely different supersededAt/supersededBySourceId, not a
  //     byte-identical no-op) on an already-SUPERSEDED row is still rejected — not treated as an
  //     idempotent success.
  // ===============================================================================================
  {
    const f = await makeFixture('RepeatSupersede');
    const batch = await makeBatch(f.admin.id, 'RepeatSupersede');
    const item = await prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f) } });
    await prisma.customerHoursApprovalItem.update({ where: { id: item.id }, data: { approvalState: 'SUPERSEDED', supersededAt: new Date(), supersededBySourceId: randomUUID() } });
    await expectReject(
      '20: a SECOND, genuinely different supersede attempt on an already-SUPERSEDED row is rejected (not idempotent at the trigger level)',
      () => prisma.customerHoursApprovalItem.update({ where: { id: item.id }, data: { supersededAt: new Date(Date.now() + 60_000), supersededBySourceId: randomUUID() } }),
      'CUSTOMER_HOURS_APPROVAL_ITEM_ALREADY_SUPERSEDED'
    );
  }

  // ===============================================================================================
  // 21: DELETE CustomerHoursApprovalItem is always rejected (CURRENT and SUPERSEDED alike)
  // ===============================================================================================
  {
    const f = await makeFixture('NoDeleteItem');
    const batch = await makeBatch(f.admin.id, 'NoDeleteItem');
    const item = await prisma.customerHoursApprovalItem.create({ data: { batchId: batch.id, ...goodItemFields(f) } });
    await expectReject('21: DELETE a CURRENT item is rejected', () => prisma.customerHoursApprovalItem.delete({ where: { id: item.id } }), 'CUSTOMER_HOURS_APPROVAL_ITEM_NO_DELETE');
    await expectReject('21b: DELETE an already-SUPERSEDED item is rejected', () => prisma.customerHoursApprovalItem.delete({ where: { id: transitionedItemId } }), 'CUSTOMER_HOURS_APPROVAL_ITEM_NO_DELETE');
  }

  // ===============================================================================================
  // 22: UPDATE and DELETE CustomerHoursApprovalBatch are unconditionally rejected
  // ===============================================================================================
  {
    const f = await makeFixture('BatchImmutable');
    const batch = await makeBatch(f.admin.id, 'BatchImmutable');
    await expectReject('22: UPDATE CustomerHoursApprovalBatch is rejected', () => prisma.customerHoursApprovalBatch.update({ where: { id: batch.id }, data: { itemCount: 99 } }), 'CUSTOMER_HOURS_APPROVAL_BATCH_IMMUTABLE');
    await expectReject('22b: DELETE CustomerHoursApprovalBatch is rejected', () => prisma.customerHoursApprovalBatch.delete({ where: { id: batch.id } }), 'CUSTOMER_HOURS_APPROVAL_BATCH_IMMUTABLE');
  }

  // ===============================================================================================
  // 23: CustomerHoursApprovalBatch.(approvedByUserId, idempotencyKey) uniqueness
  // ===============================================================================================
  {
    const f = await makeFixture('BatchUnique');
    const key = randomUUID();
    await prisma.customerHoursApprovalBatch.create({ data: { approvedByUserId: f.admin.id, requestId: randomUUID(), idempotencyKey: key, selectionSnapshot: {}, itemCount: 1, workedMinutes: 1 } });
    await expectReject(
      '23: a second batch with the same (approvedByUserId, idempotencyKey) is rejected',
      () => prisma.customerHoursApprovalBatch.create({ data: { approvedByUserId: f.admin.id, requestId: randomUUID(), idempotencyKey: key, selectionSnapshot: {}, itemCount: 2, workedMinutes: 2 } }),
      'P2002'
    );
    const other = await prisma.customerHoursApprovalBatch.create({ data: { approvedByUserId: f.admin.id, requestId: randomUUID(), idempotencyKey: randomUUID(), selectionSnapshot: {}, itemCount: 3, workedMinutes: 3 } });
    check('23b: same admin, DIFFERENT idempotencyKey, inserts fine (not a whole-actor lock)', !!other.id);
  }

  // ===============================================================================================
  // 24/25: permission timesheet.customer_hours_approve.all — ADMIN + SUPER_ADMIN only
  // ===============================================================================================
  {
    const grants = await prisma.rolePermission.findMany({
      where: { permission: { code: 'timesheet.customer_hours_approve.all' } },
      select: { role: { select: { name: true } } }
    });
    const roleNames = new Set(grants.map((g) => g.role.name));
    check('24: exactly 2 RolePermission grants for timesheet.customer_hours_approve.all', grants.length === 2, grants.length);
    check('24b: ADMIN holds the permission', roleNames.has('ADMIN'), [...roleNames]);
    check('24c: SUPER_ADMIN holds the permission', roleNames.has('SUPER_ADMIN'), [...roleNames]);
    check('25: FOREMAN does NOT hold the permission', !roleNames.has('FOREMAN'), [...roleNames]);
    check('25b: WORKER does NOT hold the permission', !roleNames.has('WORKER'), [...roleNames]);
  }

  // ===============================================================================================
  // 26: FK introspection — every RESTRICT-intended FK on CustomerHoursApprovalItem/Batch really is
  //     ON DELETE RESTRICT at the Postgres level (confdeltype='r'), not just by convention.
  // ===============================================================================================
  {
    const fkRows = await prisma.$queryRaw<{ conname: string; confdeltype: string }[]>`
      SELECT conname, confdeltype FROM pg_constraint
      WHERE conname IN (
        'CustomerHoursApprovalItem_batchId_fkey',
        'CustomerHoursApprovalItem_timesheetId_employeeId_fkey',
        'CustomerHoursApprovalItem_employeeId_fkey',
        'CustomerHoursApprovalItem_siteId_fkey',
        'CustomerHoursApprovalItem_siteId_workAreaId_fkey',
        'CustomerHoursApprovalBatch_approvedByUserId_fkey'
      )
    `;
    const byName = new Map(fkRows.map((r) => [r.conname, r.confdeltype]));
    check('26: all 6 FKs found', fkRows.length === 6, fkRows.map((r) => r.conname));
    check('26b: all 6 FKs are ON DELETE RESTRICT', fkRows.every((r) => r.confdeltype === 'r'), fkRows);
    void byName;
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
