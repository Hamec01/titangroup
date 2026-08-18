import { randomUUID } from 'node:crypto';
import { Prisma, SubmissionSource } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { helsinkiWallClockToUtc } from '@/lib/periods';
import { periodEndExclusive } from '@/lib/attendance-materializer';
import { submitWorkerTimesheetCore } from '@/lib/worker-timesheets';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §8/§9.5/§9.6 + Addendum "T7A.10A" — T7A.10A.
// Auto-submit service core. Two-phase pattern, same architecture as
// lib/attendance-materializer.ts's runMaterializerCatchUpPass: a cheap, unlocked read-only scan
// (never opens a transaction), then one independent BEGIN...COMMIT per candidate — one candidate's
// failure never rolls back another's already-committed work. No cron/scheduler wiring here (T7A.10B).

const RESOLVED_LATE_CHECKOUT_NOTE = 'resolved by real check-out arriving late';

// ---------------------------------------------------------------------------------------------
// SYSTEM actor — same fail-closed shape check as lib/worker-timesheets.ts's own LATE_SYNC_AFTER_
// SUBMIT resolution (§13). Looked up fresh inside whichever transaction actually needs it — never
// unconditionally for every candidate (only branch (i)'s real submission, and only when a late
// real Check Out actually finds an OPEN MISSING_CHECKOUT_AT_CUTOFF to resolve) — this is what keeps
// the tick's query count from growing with candidates that don't reach either of those.
// ---------------------------------------------------------------------------------------------

async function resolveSystemActorId(tx: Prisma.TransactionClient): Promise<string> {
  const systemActor = await tx.user.findFirst({
    where: { userKind: 'SYSTEM', username: 'system.scheduler' },
    select: { id: true, status: true, passwordHash: true, employeeId: true }
  });
  if (!systemActor || systemActor.status !== 'DEACTIVATED' || systemActor.passwordHash !== null || systemActor.employeeId !== null) {
    throw new Error('SYSTEM_SCHEDULER_ACTOR_MISSING_OR_INVALID');
  }
  return systemActor.id;
}

// ---------------------------------------------------------------------------------------------
// Late real Check Out — resolves MISSING_CHECKOUT_AT_CUTOFF (§9.6 "Автоматическое разрешение при
// позднем реальном Check Out"). Called by both online (lib/attendance-clock.ts) and offline
// (lib/attendance-sync.ts) Check Out paths, in the same transaction, immediately after the
// EmployeeOpenShift row that opened the shift is deleted. Never called on a replay (both callers'
// replay branches return before reaching the EmployeeOpenShift-delete step at all), so this never
// re-resolves an already-RESOLVED row on a duplicate delivery.
// ---------------------------------------------------------------------------------------------

export async function resolveMissingCheckoutAtCutoffOnLateCheckOut(tx: Prisma.TransactionClient, openedByClockEventId: string): Promise<void> {
  const openExceptions = await tx.attendanceException.findMany({
    where: { type: 'MISSING_CHECKOUT_AT_CUTOFF', clockEventId: openedByClockEventId, status: 'OPEN' },
    select: { id: true }
  });
  if (openExceptions.length === 0) {
    return;
  }
  const systemActorId = await resolveSystemActorId(tx);
  await tx.attendanceException.updateMany({
    where: { id: { in: openExceptions.map((e) => e.id) } },
    data: { status: 'RESOLVED', resolvedByUserId: systemActorId, resolvedAt: new Date(), resolutionNote: RESOLVED_LATE_CHECKOUT_NOTE }
  });
}

// ---------------------------------------------------------------------------------------------
// dueAt — Addendum "T7A.10A" §A / §9.6 step 2.
// ---------------------------------------------------------------------------------------------

function addDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

interface PolicySnapshot {
  cutoffDaysAfterPeriodEnd: number;
  cutoffTime: Date;
  systemReopenDebounceMinutes: number;
}

function computeDueAt(status: 'DRAFT' | 'RETURNED', periodEndDate: Date, systemReopenAt: Date | null, policy: PolicySnapshot): Date {
  if (status === 'DRAFT') {
    return helsinkiWallClockToUtc(addDays(periodEndDate, policy.cutoffDaysAfterPeriodEnd), policy.cutoffTime);
  }
  // RETURNED + SYSTEM_LATE_SYNC_REOPEN — systemReopenAt is always set by the time a Timesheet
  // reaches this branch (§9.5 step 2 sets it in the same transition that sets lastReturnedReason).
  return new Date(systemReopenAt!.getTime() + policy.systemReopenDebounceMinutes * 60000);
}

// ---------------------------------------------------------------------------------------------
// Candidate scan (§9.6 "Кандидат scan") — HUMAN_REVIEW_RETURN excluded from the query itself, not
// filtered after reading.
// ---------------------------------------------------------------------------------------------

interface AutoSubmitCandidate {
  id: string;
  employeeId: string;
  periodId: string;
  status: 'DRAFT' | 'RETURNED';
  lastReturnedReason: 'HUMAN_REVIEW_RETURN' | 'SYSTEM_LATE_SYNC_REOPEN' | null;
  systemReopenGeneration: number;
  systemReopenAt: Date | null;
}

async function scanAutoSubmitCandidates(): Promise<AutoSubmitCandidate[]> {
  const rows = await prisma.timesheet.findMany({
    where: { OR: [{ status: 'DRAFT' }, { status: 'RETURNED', lastReturnedReason: 'SYSTEM_LATE_SYNC_REOPEN' }] },
    select: { id: true, employeeId: true, periodId: true, status: true, lastReturnedReason: true, systemReopenGeneration: true, systemReopenAt: true }
  });
  return rows as AutoSubmitCandidate[];
}

// ---------------------------------------------------------------------------------------------
// AutoSubmissionAttempt insert — raw SQL, ON CONFLICT (timesheetId, systemReopenGeneration) DO
// NOTHING RETURNING id. Never a try/catch around a plain INSERT that could abort the transaction —
// ON CONFLICT DO NOTHING is not an error in PostgreSQL (§9.6 "Postgres-семантика").
// ---------------------------------------------------------------------------------------------

async function insertAutoSubmissionAttempt(
  tx: Prisma.TransactionClient,
  timesheetId: string,
  systemReopenGeneration: number,
  cutoffAt: Date,
  result: 'SUBMITTED_CLEAN' | 'SUBMITTED_WITH_EXCEPTIONS' | 'SKIPPED_ALREADY_SUBMITTED' | 'SKIPPED_NOT_ACTIONABLE',
  resultingVersionId: string | null
): Promise<{ id: string } | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "AutoSubmissionAttempt" (id, "timesheetId", "cutoffAt", "systemReopenGeneration", "result", "resultingVersionId")
    VALUES (gen_random_uuid(), ${timesheetId}::uuid, ${cutoffAt}, ${systemReopenGeneration}, ${result}::"AutoSubmissionResult", ${resultingVersionId}::uuid)
    ON CONFLICT ("timesheetId", "systemReopenGeneration") DO NOTHING
    RETURNING id
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// MISSING_CHECKOUT_AT_CUTOFF insert — raw SQL, ON CONFLICT on the partial unique index
// ux_attendance_exception_missing_checkout_dedup(clockEventId, payrollPeriodId) WHERE
// type='MISSING_CHECKOUT_AT_CUTOFF'. Never invents an endAt, never materializes the open shift.
// ---------------------------------------------------------------------------------------------

async function insertMissingCheckoutException(
  tx: Prisma.TransactionClient,
  params: { employeeId: string; timesheetId: string; payrollPeriodId: string; siteId: string; clockEventId: string; occurredAt: Date }
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "AttendanceException" (id, type, "employeeId", "timesheetId", "payrollPeriodId", "siteId", "clockEventId", "occurredAt", status)
    VALUES (gen_random_uuid(), 'MISSING_CHECKOUT_AT_CUTOFF'::"AttendanceExceptionType", ${params.employeeId}::uuid, ${params.timesheetId}::uuid, ${params.payrollPeriodId}::uuid, ${params.siteId}::uuid, ${params.clockEventId}::uuid, ${params.occurredAt}, 'OPEN'::"AttendanceExceptionStatus")
    ON CONFLICT ("clockEventId", "payrollPeriodId") WHERE type = 'MISSING_CHECKOUT_AT_CUTOFF'
    DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Per-candidate transaction (§9.6 step 6, branches a–i).
// ---------------------------------------------------------------------------------------------

type CandidateOutcome =
  | { kind: 'NOT_DUE' } // step 3 — transaction never opened
  | { kind: 'NOOP_EXISTING' } // step 5 — cheap existing-attempt check, transaction never opened
  | { kind: 'STALE_GENERATION' } // branch (e) — COMMIT, zero rows written
  | { kind: 'NOT_YET_DUE_UNDER_LOCK' } // branch (f) — COMMIT, zero rows written
  | { kind: 'SKIPPED_ALREADY_SUBMITTED' } // branch (g)
  | { kind: 'SKIPPED_NOT_ACTIONABLE' } // branch (h)
  | { kind: 'SUBMITTED_CLEAN' } // branch (i)
  | { kind: 'SUBMITTED_WITH_EXCEPTIONS' }; // branch (i)

async function processCandidate(candidate: AutoSubmitCandidate, policy: PolicySnapshot, now: Date, requestId: string): Promise<CandidateOutcome> {
  const period = await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: candidate.periodId }, select: { endDate: true } });
  const candidateGeneration = candidate.systemReopenGeneration;
  const cheapDueAt = computeDueAt(candidate.status, period.endDate, candidate.systemReopenAt, policy);

  // Step 3 — full no-op, transaction never opens.
  if (now < cheapDueAt) {
    return { kind: 'NOT_DUE' };
  }

  // Step 4/5 — cheap, unlocked existing-attempt check.
  const existing = await prisma.autoSubmissionAttempt.findUnique({
    where: { timesheetId_systemReopenGeneration: { timesheetId: candidate.id, systemReopenGeneration: candidateGeneration } },
    select: { id: true }
  });
  if (existing) {
    return { kind: 'NOOP_EXISTING' };
  }

  return prisma.$transaction(async (tx): Promise<CandidateOutcome> => {
    // (a) Employee FOR UPDATE.
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${candidate.employeeId}::uuid FOR UPDATE`;
    // (b) EmployeeOpenShift FOR UPDATE — canonical order position 3, taken here (before Timesheet)
    // regardless of which branch this candidate ends up in; only branch (i) actually reads it.
    await tx.$queryRaw`SELECT "employeeId" FROM "EmployeeOpenShift" WHERE "employeeId" = ${candidate.employeeId}::uuid FOR UPDATE`;
    const openShift = await tx.employeeOpenShift.findUnique({ where: { employeeId: candidate.employeeId } });
    // (c) Timesheet FOR UPDATE.
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${candidate.id}::uuid FOR UPDATE`;
    // (d) re-read everything under the lock.
    const fresh = await tx.timesheet.findUniqueOrThrow({
      where: { id: candidate.id },
      select: { status: true, lastReturnedReason: true, systemReopenGeneration: true, systemReopenAt: true, employeeId: true, periodId: true }
    });

    // (e) stale generation — a reopen happened between the cheap read and this lock.
    if (fresh.systemReopenGeneration !== candidateGeneration) {
      return { kind: 'STALE_GENERATION' };
    }

    const dueAt = computeDueAt(fresh.status as 'DRAFT' | 'RETURNED', period.endDate, fresh.systemReopenAt, policy);

    // (f) confirmed-current generation, but its due moment hasn't arrived under the lock.
    if (now < dueAt) {
      return { kind: 'NOT_YET_DUE_UNDER_LOCK' };
    }

    // (g) already submitted — manual submit or another scheduler worker won the race.
    if (fresh.status !== 'DRAFT' && (fresh.status as string) !== 'RETURNED') {
      await insertAutoSubmissionAttempt(tx, candidate.id, candidateGeneration, dueAt, 'SKIPPED_ALREADY_SUBMITTED', null);
      return { kind: 'SKIPPED_ALREADY_SUBMITTED' };
    }

    // (h) confirmed-current generation, RETURNED, but a human returned it in the narrow stale-read
    // race window (candidate scan excludes HUMAN_REVIEW_RETURN at the query level — this is the
    // one place it can still surface, per §9.6).
    if (fresh.status === 'RETURNED' && fresh.lastReturnedReason === 'HUMAN_REVIEW_RETURN') {
      await insertAutoSubmissionAttempt(tx, candidate.id, candidateGeneration, dueAt, 'SKIPPED_NOT_ACTIONABLE', null);
      return { kind: 'SKIPPED_NOT_ACTIONABLE' };
    }

    // (i) real submission — confirmed due, confirmed DRAFT/RETURNED+SYSTEM_LATE_SYNC_REOPEN under lock.
    const systemActorId = await resolveSystemActorId(tx);

    if (openShift && openShift.openedAt < periodEndExclusive(period)) {
      await insertMissingCheckoutException(tx, {
        employeeId: fresh.employeeId,
        timesheetId: candidate.id,
        payrollPeriodId: fresh.periodId,
        siteId: openShift.siteId,
        clockEventId: openShift.openedByClockEventId,
        occurredAt: openShift.openedAt
      });
    }

    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE "timesheetId" = ${candidate.id}::uuid FOR UPDATE`;
    const version = await submitWorkerTimesheetCore(tx, fresh.employeeId, candidate.id, systemActorId, requestId, SubmissionSource.AUTO);

    const hasBlocking = await tx.attendanceException.findFirst({
      where: { employeeId: fresh.employeeId, payrollPeriodId: fresh.periodId, status: 'OPEN' },
      select: { id: true }
    });
    const result = hasBlocking ? 'SUBMITTED_WITH_EXCEPTIONS' : 'SUBMITTED_CLEAN';

    const attempt = await insertAutoSubmissionAttempt(tx, candidate.id, candidateGeneration, dueAt, result, version.versionId);
    if (!attempt) {
      // Structurally unreachable given the locking discipline above (Timesheet FOR UPDATE already
      // serializes every concurrent writer of this generation) — if it ever happens, this is an
      // internal bug, not a recoverable state; roll back everything (including the version) rather
      // than silently proceeding without a durable attempt record.
      throw new Error(`AUTO_SUBMISSION_ATTEMPT_INSERT_UNEXPECTEDLY_EMPTY:${candidate.id}:${candidateGeneration}`);
    }

    return { kind: result };
  });
}

// ---------------------------------------------------------------------------------------------
// Tick entry point — Addendum "T7A.10A" §C/§D.
// ---------------------------------------------------------------------------------------------

export interface AttendanceAutoSubmitTickResult {
  scanned: number;
  due: number;
  submittedClean: number;
  submittedWithExceptions: number;
  skippedAlreadySubmitted: number;
  skippedNotActionable: number;
  noop: number;
  failed: number;
  failedTimesheetIds: string[];
}

export interface AttendanceAutoSubmitTickInput {
  /** Injectable for tests — production CLI always passes real system time; never accept an
   * override from HTTP or any user-facing surface. */
  now: Date;
}

export async function runAttendanceAutoSubmitTick(input: AttendanceAutoSubmitTickInput): Promise<AttendanceAutoSubmitTickResult> {
  const { now } = input;
  const requestId = randomUUID();

  // Singleton policy — read once per tick, never per candidate (keeps the tick's query count from
  // growing with the number of candidates).
  const policyRow = await prisma.companyAttendancePolicy.findUniqueOrThrow({
    where: { singleton: true },
    select: { cutoffDaysAfterPeriodEnd: true, cutoffTime: true, systemReopenDebounceMinutes: true }
  });
  const policy: PolicySnapshot = {
    cutoffDaysAfterPeriodEnd: policyRow.cutoffDaysAfterPeriodEnd,
    cutoffTime: policyRow.cutoffTime,
    systemReopenDebounceMinutes: policyRow.systemReopenDebounceMinutes
  };

  const candidates = await scanAutoSubmitCandidates();

  const result: AttendanceAutoSubmitTickResult = {
    scanned: candidates.length,
    due: 0,
    submittedClean: 0,
    submittedWithExceptions: 0,
    skippedAlreadySubmitted: 0,
    skippedNotActionable: 0,
    noop: 0,
    failed: 0,
    failedTimesheetIds: []
  };

  for (const candidate of candidates) {
    let outcome: CandidateOutcome;
    try {
      outcome = await processCandidate(candidate, policy, now, requestId);
    } catch {
      // Retryable — no AutoSubmissionAttempt row was written for this (timesheetId, generation),
      // so the next tick's candidate scan/existing-attempt check will pick this timesheet up again
      // naturally. Never leaks the underlying error message here (CLI stdout PII contract, §E).
      result.failed += 1;
      result.failedTimesheetIds.push(candidate.id);
      continue;
    }

    switch (outcome.kind) {
      case 'NOT_DUE':
        break;
      case 'NOOP_EXISTING':
      case 'STALE_GENERATION':
      case 'NOT_YET_DUE_UNDER_LOCK':
        result.due += 1;
        result.noop += 1;
        break;
      case 'SKIPPED_ALREADY_SUBMITTED':
        result.due += 1;
        result.skippedAlreadySubmitted += 1;
        break;
      case 'SKIPPED_NOT_ACTIONABLE':
        result.due += 1;
        result.skippedNotActionable += 1;
        break;
      case 'SUBMITTED_CLEAN':
        result.due += 1;
        result.submittedClean += 1;
        break;
      case 'SUBMITTED_WITH_EXCEPTIONS':
        result.due += 1;
        result.submittedWithExceptions += 1;
        break;
    }
  }

  return result;
}
