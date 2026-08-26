// Worker Dossier feature (2026-08-26, task spec §5/§48) — direct lib-level test for henkilötunnus
// validation (format/date/checksum) and the AES-256-GCM encryption module. No DB/HTTP needed for
// validation; encryption needs PERSONAL_DATA_ENCRYPTION_KEY (a throwaway key is generated here,
// in-process, never printed).
import { randomBytes } from 'node:crypto';
import { validatePersonalIdentityCode, normalizePersonalIdentityCode } from '../lib/personal-identity-code';

process.env.PERSONAL_DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
// Imported after the env var is set — encryptPersonalData/decryptPersonalData read it lazily at
// call time, but importing after keeps intent obvious.
import { encryptPersonalData, decryptPersonalData } from '../lib/personal-data-encryption';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${name}`, extra ?? '');
  }
}

const CHECKSUM_ALPHABET = '0123456789ABCDEFHJKLMNPRSTUVWXY';

/** Constructs a structurally-valid HETU from its parts using the exact same checksum algorithm
 * the validator implements — a self-consistency fixture generator (not an independently sourced
 * real test vector), used only to exercise the validator's happy path and boundary handling. */
function buildValidHetu(day: number, month: number, twoDigitYear: number, sign: string, individual: number): string {
  const dd = String(day).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  const yy = String(twoDigitYear).padStart(2, '0');
  const zzz = String(individual).padStart(3, '0');
  const checksum = CHECKSUM_ALPHABET[Number(`${dd}${mm}${yy}${zzz}`) % 31];
  return `${dd}${mm}${yy}${sign}${zzz}${checksum}`;
}

async function main(): Promise<void> {
  // --- Valid codes across century signs ---
  const valid1900 = buildValidHetu(15, 5, 90, '-', 123);
  check('valid 1900s code (- sign) accepted', validatePersonalIdentityCode(valid1900).valid, valid1900);

  const valid2000 = buildValidHetu(1, 1, 5, 'A', 456);
  check('valid 2000s code (A sign) accepted', validatePersonalIdentityCode(valid2000).valid, valid2000);

  const valid1800 = buildValidHetu(28, 2, 99, '+', 2);
  check('valid 1800s code (+ sign) accepted', validatePersonalIdentityCode(valid1800).valid, valid1800);

  const valid2000ExpandedSign = buildValidHetu(10, 10, 10, 'B', 899);
  check('valid 2000s expanded century sign (B) accepted', validatePersonalIdentityCode(valid2000ExpandedSign).valid, valid2000ExpandedSign);

  const valid1900ExpandedSign = buildValidHetu(3, 3, 3, 'Y', 2);
  check('valid 1900s expanded century sign (Y) accepted', validatePersonalIdentityCode(valid1900ExpandedSign).valid, valid1900ExpandedSign);

  // --- Leap year: 29 Feb 2000 (a real leap year) valid, 29 Feb 1900-equivalent (not a leap year) invalid ---
  const leapValid = buildValidHetu(29, 2, 0, 'A', 5);
  check('29 Feb on a leap year accepted', validatePersonalIdentityCode(leapValid).valid, leapValid);
  const leapInvalid = buildValidHetu(29, 2, 1, 'A', 5); // 2001, not a leap year
  check('29 Feb on a non-leap year rejected', !validatePersonalIdentityCode(leapInvalid).valid, leapInvalid);

  // --- Individual number range ---
  const belowRange = buildValidHetu(1, 1, 90, '-', 1);
  check('individual number 001 (below range) rejected', !validatePersonalIdentityCode(belowRange).valid, belowRange);
  const aboveRange = buildValidHetu(1, 1, 90, '-', 900);
  check('individual number 900 (above range) rejected', !validatePersonalIdentityCode(aboveRange).valid, aboveRange);

  // --- Invalid format ---
  check('too short rejected', !validatePersonalIdentityCode('12345').valid);
  check('missing century sign rejected', !validatePersonalIdentityCode('150590X1237').valid);
  check('non-digit day rejected', !validatePersonalIdentityCode('AA0590-1237').valid);

  // --- Invalid calendar date (checksum computed correctly for the digits — rejection must come
  // from the date-validity check, not an incidental checksum mismatch) ---
  const badMonth = buildValidHetu(15, 13, 90, '-', 123);
  check('month 13 rejected', !validatePersonalIdentityCode(badMonth).valid, badMonth);
  const feb30 = buildValidHetu(30, 2, 90, '-', 123);
  check('30 Feb rejected (invalid calendar date)', !validatePersonalIdentityCode(feb30).valid, feb30);

  // --- Checksum tampering ---
  const tampered = valid1900.slice(0, -1) + (valid1900.slice(-1) === '0' ? '1' : '0');
  check('tampered checksum rejected', !validatePersonalIdentityCode(tampered).valid, tampered);

  // --- Normalization: lowercase + surrounding whitespace still validates ---
  const lower = `  ${valid1900.toLowerCase()}  `;
  check('lowercase + whitespace normalizes and validates', validatePersonalIdentityCode(lower).valid, lower);
  check('normalizePersonalIdentityCode uppercases and trims', normalizePersonalIdentityCode(lower) === valid1900);

  // --- last4 ---
  const parsedValid = validatePersonalIdentityCode(valid1900);
  if (parsedValid.valid) {
    check('last4 is exactly the final 4 characters', parsedValid.parsed.last4 === valid1900.slice(-4), parsedValid.parsed.last4);
  } else {
    fail++;
    console.log('FAIL: expected valid1900 to parse for last4 check');
  }

  // --- Encryption round-trip ---
  const plaintext = valid1900;
  const encrypted = encryptPersonalData(plaintext);
  check('encrypted value differs from plaintext', encrypted !== plaintext);
  check('encrypted value does not contain plaintext substring', !encrypted.includes(plaintext));
  const decrypted = decryptPersonalData(encrypted);
  check('decrypt(encrypt(x)) === x', decrypted === plaintext);

  // Two encryptions of the same plaintext must differ (random IV) — never a static-ciphertext oracle.
  const encrypted2 = encryptPersonalData(plaintext);
  check('two encryptions of the same plaintext produce different ciphertext (random IV)', encrypted2 !== encrypted);

  // Tampered ciphertext must fail authentication, not silently decrypt to garbage.
  const tamperedCiphertext = Buffer.from(encrypted, 'base64');
  tamperedCiphertext[tamperedCiphertext.length - 1] ^= 0xff;
  let tamperThrew = false;
  try {
    decryptPersonalData(tamperedCiphertext.toString('base64'));
  } catch {
    tamperThrew = true;
  }
  check('tampered ciphertext fails GCM auth tag check (throws)', tamperThrew);

  // Missing key throws a clear config error, not a silent fallback.
  const savedKey = process.env.PERSONAL_DATA_ENCRYPTION_KEY;
  delete process.env.PERSONAL_DATA_ENCRYPTION_KEY;
  let missingKeyThrew = false;
  try {
    encryptPersonalData('x');
  } catch (error) {
    missingKeyThrew = error instanceof Error && /PERSONAL_DATA_ENCRYPTION_KEY/.test(error.message);
  }
  check('missing PERSONAL_DATA_ENCRYPTION_KEY throws a clear config error', missingKeyThrew);
  process.env.PERSONAL_DATA_ENCRYPTION_KEY = savedKey;

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
