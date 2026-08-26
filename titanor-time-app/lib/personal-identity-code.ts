// Worker Dossier feature (2026-08-26) — Finnish henkilötunnus (personal identity code)
// format/date/checksum validation. Pure, no I/O, no network/registry lookup (task spec §5 —
// this is a local structural/checksum check only, never an identity-verification claim).
//
// Format: DDMMYYSZZZQ
//   DD/MM/YY  — calendar date, two-digit year
//   S         — century sign: '+' 1800s; '-' 'Y' 'X' 'W' 'V' 'U' 1900s; 'A' 'B' 'C' 'D' 'E' 'F' 2000s
//               (the letter century signs beyond '+'/'-'/'A' are the DVV 2023 expansion, added
//               once the classic signs' individual-number range began running out — still valid,
//               real-world personal identity codes, not a hypothetical/future format)
//   ZZZ       — individual number, 002-899
//   Q         — checksum character, computed from the 9-digit DDMMYY+ZZZ number mod 31

const CHECKSUM_ALPHABET = '0123456789ABCDEFHJKLMNPRSTUVWXY';

const CENTURY_SIGN_BASE_YEAR: Record<string, number> = {
  '+': 1800,
  '-': 1900,
  Y: 1900,
  X: 1900,
  W: 1900,
  V: 1900,
  U: 1900,
  A: 2000,
  B: 2000,
  C: 2000,
  D: 2000,
  E: 2000,
  F: 2000
};

const FORMAT_PATTERN = /^(\d{2})(\d{2})(\d{2})([+\-YXWVUABCDEF])(\d{3})([0-9A-Y])$/;

export interface ParsedPersonalIdentityCode {
  normalized: string;
  day: number;
  month: number;
  year: number;
  individualNumber: number;
  checksumChar: string;
  /** Last 4 characters (individual number + checksum) — the only slice ever safe to display unmasked in a UI list. */
  last4: string;
}

export type PersonalIdentityCodeValidationResult = { valid: true; parsed: ParsedPersonalIdentityCode } | { valid: false };

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/** Normalizes casing/whitespace only — does not validate. Callers should still treat the input as untrusted until validatePersonalIdentityCode confirms it. */
export function normalizePersonalIdentityCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Validates format, calendar date, individual-number range, and checksum. Returns only a
 * boolean-shaped result plus the parsed value on success — callers must never echo the
 * caller-supplied raw string back in an error (task spec §5: "Invalid personal identity code",
 * no reflection of the input).
 */
export function validatePersonalIdentityCode(raw: string): PersonalIdentityCodeValidationResult {
  const normalized = normalizePersonalIdentityCode(raw);
  const match = FORMAT_PATTERN.exec(normalized);
  if (!match) {
    return { valid: false };
  }
  const [, ddRaw, mmRaw, yyRaw, sign, individualRaw, checksumChar] = match;
  const day = Number(ddRaw);
  const month = Number(mmRaw);
  const twoDigitYear = Number(yyRaw);
  const baseYear = CENTURY_SIGN_BASE_YEAR[sign];
  const year = baseYear + twoDigitYear;
  if (!isValidCalendarDate(year, month, day)) {
    return { valid: false };
  }
  const individualNumber = Number(individualRaw);
  if (individualNumber < 2 || individualNumber > 899) {
    return { valid: false };
  }
  const checksumSource = Number(`${ddRaw}${mmRaw}${yyRaw}${individualRaw}`);
  const expectedChecksumChar = CHECKSUM_ALPHABET[checksumSource % 31];
  if (expectedChecksumChar !== checksumChar) {
    return { valid: false };
  }
  return {
    valid: true,
    parsed: {
      normalized,
      day,
      month,
      year,
      individualNumber,
      checksumChar,
      last4: normalized.slice(-4)
    }
  };
}
