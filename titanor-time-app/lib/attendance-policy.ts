import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1 + Addendum "T7A.10A" §F —
// GET/PATCH /api/admin/attendance/policy. Route file owns auth/CSRF/permission/idempotency/HTTP
// mapping; this module owns validation, the transaction, and DTO shaping — same split as every
// other lib/*.ts in this project.

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const ALLOWED_PATCH_FIELDS = new Set([
  'cutoffDaysAfterPeriodEnd',
  'cutoffTime',
  'systemReopenDebounceMinutes',
  'maxShiftDurationHours',
  'maxGpsAccuracyMeters',
  'autoUnpaidBreakThresholdMinutes',
  'autoUnpaidBreakMinutes'
]);

export interface PolicyView {
  cutoffDaysAfterPeriodEnd: number;
  cutoffTime: string; // strict HH:mm:ss — a TIME column, not an ISO instant.
  systemReopenDebounceMinutes: number;
  maxShiftDurationHours: number;
  maxGpsAccuracyMeters: number;
  // T10-D — a worked day whose gross duration is at least this many minutes and that has no break
  // logged gets its planned (unpaid) lunch auto-deducted. 360 = Finnish 6 h norm; 0 = always.
  autoUnpaidBreakThresholdMinutes: number;
  // T10-D — fallback unpaid-lunch minutes used when the plan carries no break of its own (e.g. an
  // assignment with no schedule template). 30 = Finnish norm; 0 disables the fallback.
  autoUnpaidBreakMinutes: number;
  timezone: 'Europe/Helsinki'; // frozen at the DB level (ck_company_attendance_policy_timezone_frozen) — read-only.
  updatedAt: string;
  updatedByUserId: string | null;
}

/** Postgres TIME columns round-trip through Prisma as a Date with only the time-of-day portion
 * meaningful (date part is the epoch) — this reads that portion back as strict HH:mm:ss. */
function formatTimeOfDay(value: Date): string {
  const hh = String(value.getUTCHours()).padStart(2, '0');
  const mm = String(value.getUTCMinutes()).padStart(2, '0');
  const ss = String(value.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function parseTimeOfDay(value: string): Date {
  return new Date(`1970-01-01T${value}Z`);
}

interface PolicyRow {
  cutoffDaysAfterPeriodEnd: number;
  cutoffTime: Date;
  systemReopenDebounceMinutes: number;
  maxShiftDurationHours: number;
  maxGpsAccuracyMeters: number;
  autoUnpaidBreakThresholdMinutes: number;
  autoUnpaidBreakMinutes: number;
  updatedAt: Date;
  updatedByUserId: string | null;
}

const POLICY_SELECT = {
  cutoffDaysAfterPeriodEnd: true,
  cutoffTime: true,
  systemReopenDebounceMinutes: true,
  maxShiftDurationHours: true,
  maxGpsAccuracyMeters: true,
  autoUnpaidBreakThresholdMinutes: true,
  autoUnpaidBreakMinutes: true,
  updatedAt: true,
  updatedByUserId: true
} as const;

function toView(row: PolicyRow): PolicyView {
  return {
    cutoffDaysAfterPeriodEnd: row.cutoffDaysAfterPeriodEnd,
    cutoffTime: formatTimeOfDay(row.cutoffTime),
    systemReopenDebounceMinutes: row.systemReopenDebounceMinutes,
    maxShiftDurationHours: row.maxShiftDurationHours,
    maxGpsAccuracyMeters: row.maxGpsAccuracyMeters,
    autoUnpaidBreakThresholdMinutes: row.autoUnpaidBreakThresholdMinutes,
    autoUnpaidBreakMinutes: row.autoUnpaidBreakMinutes,
    timezone: 'Europe/Helsinki',
    updatedAt: row.updatedAt.toISOString(),
    updatedByUserId: row.updatedByUserId
  };
}

export async function getCompanyAttendancePolicy(): Promise<PolicyView> {
  const row = await prisma.companyAttendancePolicy.findUniqueOrThrow({
    where: { singleton: true },
    select: POLICY_SELECT
  });
  return toView(row);
}

export interface PolicyPatchInput {
  cutoffDaysAfterPeriodEnd?: number;
  cutoffTime?: string;
  systemReopenDebounceMinutes?: number;
  maxShiftDurationHours?: number;
  maxGpsAccuracyMeters?: number;
  autoUnpaidBreakThresholdMinutes?: number;
  autoUnpaidBreakMinutes?: number;
}

export type ValidatePolicyPatchResult = { ok: true; value: PolicyPatchInput } | { ok: false; fieldErrors: Record<string, string[]> };

/** `timezone` in the body, in any form, is an unknown-field 400 — it is never an accepted field
 * (frozen at the DB level, §F). Unknown fields and out-of-range/malformed known fields are both
 * reported together, not fail-fast on the first one. */
export function validatePolicyPatchInput(body: Record<string, unknown>): ValidatePolicyPatchResult {
  const fieldErrors: Record<string, string[]> = {};
  const value: PolicyPatchInput = {};

  for (const key of Object.keys(body)) {
    if (!ALLOWED_PATCH_FIELDS.has(key)) {
      fieldErrors[key] = ['unknown field'];
    }
  }

  if ('cutoffDaysAfterPeriodEnd' in body) {
    const v = body.cutoffDaysAfterPeriodEnd;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 31) {
      fieldErrors.cutoffDaysAfterPeriodEnd = ['must be an integer between 0 and 31'];
    } else {
      value.cutoffDaysAfterPeriodEnd = v;
    }
  }

  if ('cutoffTime' in body) {
    const v = body.cutoffTime;
    if (typeof v !== 'string' || !TIME_PATTERN.test(v)) {
      fieldErrors.cutoffTime = ['must be a string in strict HH:mm:ss format'];
    } else {
      value.cutoffTime = v;
    }
  }

  if ('systemReopenDebounceMinutes' in body) {
    const v = body.systemReopenDebounceMinutes;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1440) {
      fieldErrors.systemReopenDebounceMinutes = ['must be an integer between 1 and 1440'];
    } else {
      value.systemReopenDebounceMinutes = v;
    }
  }

  if ('maxShiftDurationHours' in body) {
    const v = body.maxShiftDurationHours;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 168) {
      fieldErrors.maxShiftDurationHours = ['must be an integer between 1 and 168'];
    } else {
      value.maxShiftDurationHours = v;
    }
  }

  if ('maxGpsAccuracyMeters' in body) {
    const v = body.maxGpsAccuracyMeters;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 10 || v > 5000) {
      fieldErrors.maxGpsAccuracyMeters = ['must be an integer between 10 and 5000'];
    } else {
      value.maxGpsAccuracyMeters = v;
    }
  }

  if ('autoUnpaidBreakThresholdMinutes' in body) {
    const v = body.autoUnpaidBreakThresholdMinutes;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1440) {
      fieldErrors.autoUnpaidBreakThresholdMinutes = ['must be an integer between 0 and 1440'];
    } else {
      value.autoUnpaidBreakThresholdMinutes = v;
    }
  }

  if ('autoUnpaidBreakMinutes' in body) {
    const v = body.autoUnpaidBreakMinutes;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1440) {
      fieldErrors.autoUnpaidBreakMinutes = ['must be an integer between 0 and 1440'];
    } else {
      value.autoUnpaidBreakMinutes = v;
    }
  }

  if (Object.keys(fieldErrors).length === 0 && Object.keys(value).length === 0) {
    fieldErrors.body = ['at least one field must be provided'];
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, value };
}

export async function updateCompanyAttendancePolicy(actorUserId: string, requestId: string, patch: PolicyPatchInput): Promise<PolicyView> {
  return prisma.$transaction(async (tx) => {
    // Singleton row FOR UPDATE — serializes concurrent PATCH requests, no lost update.
    await tx.$queryRaw`SELECT id FROM "CompanyAttendancePolicy" WHERE singleton = true FOR UPDATE`;
    const before = await tx.companyAttendancePolicy.findUniqueOrThrow({
      where: { singleton: true },
      select: POLICY_SELECT
    });

    const updated = await tx.companyAttendancePolicy.update({
      where: { singleton: true },
      data: {
        updatedByUserId: actorUserId,
        ...(patch.cutoffDaysAfterPeriodEnd !== undefined ? { cutoffDaysAfterPeriodEnd: patch.cutoffDaysAfterPeriodEnd } : {}),
        ...(patch.cutoffTime !== undefined ? { cutoffTime: parseTimeOfDay(patch.cutoffTime) } : {}),
        ...(patch.systemReopenDebounceMinutes !== undefined ? { systemReopenDebounceMinutes: patch.systemReopenDebounceMinutes } : {}),
        ...(patch.maxShiftDurationHours !== undefined ? { maxShiftDurationHours: patch.maxShiftDurationHours } : {}),
        ...(patch.maxGpsAccuracyMeters !== undefined ? { maxGpsAccuracyMeters: patch.maxGpsAccuracyMeters } : {}),
        ...(patch.autoUnpaidBreakThresholdMinutes !== undefined ? { autoUnpaidBreakThresholdMinutes: patch.autoUnpaidBreakThresholdMinutes } : {}),
        ...(patch.autoUnpaidBreakMinutes !== undefined ? { autoUnpaidBreakMinutes: patch.autoUnpaidBreakMinutes } : {})
      },
      select: POLICY_SELECT
    });

    const auditShape = (row: PolicyRow) => ({
      cutoffDaysAfterPeriodEnd: row.cutoffDaysAfterPeriodEnd,
      cutoffTime: formatTimeOfDay(row.cutoffTime),
      systemReopenDebounceMinutes: row.systemReopenDebounceMinutes,
      maxShiftDurationHours: row.maxShiftDurationHours,
      maxGpsAccuracyMeters: row.maxGpsAccuracyMeters,
      autoUnpaidBreakThresholdMinutes: row.autoUnpaidBreakThresholdMinutes,
      autoUnpaidBreakMinutes: row.autoUnpaidBreakMinutes
    });

    // Only the policy values — never id/singleton/updatedByUserId of the audit actor itself.
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'ATTENDANCE_POLICY_UPDATED',
      entityType: 'COMPANY_ATTENDANCE_POLICY',
      entityId: null,
      requestId,
      beforeValue: auditShape(before),
      afterValue: auditShape(updated)
    });

    return toView(updated);
  });
}
