import { roundReportedInstant, roundReportedInterval } from '../lib/reporting/time-rounding';

function check(actual: string, expected: string, name: string): void {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}`);
}

check(roundReportedInstant(new Date('2026-08-21T04:10:00Z')).toISOString(), '2026-08-21T04:00:00.000Z', '07:10 Helsinki -> 07:00');
check(roundReportedInstant(new Date('2026-08-21T04:15:00Z')).toISOString(), '2026-08-21T04:30:00.000Z', '07:15 Helsinki -> 07:30');
check(roundReportedInstant(new Date('2026-08-21T04:24:00Z')).toISOString(), '2026-08-21T04:30:00.000Z', '07:24 Helsinki -> 07:30');
check(roundReportedInstant(new Date('2026-08-21T04:52:00Z')).toISOString(), '2026-08-21T05:00:00.000Z', '07:52 Helsinki -> 08:00');
check(roundReportedInstant(new Date('2026-08-21T13:18:00Z')).toISOString(), '2026-08-21T13:30:00.000Z', '16:18 Helsinki -> 16:30');

const normal = roundReportedInterval(new Date('2026-08-21T04:52:00Z'), new Date('2026-08-21T13:18:00Z'));
check(normal.startAt.toISOString(), '2026-08-21T05:00:00.000Z', 'normal interval start');
check(normal.endAt.toISOString(), '2026-08-21T13:30:00.000Z', 'normal interval end');
if (normal.usedExactFallback) throw new Error('normal interval must not use exact fallback');

const short = roundReportedInterval(new Date('2026-08-21T20:01:00Z'), new Date('2026-08-21T20:12:00Z'));
check(short.startAt.toISOString(), '2026-08-21T20:01:00.000Z', 'collapsed interval exact start');
check(short.endAt.toISOString(), '2026-08-21T20:12:00.000Z', 'collapsed interval exact end');
if (!short.usedExactFallback) throw new Error('collapsed interval must use exact fallback');

console.log('PASS: 9/9 reported-time rounding checks');
