import { computeQualificationExpiryStatus } from '../lib/qualification-expiry';

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const today = new Date('2026-08-24T00:00:00.000Z');
function daysFromToday(n: number): Date {
  return new Date(Date.UTC(2026, 7, 24 + n));
}

check('61 days -> VALID', computeQualificationExpiryStatus('REQUIRED', daysFromToday(61), today).status, 'VALID');
check('60 days -> EXPIRING_SOON', computeQualificationExpiryStatus('REQUIRED', daysFromToday(60), today).status, 'EXPIRING_SOON');
check('15 days -> EXPIRING_SOON', computeQualificationExpiryStatus('REQUIRED', daysFromToday(15), today).status, 'EXPIRING_SOON');
check('14 days -> CRITICAL', computeQualificationExpiryStatus('REQUIRED', daysFromToday(14), today).status, 'CRITICAL');
check('1 day -> CRITICAL', computeQualificationExpiryStatus('REQUIRED', daysFromToday(1), today).status, 'CRITICAL');

const todayResult = computeQualificationExpiryStatus('REQUIRED', daysFromToday(0), today);
check('today -> CRITICAL', todayResult.status, 'CRITICAL');
check('today -> RED', todayResult.color, 'RED');
check('today -> isExpiringToday', todayResult.isExpiringToday, true);

check('yesterday -> EXPIRED', computeQualificationExpiryStatus('REQUIRED', daysFromToday(-1), today).status, 'EXPIRED');
check('60 days -> YELLOW', computeQualificationExpiryStatus('REQUIRED', daysFromToday(60), today).color, 'YELLOW');
check('14 days -> ORANGE', computeQualificationExpiryStatus('REQUIRED', daysFromToday(14), today).color, 'ORANGE');
check('yesterday -> RED', computeQualificationExpiryStatus('REQUIRED', daysFromToday(-1), today).color, 'RED');
check('61 days -> GREEN', computeQualificationExpiryStatus('REQUIRED', daysFromToday(61), today).color, 'GREEN');

check('expiryMode NONE, no expiresOn -> VALID', computeQualificationExpiryStatus('NONE', null, today).status, 'VALID');
check('expiryMode NONE, no expiresOn -> GREEN', computeQualificationExpiryStatus('NONE', null, today).color, 'GREEN');
check('expiryMode NONE, has expiresOn far future -> VALID', computeQualificationExpiryStatus('NONE', daysFromToday(9999), today).status, 'VALID');

check('expiryMode REQUIRED, no expiresOn -> MISSING_EXPIRY', computeQualificationExpiryStatus('REQUIRED', null, today).status, 'MISSING_EXPIRY');
check('expiryMode REQUIRED, no expiresOn -> RED', computeQualificationExpiryStatus('REQUIRED', null, today).color, 'RED');

check('expiryMode OPTIONAL, no expiresOn -> VALID', computeQualificationExpiryStatus('OPTIONAL', null, today).status, 'VALID');
check('expiryMode OPTIONAL, near expiry -> CRITICAL', computeQualificationExpiryStatus('OPTIONAL', daysFromToday(5), today).status, 'CRITICAL');

console.log(`${fail === 0 ? 'PASS' : 'FAIL'}: ${pass}/${pass + fail} qualification expiry status checks`);
process.exit(fail > 0 ? 1 : 0);
