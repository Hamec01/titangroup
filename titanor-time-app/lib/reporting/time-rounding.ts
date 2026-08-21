export const REPORTED_TIME_INCREMENT_MINUTES = 30;
const INCREMENT_MS = REPORTED_TIME_INCREMENT_MINUTES * 60_000;

/** Nearest half-hour, half-up. Because Helsinki's UTC offset is always a whole number of hours,
 * epoch half-hours are the same :00/:30 wall-clock grid in both EET and EEST. */
export function roundReportedInstant(instant: Date): Date {
  return new Date(Math.floor((instant.getTime() + INCREMENT_MS / 2) / INCREMENT_MS) * INCREMENT_MS);
}

export function roundReportedInterval(startAt: Date, endAt: Date): { startAt: Date; endAt: Date; usedExactFallback: boolean } {
  const roundedStart = roundReportedInstant(startAt);
  const roundedEnd = roundReportedInstant(endAt);
  if (roundedEnd > roundedStart) {
    return { startAt: roundedStart, endAt: roundedEnd, usedExactFallback: false };
  }
  // A positive raw interval shorter than the rounding threshold can collapse to zero. The DB and
  // timesheet domain deliberately forbid zero-length segments; silently dropping it would be data
  // loss, and inventing a full 30 minutes would overpay. Preserve exact endpoints for this rare
  // case while keeping the raw ClockEvent/ClockShift authoritative and unchanged.
  return { startAt, endAt, usedExactFallback: true };
}
