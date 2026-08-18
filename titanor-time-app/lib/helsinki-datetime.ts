// Pure, dependency-free Europe/Helsinki wall-clock <-> UTC conversion, safe to import from both
// Client and Server Components (no Prisma/DB import, unlike lib/attendance-clock.ts's own
// server-only helsinkiWallClockToUtc/helsinkiOffsetMinutesAt pair). The DST-aware core
// (helsinkiOffsetMinutesAt) was previously copy-pasted between app/worker/.../DayEditor.tsx and
// app/admin/corrections/.../CorrectionDayEditor.tsx — both now import it from here instead, and
// T7A.8C.2's FORCE_CLOSE_OPEN_SHIFT/REASON_EDIT forms reuse the same tested logic rather than a
// third hand-rolled copy. Deliberately NOT `new Date(datetimeLocalValue).toISOString()` anywhere —
// that interprets the string in the browser's OWN timezone, which for an admin travelling or a
// server-adjacent client can silently differ from Europe/Helsinki.

/** The Europe/Helsinki UTC offset (in minutes) in effect at a given instant — EET (+120) in winter,
 * EEST (+180) in summer, correct across the DST boundary because it asks the browser/Node ICU data
 * for the actual local wall-clock reading at that instant rather than a hardcoded offset. */
export function helsinkiOffsetMinutesAt(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Helsinki',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)!.value);
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asIfUtc - instant.getTime()) / 60000);
}

/** A Helsinki calendar date (`YYYY-MM-DD`) plus a wall-clock time-of-day (`HH:mm`) -> the UTC
 * instant that wall-clock reading actually falls on, DST included. Used where the date and time
 * are edited as two separate fields (e.g. one input per segment on an already-known day) —
 * app/worker/.../DayEditor.tsx and CorrectionDayEditor.tsx's own `helsinkiTimeToIso`. */
export function helsinkiDateAndTimeToUtcIso(date: string, timeStr: string): string {
  const [hh, mm] = timeStr.split(':').map(Number);
  const naiveGuess = new Date(`${date}T00:00:00.000Z`);
  naiveGuess.setUTCHours(hh, mm, 0, 0);
  const offsetMinutes = helsinkiOffsetMinutesAt(naiveGuess);
  return new Date(naiveGuess.getTime() - offsetMinutes * 60000).toISOString();
}

/** A single `<input type="datetime-local">` value (`YYYY-MM-DDTHH:mm`, no seconds, no offset) ->
 * the UTC instant that value represents when read as Europe/Helsinki wall-clock time. Used by
 * FORCE_CLOSE_OPEN_SHIFT's explicit end date/time (task §6 — "ввод трактуется как Europe/Helsinki
 * wall-clock, не timezone браузера") and REASON_EDIT's start/end fields, where date and time are
 * one combined field rather than two. */
export function helsinkiDateTimeLocalToUtcIso(dateTimeLocal: string): string {
  const [date, timeStr] = dateTimeLocal.split('T');
  return helsinkiDateAndTimeToUtcIso(date, timeStr ?? '00:00');
}

/** Inverse of helsinkiDateAndTimeToUtcIso's time half — an ISO instant's Europe/Helsinki
 * wall-clock time as `HH:mm`, for pre-filling a `<input type="time">`. */
export function utcIsoToHelsinkiTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** Inverse of helsinkiDateTimeLocalToUtcIso — an ISO instant's Europe/Helsinki wall-clock reading
 * as a `YYYY-MM-DDTHH:mm` string, for pre-filling a `<input type="datetime-local">`. */
export function utcIsoToHelsinkiDateTimeLocal(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Helsinki',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** Europe/Helsinki calendar date (`YYYY-MM-DD`) an instant falls on — for display only (not the
 * project-wide UTC-midnight `Date` convention used server-side by
 * lib/attendance-clock.ts's helsinkiCalendarDateAsUtcMidnight). */
export function utcIsoToHelsinkiDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date(iso));
}

/** Human-readable Europe/Helsinki date+time (e.g. "18 Aug 2026, 18:44") — explicit `timeZone`, not
 * server-locale-dependent like the `toLocaleString()` convention used elsewhere for non-TZ-critical
 * display. Used by T7A.9B's `asOf` (task requires it "отформатированный в Europe/Helsinki"
 * specifically, not "whatever the server happens to run as"). */
export function formatHelsinkiDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Helsinki',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(iso));
}
