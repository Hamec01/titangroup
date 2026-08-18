import { randomUUID } from 'node:crypto';
import { Prisma, SubmissionSource } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { helsinkiWallClockToUtc } from '@/lib/periods';
import { periodEndExclusive } from '@/lib/attendance-materializer';
import { submitWorkerTimesheetCore } from '@/lib/worker-timesheets';

// T7A.10A follow-up (2026-08-18) — fixes a manual-submit race and a SYSTEM-lookup accounting
// inaccuracy found after the initial T7A.10A slice; see the addendum section of this same name in
// T7A_1_ATTENDANCE_CLOCK_DESIGN.md for the full root-cause writeup.

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §8/§9.5/§9.6 + Addendum "T7A.10A" — T7A.10A.
// Auto-submit service core. Two-phase pattern, same architecture as
// lib/attendance-materializer.ts's runMaterializerCatchUpPass: a cheap, unlocked read-only scan
// (never opens a transaction), then one independent BEGIN...COMMIT per candidate — one candidate's
// failure never rolls back another's already-committed work. No cron/scheduler wiring here (T7A.10B).

const RESOLVED_LATE_CHECKOUT_NOTE = 'resolved by real check-out arriving late';

// ---------------------------------------------------------------------------------------------
// SYSTEM actor — same fail-closed shape check as lib/worker-timesheets.ts's own LATE_SYNC_AFTER_
// SUBMIT resolution (§13). Two distinct callers of this same fail-closed lookup:
//   - resolveMissingCheckoutAtCutoffOnLateCheckOut (below) — outside any scheduler tick entirely
//     (a real Check Out event), always a fresh lookup in its own transaction, never cached.
//   - runAttendanceAutoSubmitTick's branch (i) — wrapped by a tick-scoped lazy cache (see
//     getSystemActorId inside runAttendanceAutoSubmitTick) so only the first submitting candidate
//     of a tick pays this SELECT; later candidates in the same tick reuse the validated id.
// A tick whose candidates never reach branch (i) never calls this at all.
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

// T7A.10A follow-up — dueAt must be derived from systemReopenGeneration, never from the current
// Timesheet.status. The original version keyed this off status (DRAFT vs RETURNED), re-read fresh
// under the Timesheet lock — but status is exactly the field a concurrent manual submit changes: if
// manual submit wins the race, fresh.status becomes SUBMITTED, which is neither DRAFT nor RETURNED,
// and there is no correct branch for it in a status-keyed formula (a naive `as 'DRAFT'|'RETURNED'`
// cast used to route it into the RETURNED branch, which then dereferenced a null systemReopenAt on
// a genuine generation-0 candidate and threw). generation is never touched by a submit of any kind
// (manual or auto) — only §9.5's reopen step increments it — so it is racer-independent by
// construction; whether this candidate is due is a question about "how long since generation N
// started", not "what is the status right now".
function computeDueAt(systemReopenGeneration: number, periodEndDate: Date, systemReopenAt: Date | null, policy: PolicySnapshot): Date {
  if (systemReopenGeneration === 0) {
    return helsinkiWallClockToUtc(addDays(periodEndDate, policy.cutoffDaysAfterPeriodEnd), policy.cutoffTime);
  }
  if (systemReopenAt === null) {
    // Structurally unreachable under the design's own invariant (§9.5 step 2 always sets
    // systemReopenAt in the same transition that increments systemReopenGeneration) — if it ever
    // happens, this is an internal bug, not a recoverable state. Throwing here (inside the
    // candidate's own transaction, or before it opens for the cheap pre-lock call) rolls back any
    // work already done for this candidate and marks it `failed`, retryable by the next tick —
    // never silently proceeds with a fabricated dueAt.
    throw new Error(`AUTO_SUBMIT_GENERATION_WITHOUT_REOPEN_AT:${systemReopenGeneration}`);
  }
  return new Date(systemReopenAt.getTime() + policy.systemReopenDebounceMinutes * 60000);
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

async function processCandidate(
  candidate: AutoSubmitCandidate,
  policy: PolicySnapshot,
  now: Date,
  requestId: string,
  getSystemActorId: (tx: Prisma.TransactionClient) => Promise<string>
): Promise<CandidateOutcome> {
  const period = await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: candidate.periodId }, select: { endDate: true } });
  const candidateGeneration = candidate.systemReopenGeneration;
  const cheapDueAt = computeDueAt(candidateGeneration, period.endDate, candidate.systemReopenAt, policy);

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

    // dueAt is a function of fresh.systemReopenGeneration (confirmed == candidateGeneration by (e)
    // above), never of fresh.status — status is exactly what a concurrent manual submit changes,
    // and generation is untouched by any submit. No type assertion on fresh.status here: it is
    // read as Prisma's real TimesheetStatus union, and step (g) below handles every value that
    // isn't DRAFT/RETURNED on its own terms instead of assuming the field can only be one of two.
    const dueAt = computeDueAt(fresh.systemReopenGeneration, period.endDate, fresh.systemReopenAt, policy);

    // (f) confirmed-current generation, but its due moment hasn't arrived under the lock.
    if (now < dueAt) {
      return { kind: 'NOT_YET_DUE_UNDER_LOCK' };
    }

    // (g) already submitted — manual submit or another scheduler worker won the race. Covers every
    // status other than DRAFT/RETURNED (SUBMITTED, FOREMAN_APPROVED, FINAL_APPROVED, ...) — not
    // just SUBMITTED specifically, since any of them means this candidate is no longer actionable
    // by auto-submit regardless of which one it landed on.
    if (fresh.status !== 'DRAFT' && fresh.status !== 'RETURNED') {
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

    // (i) real submission — confirmed due, confirmed DRAFT/RETURNED+SYSTEM_LATE_SYNC_REOPEN under
    // lock. getSystemActorId is the tick-scoped lazy cache (see runAttendanceAutoSubmitTick below)
    // — only the first submitting candidate of this tick actually pays the SELECT; every later one
    // reuses the validated id with zero extra queries.
    const systemActorId = await getSystemActorId(tx);

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
    // validatedSystemActorId reuses the id just resolved above for submitWorkerTimesheetCore's own
    // internal LATE_SYNC_AFTER_SUBMIT resolution step (§9.5) instead of a second, redundant lookup
    // of the same row inside the same transaction.
    const version = await submitWorkerTimesheetCore(tx, fresh.employeeId, candidate.id, systemActorId, requestId, SubmissionSource.AUTO, {
      validatedSystemActorId: systemActorId
    });

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

  // Tick-scoped lazy SYSTEM actor cache — T7A.10A follow-up. Plain closure variable, never a
  // module-global and never carried between ticks (a fresh runAttendanceAutoSubmitTick call always
  // starts with an empty cache, scoped only to this function invocation). The first candidate that
  // actually reaches branch (i) validates the SYSTEM actor's shape once and caches the id; every
  // later submitting candidate in this same tick reuses it with zero additional SELECTs. A tick
  // whose candidates never reach branch (i) — e.g. a replay tick where every candidate already has
  // an AutoSubmissionAttempt and short-circuits at NOOP_EXISTING before any transaction opens —
  // never resolves the SYSTEM actor at all. Only successful resolutions are cached: if the lookup
  // throws (actor missing/malformed), the cache stays empty and the next candidate that needs it
  // retries fresh, so a transient/mid-tick fix is still picked up within the same tick.
  let cachedSystemActorId: string | null = null;
  async function getSystemActorId(tx: Prisma.TransactionClient): Promise<string> {
    if (cachedSystemActorId !== null) {
      return cachedSystemActorId;
    }
    const resolved = await resolveSystemActorId(tx);
    cachedSystemActorId = resolved;
    return resolved;
  }

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
      outcome = await processCandidate(candidate, policy, now, requestId, getSystemActorId);
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
