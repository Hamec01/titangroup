// docs/titanor-time/T8_REPORTS_DESIGN.md §1 — the single canonical-source rule shared by every T8
// report (T8.1's lib/worker-time-report.ts, T8.2's lib/site-time-report.ts, T8.3's
// lib/period-time-report.ts): `Timesheet.status` alone decides whether a report reads
// `TimesheetDraft` (DRAFT/RETURNED) or the immutable `TimesheetVersion` at `currentVersionId`
// (SUBMITTED/FOREMAN_APPROVED/FINAL_APPROVED) — never both, never a fallback. Pure — zero Prisma
// imports, zero I/O. Callers pass in whatever they already selected from a Timesheet row and get
// back which source to read plus the version/submission metadata every report's DTO already
// exposes; callers still run their own segment query using `draftId`/`versionId` from the result.

export type TimesheetDataSource = 'DRAFT' | 'CURRENT_VERSION';

export interface CanonicalSourceTimesheetInput {
  /** Timesheet.id — used only to name the invariant-failure error, never returned. */
  id: string;
  status: string;
  currentVersionId: string | null;
  draft: { id: string } | null;
  currentVersion: { versionNumber: number; submissionSource: string | null } | null;
}

export interface CanonicalSourceIdentity {
  dataSource: TimesheetDataSource;
  versionNumber: number | null;
  submissionSource: string | null;
  /** Set when dataSource is 'DRAFT' — the id to query TimesheetDraftSegment/TimesheetDraftDay by. */
  draftId: string | null;
  /** Set when dataSource is 'CURRENT_VERSION' — the id to query WorkSegment/TimesheetDay by. */
  versionId: string | null;
}

/** DRAFT/RETURNED read the draft; SUBMITTED/FOREMAN_APPROVED/FINAL_APPROVED read the immutable
 * current version. A RETURNED timesheet still carries a stale `currentVersionId` pointing at an
 * old version — this function is the one place that decision is made, so every report agrees. */
export function usesDraftSource(status: string): boolean {
  return status === 'DRAFT' || status === 'RETURNED';
}

/**
 * Resolves which source a Timesheet's current status must be read from, and validates the
 * corresponding row is actually present. Throws (never returns a partial/zero identity) if the
 * required draft/currentVersion is missing — every report must let this propagate as an uncaught
 * 500, never a silently-empty or silently-wrong report for that employee/timesheet.
 *
 * A PENDING correction never touches `currentVersionId` — only an approved correction updates it,
 * atomically with creating the new TimesheetVersion — so reading `currentVersionId` directly here
 * (as every caller already does) already gives the correct behavior for both cases without any
 * correction-specific branching in this helper.
 */
export function resolveCanonicalSource(input: CanonicalSourceTimesheetInput): CanonicalSourceIdentity {
  if (usesDraftSource(input.status)) {
    if (!input.draft) {
      throw new Error(`REPORT_CANONICAL_SOURCE_INVARIANT_FAILURE: timesheet ${input.id} has status ${input.status} but no TimesheetDraft`);
    }
    return { dataSource: 'DRAFT', versionNumber: null, submissionSource: null, draftId: input.draft.id, versionId: null };
  }
  if (!input.currentVersionId || !input.currentVersion) {
    throw new Error(`REPORT_CANONICAL_SOURCE_INVARIANT_FAILURE: timesheet ${input.id} has status ${input.status} but no currentVersionId`);
  }
  return { dataSource: 'CURRENT_VERSION', versionNumber: input.currentVersion.versionNumber, submissionSource: input.currentVersion.submissionSource, draftId: null, versionId: input.currentVersionId };
}
