import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { createAssignmentInTx } from '@/lib/assignments';
import { acquireEmployeeLifecycleLock, ScheduledPrimaryConflictError } from '@/lib/assignment-lock';
import { recordAssignmentTransition } from '@/lib/assignment-transitions';
import { helsinkiToday } from '@/lib/workers';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §3.8 / §3.9 / §3.13 (L) — R15-D7 Deploy C.
// "Correctly finish a site" / "disable a customer" WITH a clear read-only preflight of every
// affected worker. No migration (WorkSite.finishedAt shipped in Migration 1). One writer of the
// site/customer lifecycle transition; per-site advisory lock so two admins can't double-finish.
// Reuses the same operational-close shape as removeFromSite (clockInDisabledAt = now, validTo =
// today unless committed time sits later, drop future draft planned shifts) but in bulk, tied by
// one groupId, with kind = SITE_FINISH / CUSTOMER_DISABLE on each AssignmentTransition.

function siteLifecycleLockKey(id: string): string {
  return `titanor_time:site_lifecycle:${id}`;
}

async function acquireSiteLifecycleLock(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${siteLifecycleLockKey(id)})::bigint)`;
}


// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared: a read-only look at who is affected + the bulk operational close
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface AffectedWorker {
  employeeId: string;
  assignmentId: string;
  name: string;
  employeeNumber: string;
  workAreaId: string | null;
  workAreaName: string | null;
  isPrimary: boolean;
  /** true when this worker is on an open shift right now — their shift is NOT interrupted. */
  workingNow: boolean;
  /** true when the assignment starts in the future (`validFrom > today`). */
  future: boolean;
}

/** Every operationally-live assignment on the site whose customer is `workAreaId` (or all, when
 *  `workAreaId` is undefined) — the rows a finish / disable would touch. Plus the future ones. */
async function loadAffected(
  where: Prisma.SiteAssignmentWhereInput,
  today: Date
): Promise<{ live: AffectedWorker[]; future: AffectedWorker[] }> {
  const now = new Date();
  const rows = await prisma.siteAssignment.findMany({
    where: {
      ...where,
      // live OR future — a removed / historically-ended assignment is not "affected".
      OR: [
        { AND: [{ validFrom: { lte: today } }, { OR: [{ validTo: null }, { validTo: { gte: today } }] }, { OR: [{ clockInDisabledAt: null }, { clockInDisabledAt: { gt: now } }] }] },
        { validFrom: { gt: today } }
      ]
    },
    orderBy: [{ isPrimary: 'desc' }, { validFrom: 'asc' }],
    select: {
      id: true,
      employeeId: true,
      workAreaId: true,
      isPrimary: true,
      validFrom: true,
      workArea: { select: { name: true } },
      employee: {
        select: {
          employeeNumber: true,
          firstName: true,
          lastName: true,
          openShift: { select: { sourceAssignmentId: true } }
        }
      }
    }
  });
  const map = (r: (typeof rows)[number]): AffectedWorker => ({
    employeeId: r.employeeId,
    assignmentId: r.id,
    name: `${r.employee.firstName} ${r.employee.lastName}`,
    employeeNumber: r.employee.employeeNumber,
    workAreaId: r.workAreaId,
    workAreaName: r.workArea?.name ?? null,
    isPrimary: r.isPrimary,
    workingNow: r.employee.openShift?.sourceAssignmentId === r.id,
    future: r.validFrom > today
  });
  return {
    live: rows.filter((r) => r.validFrom <= today).map(map),
    future: rows.filter((r) => r.validFrom > today).map(map)
  };
}

/** Close one assignment operationally (no new row) — §3.8 / §3.9. Matches removeFromSite: the
 *  worker can't clock in on it from now, today's already-recorded hours stay, future empty draft
 *  planned shifts are dropped, one AssignmentTransition is written under `groupId`. Open shifts are
 *  never touched — Check Out stays available and extends validTo at checkout (§3.12). */
async function operationallyCloseAssignmentInTx(
  tx: Prisma.TransactionClient,
  assignment: { id: string; employeeId: string; validTo: Date | null },
  opts: {
    kind: 'SITE_FINISH' | 'CUSTOMER_DISABLE';
    groupId: string;
    actorUserId: string;
    reasonText: string;
  }
): Promise<string> {
  const now = new Date();
  const today = helsinkiToday();

  // Committed / recorded time strictly AFTER today keeps the assignment's validTo where it is
  // (shrinking past a real segment would trip TRG-11); otherwise the payroll window closes today.
  const [wseg, pshift, dseg, frag] = await Promise.all([
    tx.workSegment.count({ where: { sourceAssignmentId: assignment.id, date: { gt: today } } }),
    tx.timesheetPlannedShift.count({ where: { sourceAssignmentId: assignment.id, date: { gt: today } } }),
    tx.timesheetDraftSegment.count({ where: { sourceAssignmentId: assignment.id, date: { gt: today } } }),
    tx.clockShiftFragment.count({ where: { sourceAssignmentId: assignment.id, date: { gt: today } } })
  ]);
  const hasCommittedFuture = wseg + pshift + dseg + frag > 0;
  const newValidTo = hasCommittedFuture ? assignment.validTo : today;
  const boundary = newValidTo ?? today;

  await tx.timesheetDraftPlannedShift.deleteMany({
    where: { sourceAssignmentId: assignment.id, date: { gt: boundary } }
  });

  await tx.siteAssignment.update({
    where: { id: assignment.id },
    data: {
      clockInDisabledAt: now,
      ...(newValidTo !== assignment.validTo ? { validTo: newValidTo } : {}),
      endedReason: opts.reasonText,
      version: { increment: 1 }
    }
  });

  const transition = await recordAssignmentTransition(tx, {
    employeeId: assignment.employeeId,
    kind: opts.kind,
    fromAssignmentId: assignment.id,
    toAssignmentId: null,
    actedAt: now,
    effectiveFrom: boundary,
    openShiftHandling: 'NONE',
    actorUserId: opts.actorUserId,
    groupId: opts.groupId,
    reasonCode: 'PROJECT_DONE',
    reasonText: opts.reasonText
  });
  return transition.id;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// finishSite (§3.8)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface FinishSitePreview {
  siteId: string;
  siteName: string;
  alreadyFinished: boolean;
  finishedAt: string | null;
  assignedCount: number;
  workingNowCount: number;
  futureAssignmentsCount: number;
  customerCount: number;
  workers: AffectedWorker[];
  futureWorkers: AffectedWorker[];
  /** Open shifts on this site whose worker has not checked out — the site would sit in
   *  "Завершается" until they do; the admin sees them with a fix / force-close link (§3.8). */
  openShifts: { employeeId: string; name: string; openedAt: string }[];
}

export async function finishSitePreview(siteId: string): Promise<FinishSitePreview | null> {
  const today = helsinkiToday();
  const site = await prisma.workSite.findUnique({
    where: { id: siteId },
    select: { id: true, name: true, active: true, finishedAt: true, workAreas: { select: { id: true, active: true } } }
  });
  if (!site) {
    return null;
  }

  const { live, future } = await loadAffected({ siteId }, today);
  const openShiftRows = await prisma.employeeOpenShift.findMany({
    where: { siteId },
    select: { openedAt: true, employee: { select: { id: true, firstName: true, lastName: true } } }
  });

  return {
    siteId: site.id,
    siteName: site.name,
    alreadyFinished: site.finishedAt !== null || !site.active,
    finishedAt: site.finishedAt ? site.finishedAt.toISOString() : null,
    assignedCount: live.length,
    workingNowCount: live.filter((w) => w.workingNow).length,
    futureAssignmentsCount: future.length,
    customerCount: site.workAreas.filter((a) => a.active).length,
    workers: live,
    futureWorkers: future,
    openShifts: openShiftRows.map((r) => ({
      employeeId: r.employee.id,
      name: `${r.employee.firstName} ${r.employee.lastName}`,
      openedAt: r.openedAt.toISOString()
    }))
  };
}

export interface FinishSiteInput {
  siteId: string;
  actorUserId: string;
  requestId: string;
}

export type FinishSiteError = { code: 'SITE_NOT_FOUND' } | { code: 'ALREADY_FINISHED' };

export interface FinishSiteResult {
  siteId: string;
  finishedAt: string;
  closedAssignmentCount: number;
  cancelledFutureAssignmentCount: number;
  openShiftsRemaining: number;
  groupId: string;
}

/**
 * §3.8 — "Завершить после текущих смен". New Check In / assignments on the site are refused at once
 * (server L). Every live assignment on the site is operationally closed (clockInDisabledAt = now,
 * validTo = today, future draft planned shifts dropped). FUTURE assignments (validFrom > today) are
 * cancelled outright — the project is over. Open shifts are left to close normally; the site stays
 * "Завершается" until the last one checks out, then "Завершён" (both computed from open-shift
 * presence). The geofence and all history stay. Reversible with `reopenSite` — assignments are NOT
 * revived.
 */
export async function finishSite(input: FinishSiteInput): Promise<FinishSiteResult | FinishSiteError> {
  const { siteId, actorUserId, requestId } = input;
  const now = new Date();
  const today = helsinkiToday();

  return prisma.$transaction(async (tx) => {
    await acquireSiteLifecycleLock(tx, siteId);

    const site = await tx.workSite.findUnique({ where: { id: siteId }, select: { id: true, name: true, active: true, finishedAt: true, version: true } });
    if (!site) {
      return { code: 'SITE_NOT_FOUND' as const };
    }
    if (site.finishedAt !== null) {
      return { code: 'ALREADY_FINISHED' as const };
    }

    const groupId = randomUUID();

    // FUTURE assignments — the project is over, cancel them (no committed hours possible yet). A
    // hard delete would strand a materialised TimesheetDraftPlannedShift (FK onDelete: Restrict),
    // so close them the same way: clockInDisabledAt + validTo = validFrom - 1 is invalid (before
    // start); instead validTo = validFrom (a one-day window) + clockInDisabledAt, and drop the
    // draft planned shifts. They never become live.
    const futureRows = await tx.siteAssignment.findMany({
      where: { siteId, validFrom: { gt: today }, clockInDisabledAt: null },
      select: { id: true, employeeId: true, validFrom: true, validTo: true }
    });
    for (const f of futureRows) {
      await tx.timesheetDraftPlannedShift.deleteMany({ where: { sourceAssignmentId: f.id } });
      await tx.siteAssignment.update({
        where: { id: f.id },
        data: { clockInDisabledAt: now, validTo: f.validFrom, endedReason: `Объект «${site.name}» завершён`, version: { increment: 1 } }
      });
      await recordAssignmentTransition(tx, {
        employeeId: f.employeeId,
        kind: 'SITE_FINISH',
        fromAssignmentId: f.id,
        toAssignmentId: null,
        actedAt: now,
        effectiveFrom: f.validFrom,
        openShiftHandling: 'NONE',
        actorUserId,
        groupId,
        reasonCode: 'PROJECT_DONE',
        reasonText: `Объект «${site.name}» завершён — будущее назначение отменено`
      });
    }

    // LIVE assignments — operational close.
    const liveRows = await tx.siteAssignment.findMany({
      where: {
        siteId,
        validFrom: { lte: today },
        OR: [{ validTo: null }, { validTo: { gte: today } }],
        clockInDisabledAt: null
      },
      select: { id: true, employeeId: true, validTo: true }
    });
    for (const a of liveRows) {
      await operationallyCloseAssignmentInTx(tx, a, {
        kind: 'SITE_FINISH',
        groupId,
        actorUserId,
        reasonText: `Объект «${site.name}» завершён`
      });
    }

    const updated = await tx.workSite.update({
      where: { id: siteId, version: site.version },
      data: { active: false, finishedAt: now, version: { increment: 1 } }
    });

    const openShiftsRemaining = await tx.employeeOpenShift.count({ where: { siteId } });

    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'SITE_FINISHED',
      entityType: 'WORK_SITE',
      entityId: siteId,
      requestId,
      beforeValue: { active: true, finishedAt: null },
      afterValue: {
        active: false,
        finishedAt: now.toISOString(),
        closedAssignmentCount: liveRows.length,
        cancelledFutureAssignmentCount: futureRows.length,
        openShiftsRemaining,
        groupId
      }
    });

    return {
      siteId,
      finishedAt: updated.finishedAt!.toISOString(),
      closedAssignmentCount: liveRows.length,
      cancelledFutureAssignmentCount: futureRows.length,
      openShiftsRemaining,
      groupId
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// reopenSite (§3.8 — "Восстановить объект")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type ReopenSiteError = { code: 'SITE_NOT_FOUND' } | { code: 'NOT_FINISHED' };

export async function reopenSite(input: FinishSiteInput): Promise<{ siteId: string } | ReopenSiteError> {
  const { siteId, actorUserId, requestId } = input;
  return prisma.$transaction(async (tx) => {
    await acquireSiteLifecycleLock(tx, siteId);
    const site = await tx.workSite.findUnique({ where: { id: siteId }, select: { id: true, active: true, finishedAt: true, version: true } });
    if (!site) {
      return { code: 'SITE_NOT_FOUND' as const };
    }
    if (site.finishedAt === null && site.active) {
      return { code: 'NOT_FINISHED' as const };
    }
    await tx.workSite.update({
      where: { id: siteId, version: site.version },
      data: { active: true, finishedAt: null, version: { increment: 1 } }
    });
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'SITE_REOPENED',
      entityType: 'WORK_SITE',
      entityId: siteId,
      requestId,
      beforeValue: { active: site.active, finishedAt: site.finishedAt ? site.finishedAt.toISOString() : null },
      // Assignments are NOT revived — the admin must assign workers again.
      afterValue: { active: true, finishedAt: null, assignmentsRevived: false }
    });
    return { siteId };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// disableCustomer (§3.9)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface DisableCustomerPreview {
  workAreaId: string;
  customerName: string;
  siteId: string;
  siteName: string;
  alreadyDisabled: boolean;
  assignedCount: number;
  workingNowCount: number;
  futureAssignmentsCount: number;
  workers: AffectedWorker[];
  futureWorkers: AffectedWorker[];
  /** Other active customers of the same site — targets for the (Deploy E) group transfer option. */
  otherActiveCustomers: { id: string; name: string }[];
}

export async function disableCustomerPreview(workAreaId: string): Promise<DisableCustomerPreview | null> {
  const today = helsinkiToday();
  const area = await prisma.workArea.findUnique({
    where: { id: workAreaId },
    select: { id: true, name: true, active: true, site: { select: { id: true, name: true } } }
  });
  if (!area) {
    return null;
  }
  const { live, future } = await loadAffected({ workAreaId }, today);
  const others = await prisma.workArea.findMany({
    where: { siteId: area.site.id, active: true, id: { not: workAreaId } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true }
  });
  return {
    workAreaId: area.id,
    customerName: area.name,
    siteId: area.site.id,
    siteName: area.site.name,
    alreadyDisabled: !area.active,
    assignedCount: live.length,
    workingNowCount: live.filter((w) => w.workingNow).length,
    futureAssignmentsCount: future.length,
    workers: live,
    futureWorkers: future,
    otherActiveCustomers: others
  };
}

export type DisableCustomerDecision = 'LEAVE_ON_SITE_NO_CUSTOMER' | 'REMOVE_WORKERS';

export interface DisableCustomerInput {
  workAreaId: string;
  /** Required when live/future assignments exist; ignored otherwise. */
  decision?: DisableCustomerDecision;
  actorUserId: string;
  requestId: string;
}

export type DisableCustomerError =
  | { code: 'CUSTOMER_NOT_FOUND' }
  | { code: 'ALREADY_DISABLED' }
  | { code: 'DECISION_REQUIRED'; preview: DisableCustomerPreview };

export interface DisableCustomerResult {
  workAreaId: string;
  decision: DisableCustomerDecision | 'NO_WORKERS';
  affectedCount: number;
  groupId: string;
}

/**
 * §3.9 — a customer with live/future assignments cannot be silently disabled. The admin makes an
 * explicit decision for ALL of them at once: leave each worker on the SITE with no customer
 * (`changeWorkplace`-style close + reopen a workAreaId=null assignment), or remove each worker from
 * the site (`removeFromSite`-style close). Transferring them to ANOTHER customer of the same site
 * is the Deploy E group transfer (`otherActiveCustomers` is surfaced in the preview for it).
 */
export async function disableCustomer(input: DisableCustomerInput): Promise<DisableCustomerResult | DisableCustomerError> {
  const { workAreaId, actorUserId, requestId } = input;
  const now = new Date();
  const today = helsinkiToday();

  const area = await prisma.workArea.findUnique({ where: { id: workAreaId }, select: { id: true, name: true, active: true, siteId: true, version: true } });
  if (!area) {
    return { code: 'CUSTOMER_NOT_FOUND' };
  }
  if (!area.active) {
    return { code: 'ALREADY_DISABLED' };
  }

  const preview = await disableCustomerPreview(workAreaId);
  const affected = [...(preview?.workers ?? []), ...(preview?.futureWorkers ?? [])];
  if (affected.length > 0 && !input.decision) {
    return { code: 'DECISION_REQUIRED', preview: preview! };
  }

  return prisma.$transaction(async (tx) => {
    await acquireSiteLifecycleLock(tx, workAreaId);

    const locked = await tx.workArea.findUnique({ where: { id: workAreaId }, select: { active: true, version: true, name: true, siteId: true } });
    if (!locked) {
      return { code: 'CUSTOMER_NOT_FOUND' as const };
    }
    if (!locked.active) {
      return { code: 'ALREADY_DISABLED' as const };
    }

    const groupId = randomUUID();
    const reasonText = `Заказчик «${locked.name}» отключён`;

    // live + future assignments still pointing at this customer
    const rows = await tx.siteAssignment.findMany({
      where: {
        workAreaId,
        clockInDisabledAt: null,
        OR: [
          { AND: [{ validFrom: { lte: today } }, { OR: [{ validTo: null }, { validTo: { gte: today } }] }] },
          { validFrom: { gt: today } }
        ]
      },
      select: { id: true, employeeId: true, validFrom: true, validTo: true, templateVersionId: true, isPrimary: true }
    });

    let affectedCount = 0;
    for (const a of rows) {
      const isFuture = a.validFrom > today;
      const boundary = isFuture ? a.validFrom : today;

      if (input.decision === 'LEAVE_ON_SITE_NO_CUSTOMER' && !isFuture) {
        // close the current row today, open a fully-materialised replacement on the same site with
        // no customer from tomorrow (the two periods stay disjoint). createAssignmentInTx backfills
        // PayrollPeriodParticipant / Timesheet(DRAFT) / TimesheetDraftPlannedShift like changeWorkplace.
        await acquireEmployeeLifecycleLock(tx, a.employeeId);
        await tx.timesheetDraftPlannedShift.deleteMany({ where: { sourceAssignmentId: a.id, date: { gt: today } } });
        await tx.siteAssignment.update({
          where: { id: a.id },
          data: { clockInDisabledAt: now, isPrimary: false, validTo: today, endedReason: reasonText, version: { increment: 1 } }
        });
        const nextDay = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        const mkReplacement = (isPrimary: boolean) =>
          createAssignmentInTx(tx, {
            employeeId: a.employeeId,
            siteId: locked.siteId,
            workAreaId: null,
            templateVersionId: a.templateVersionId,
            validFrom: nextDay,
            validTo: a.validTo,
            isPrimary,
            assignedByUserId: actorUserId
          });
        // Keep the replacement primary when the old row was — unless a scheduled future primary
        // transfer already covers that period (§P4), in which case the plan wins and the
        // stay-on-site row is non-primary.
        let replacement;
        try {
          ({ assignment: replacement } = await mkReplacement(a.isPrimary));
        } catch (e) {
          if (a.isPrimary && e instanceof ScheduledPrimaryConflictError) {
            ({ assignment: replacement } = await mkReplacement(false));
          } else {
            throw e;
          }
        }
        await recordAssignmentTransition(tx, {
          employeeId: a.employeeId,
          kind: 'CUSTOMER_DISABLE',
          fromAssignmentId: a.id,
          toAssignmentId: replacement.id,
          actedAt: now,
          effectiveFrom: nextDay,
          openShiftHandling: 'NONE',
          actorUserId,
          groupId,
          reasonCode: 'TRANSFER',
          reasonText: `${reasonText} — работник оставлен на объекте без заказчика`
        });
      } else {
        // REMOVE_WORKERS, or a future assignment under either decision → operational close / cancel
        await tx.timesheetDraftPlannedShift.deleteMany({ where: { sourceAssignmentId: a.id, date: { gt: isFuture ? a.validFrom : today } } });
        await tx.siteAssignment.update({
          where: { id: a.id },
          data: {
            clockInDisabledAt: now,
            validTo: isFuture ? a.validFrom : today,
            endedReason: reasonText,
            version: { increment: 1 }
          }
        });
        await recordAssignmentTransition(tx, {
          employeeId: a.employeeId,
          kind: 'CUSTOMER_DISABLE',
          fromAssignmentId: a.id,
          toAssignmentId: null,
          actedAt: now,
          effectiveFrom: boundary,
          openShiftHandling: 'NONE',
          actorUserId,
          groupId,
          reasonCode: input.decision === 'REMOVE_WORKERS' ? 'PROJECT_DONE' : 'TRANSFER',
          reasonText
        });
      }
      affectedCount += 1;
    }

    await tx.workArea.update({
      where: { id: workAreaId, version: locked.version },
      data: { active: false, version: { increment: 1 } }
    });

    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'CUSTOMER_DISABLED',
      entityType: 'WORK_AREA',
      entityId: workAreaId,
      requestId,
      beforeValue: { active: true },
      afterValue: {
        active: false,
        decision: input.decision ?? 'NO_WORKERS',
        affectedCount,
        groupId
      }
    });

    return {
      workAreaId,
      decision: input.decision ?? ('NO_WORKERS' as const),
      affectedCount,
      groupId
    };
  });
}

export type EnableCustomerError = { code: 'CUSTOMER_NOT_FOUND' } | { code: 'NOT_DISABLED' } | { code: 'SITE_FINISHED' };

export async function enableCustomer(input: { workAreaId: string; actorUserId: string; requestId: string }): Promise<{ workAreaId: string } | EnableCustomerError> {
  const { workAreaId, actorUserId, requestId } = input;
  return prisma.$transaction(async (tx) => {
    await acquireSiteLifecycleLock(tx, workAreaId);
    const area = await tx.workArea.findUnique({
      where: { id: workAreaId },
      select: { active: true, version: true, site: { select: { active: true, finishedAt: true } } }
    });
    if (!area) {
      return { code: 'CUSTOMER_NOT_FOUND' as const };
    }
    if (area.active) {
      return { code: 'NOT_DISABLED' as const };
    }
    if (area.site.finishedAt !== null || !area.site.active) {
      return { code: 'SITE_FINISHED' as const };
    }
    await tx.workArea.update({ where: { id: workAreaId, version: area.version }, data: { active: true, version: { increment: 1 } } });
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'CUSTOMER_ENABLED',
      entityType: 'WORK_AREA',
      entityId: workAreaId,
      requestId,
      beforeValue: { active: false },
      afterValue: { active: true, assignmentsRevived: false }
    });
    return { workAreaId };
  });
}

