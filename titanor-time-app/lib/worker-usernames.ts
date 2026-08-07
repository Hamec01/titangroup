import type { Prisma } from '@prisma/client';

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.1 — `User.username varchar(64)`. Friendly worker
// login: `lastName` + the first letter of `firstName`, canonical storage lowercase, alphabet
// restricted to a-z0-9 so the login is easy to type on any keyboard. Replaces the previous
// `username = employeeNumber` scheme (see IMPLEMENTATION_STATUS.md — that entry is marked
// superseded, not rewritten).
export const WORKER_USERNAME_MAX_LENGTH = 64;

/**
 * Practical Cyrillic → Latin transliteration table (lowercase source, since `transliterate()`
 * below lowercases every character before lookup). Not GOST/ISO-9 — chosen to keep common names
 * short and typeable (е.g. `х`→`kh` not the single-letter ISO-9 `h`, `щ`→`shch`), matching the
 * scheme most Russian-language systems use for login/URL slugs. The one owner-confirmed example
 * (`Евтушенко Антон` → `evtushenkoa`) only exercises а/в/е/к/н/о/т/у/ш, but the full alphabet is
 * mapped here so no Cyrillic name silently falls through to the `worker` fallback.
 *
 * а=a  б=b  в=v  г=g  д=d  е=e  ё=e  ж=zh з=z  и=i  й=i  к=k  л=l  м=m  н=n
 * о=o  п=p  р=r  с=s  т=t  у=u  ф=f  х=kh ц=ts ч=ch ш=sh щ=shch ъ=(dropped) ы=y
 * ь=(dropped) э=e ю=yu я=ya
 */
const CYRILLIC_TRANSLITERATION: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya'
};

/**
 * Normalization pipeline, one name part at a time:
 * 1. Unicode NFKD decompose (e.g. `Ä` → `A` + U+0308 COMBINING DIAERESIS).
 * 2. Strip the combining-diacritical-marks block (U+0300–U+036F) — turns `Mäkinen` into `Makinen`
 *    before lowercasing, so accented Latin letters degrade to their plain Latin base letter
 *    instead of vanishing.
 * 3. Lowercase, then map each character: Cyrillic → its transliteration (possibly multi-char,
 *    e.g. `ш`→`sh`); `a-z0-9` → itself; anything else (spaces, hyphens, apostrophes, unmapped
 *    scripts) → dropped entirely, never replaced with a separator — this is what keeps
 *    `O'Connor` → `oconnor` and `Mary-Jane` → `maryjane` free of stray punctuation.
 */
function transliterate(namePart: string): string {
  const decomposed = namePart.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  let out = '';
  for (const rawChar of decomposed) {
    const ch = rawChar.toLowerCase();
    const mapped = CYRILLIC_TRANSLITERATION[ch];
    if (mapped !== undefined) {
      out += mapped;
    } else if (/[a-z0-9]/.test(ch)) {
      out += ch;
    }
    // else: drop — punctuation, whitespace, or a script with no transliteration entry.
  }
  return out;
}

// Reserves room for a collision suffix (see reserveWorkerUsername) so the final candidate never
// exceeds WORKER_USERNAME_MAX_LENGTH regardless of how many digits the suffix ends up needing.
const MAX_SUFFIX_DIGITS = 6;

/**
 * Pure function, no DB access — `lastName` fully transliterated + the first character of
 * `firstName`'s transliteration. Never returns an empty string: a name that transliterates to
 * nothing (unsupported script, punctuation-only, etc.) falls back to the literal string
 * `"worker"`, which the caller's normal collision-suffix handling (reserveWorkerUsername) then
 * disambiguates the same as any other base (`worker`, `worker2`, `worker3`, ...) — this is *not*
 * the Employee.employeeNumber, which stays a wholly separate, unrelated field.
 *
 * Examples (docs/titanor-time/03_DATA_MODEL_ERD.md — worker login):
 *   generateWorkerUsernameBase('Anton', 'Evtushenko')  -> 'evtushenkoa'
 *   generateWorkerUsernameBase('Änne', 'Mäkinen')      -> 'makinena'
 *   generateWorkerUsernameBase('Антон', 'Евтушенко')    -> 'evtushenkoa'
 *   generateWorkerUsernameBase('John', "O'Connor")     -> 'oconnorj'
 */
export function generateWorkerUsernameBase(firstName: string, lastName: string): string {
  const lastPart = transliterate(lastName.trim());
  const firstInitial = transliterate(firstName.trim()).slice(0, 1);
  const base = `${lastPart}${firstInitial}` || 'worker';
  return base.slice(0, WORKER_USERNAME_MAX_LENGTH - MAX_SUFFIX_DIGITS);
}

/**
 * Race-safe collision resolution: `base`, then `base2`, `base3`, ... — the first suffix is *2*
 * (docs/titanor-time/IMPLEMENTATION_STATUS.md — "first: evtushenkoa, second: evtushenkoa2, third:
 * evtushenkoa3"), never a random value, and checked against *every* `User.username` regardless
 * of role (a standalone FOREMAN who already typed `evtushenkoa` correctly pushes a colliding
 * worker to `evtushenkoa2`).
 *
 * `pg_advisory_xact_lock(hashtext(...))` scoped to the exact `base` string serializes every
 * concurrent caller that would generate candidates from that same base (worker creation,
 * regenerate-username) for the lifetime of the transaction — two workers named "Anton Evtushenko"
 * created in true parallel cannot both observe "evtushenkoa is free" and collide; the second
 * blocks until the first commits, then correctly sees `evtushenkoa` taken and returns
 * `evtushenkoa2`. The DB's own UNIQUE constraint on `User.username` remains the last-resort
 * safety net if this is ever called without the lock (defensive only — every call site in this
 * codebase takes it).
 *
 * `excludeUserId` lets regenerate-username check "is `base` free" without the target user's own
 * *current* row counting as a collision against itself — otherwise a worker whose username
 * already exactly matches their current recommended base would be wrongly bumped to `base2` on
 * every call.
 */
export async function reserveWorkerUsername(tx: Prisma.TransactionClient, base: string, excludeUserId?: string): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`worker_username:${base}`}))`;

  const existing = await tx.user.findMany({
    where: {
      username: { startsWith: base },
      ...(excludeUserId ? { id: { not: excludeUserId } } : {})
    },
    select: { username: true }
  });
  const taken = new Set(existing.map((u) => u.username));

  if (!taken.has(base)) {
    return base;
  }
  for (let suffix = 2; suffix < 10 ** MAX_SUFFIX_DIGITS; suffix++) {
    const suffixStr = String(suffix);
    const candidateBase = base.slice(0, WORKER_USERNAME_MAX_LENGTH - suffixStr.length);
    const candidate = `${candidateBase}${suffixStr}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  // Unreachable in practice (would require ~10^6 exact collisions on one base) — no infinite loop.
  throw new Error(`Could not find an available username for base "${base}" after exhausting suffixes.`);
}
