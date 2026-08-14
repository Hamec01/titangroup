#!/usr/bin/env -S npx tsx
/**
 * Titanor Time — bootstrap the first SUPER_ADMIN user.
 *
 * Usage:
 *   npm run bootstrap:super-admin -- --username=<name> [--email=<email>] [--locale=FI|EN|RU] [--dry-run]
 *
 * The password is NEVER accepted as a command-line argument or environment
 * variable, and is never written to disk or printed — it is only ever read
 * from an interactive, hidden-echo TTY prompt (entered twice) and passed
 * directly to Argon2id. On success, only { userId, username, locale, role }
 * are printed — never the password or its hash.
 *
 * Safe by construction against a duplicate first admin: the whole check +
 * create sequence runs inside one Serializable Prisma transaction, guarded by
 * a PostgreSQL transaction-scoped advisory lock, so two concurrent
 * invocations cannot both create a SUPER_ADMIN.
 */

import { prisma } from '../lib/prisma';
import { hasRealTty, promptHidden } from '../lib/tty-prompt';

const SUPER_ADMIN_ROLE_NAME = 'SUPER_ADMIN';
// Owner-approved password minimum shared with public worker/foreman activation flows.
const MIN_PASSWORD_LENGTH = 8;
const ALLOWED_LOCALES = ['FI', 'EN', 'RU'] as const;
type Locale = (typeof ALLOWED_LOCALES)[number];

// Fixed, deterministic advisory-lock key scoped to this one operation — a
// literal, not user input, so this stays a plain tagged-template $queryRaw
// call rather than $queryRawUnsafe. hashtext() over a name keeps the key
// readable in code without picking an arbitrary magic number.
const ADVISORY_LOCK_KEY_NAME = 'titanor_time:bootstrap_super_admin';

class UsageError extends Error {}
class AlreadyExistsError extends Error {}
class DryRunCompleted extends Error {
  constructor(public readonly summary: string) {
    super('dry-run');
  }
}

interface ParsedArgs {
  username: string;
  email: string | null;
  locale: Locale;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let username: string | null = null;
  let email: string | null = null;
  let locale: Locale = 'FI';
  let dryRun = false;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--password' || arg.startsWith('--password=')) {
      throw new UsageError(
        'The password can never be passed as a command-line argument. Run without --password; you will be prompted interactively.'
      );
    }
    const match = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!match) {
      throw new UsageError(`Unrecognized argument: ${arg}`);
    }
    const [, key, value] = match;
    switch (key) {
      case 'username':
        username = value;
        break;
      case 'email':
        email = value;
        break;
      case 'locale':
        locale = value.toUpperCase() as Locale;
        break;
      default:
        throw new UsageError(`Unrecognized argument: --${key}`);
    }
  }

  if (!username) {
    throw new UsageError('--username=<name> is required.');
  }

  const normalizedUsername = username.trim().toLowerCase();
  if (normalizedUsername.length < 3 || normalizedUsername.length > 64) {
    throw new UsageError('--username must be 3-64 characters.');
  }
  if (!/^[a-z0-9._-]+$/.test(normalizedUsername)) {
    throw new UsageError('--username may only contain lowercase letters, digits, "." "_" "-".');
  }

  let normalizedEmail: string | null = null;
  if (email) {
    normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new UsageError('--email is not a valid email address.');
    }
  }

  if (!ALLOWED_LOCALES.includes(locale)) {
    throw new UsageError(`--locale must be one of: ${ALLOWED_LOCALES.join(', ')}.`);
  }

  return { username: normalizedUsername, email: normalizedEmail, locale, dryRun };
}

function requireRealTty(): void {
  if (!hasRealTty()) {
    throw new UsageError(
      'A real interactive terminal (TTY) is required for the password prompt — refusing to run under a pipe/redirect.'
    );
  }
}

async function promptForPassword(): Promise<string> {
  const first = await promptHidden(`New SUPER_ADMIN password (min ${MIN_PASSWORD_LENGTH} characters, hidden): `);
  if (first.length < MIN_PASSWORD_LENGTH) {
    throw new UsageError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const second = await promptHidden('Confirm password: ');
  if (first !== second) {
    throw new UsageError('Passwords did not match.');
  }
  return first;
}

export interface BootstrapSuperAdminInput {
  username: string;
  email: string | null;
  locale: Locale;
  dryRun: boolean;
  /** Plaintext password — caller is responsible for how it was obtained (the
   * shipped CLI entrypoint only ever gets this from an interactive, hidden,
   * real-TTY double-prompt; see main() below). Never logged here. */
  password: string;
}

export interface BootstrapSuperAdminResult {
  userId: string;
  username: string;
  locale: Locale;
  role: typeof SUPER_ADMIN_ROLE_NAME;
}

/**
 * Core transactional logic, independent of any TTY/prompt concerns so it can
 * be exercised directly by tests. Not exported as a CLI entrypoint of its
 * own — the only shipped way to reach it is main()'s interactive TTY prompt.
 */
export async function bootstrapSuperAdmin(
  rawInput: BootstrapSuperAdminInput
): Promise<BootstrapSuperAdminResult> {
  if (rawInput.password.length < MIN_PASSWORD_LENGTH) {
    throw new UsageError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  // Normalized here (not only in parseArgs) so this stays correct regardless
  // of caller — including direct, non-CLI callers such as tests.
  const input: BootstrapSuperAdminInput = {
    ...rawInput,
    username: rawInput.username.trim().toLowerCase(),
    email: rawInput.email ? rawInput.email.trim().toLowerCase() : null
  };

  const argon2 = await import('argon2');
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });

  const result = await prisma.$transaction(
    async (tx) => {
      // pg_advisory_xact_lock() returns void — $executeRaw (not $queryRaw,
      // which fails trying to deserialize a void column) is the correct call
      // for a statement whose result set isn't meaningful.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ADVISORY_LOCK_KEY_NAME})::bigint)`;

      const existingActiveSuperAdmin = await tx.userRole.findFirst({
        where: { validTo: null, role: { name: SUPER_ADMIN_ROLE_NAME } }
      });
      if (existingActiveSuperAdmin) {
        throw new AlreadyExistsError('An active SUPER_ADMIN already exists.');
      }

      const usernameOrEmailTaken = await tx.user.findFirst({
        where: {
          OR: [
            { username: input.username },
            ...(input.email ? [{ email: input.email }] : [])
          ]
        }
      });
      if (usernameOrEmailTaken) {
        throw new AlreadyExistsError('That username or email is already taken.');
      }

      const role = await tx.role.findUnique({ where: { name: SUPER_ADMIN_ROLE_NAME } });
      if (!role) {
        throw new Error(
          `Role "${SUPER_ADMIN_ROLE_NAME}" not found — the second migration must be applied first.`
        );
      }

      if (input.dryRun) {
        throw new DryRunCompleted(
          `Would create User(username=${input.username}, email=${input.email ?? '(none)'}, locale=${input.locale}, status=ACTIVE) + UserRole(role=${SUPER_ADMIN_ROLE_NAME}).`
        );
      }

      const user = await tx.user.create({
        data: {
          username: input.username,
          email: input.email,
          passwordHash,
          status: 'ACTIVE',
          locale: input.locale,
          twoFactorEnabled: false,
          employeeId: null
        }
      });

      await tx.userRole.create({
        data: {
          userId: user.id,
          roleId: role.id
        }
      });

      return { id: user.id, username: user.username, locale: user.locale };
    },
    { isolationLevel: 'Serializable' }
  );

  return { userId: result.id, username: result.username, locale: result.locale, role: SUPER_ADMIN_ROLE_NAME };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  requireRealTty();

  const password = await promptForPassword();
  const result = await bootstrapSuperAdmin({ ...args, password });

  console.log(JSON.stringify(result, null, 2));
}

// Only run the interactive CLI when this file is executed directly (e.g. via
// `npm run bootstrap:super-admin` / `tsx scripts/bootstrap-super-admin.ts`) —
// never as a side effect of importing bootstrapSuperAdmin() for tests.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      if (error instanceof DryRunCompleted) {
        console.log(`DRY RUN — no changes written. ${error.summary}`);
        process.exit(0);
      }
      if (error instanceof AlreadyExistsError) {
        console.error(`No changes made: ${error.message}`);
        process.exit(3);
      }
      if (error instanceof UsageError) {
        console.error(`Usage error: ${error.message}`);
        process.exit(1);
      }
      console.error('Failed to bootstrap SUPER_ADMIN — no partial user was left committed.');
      process.exit(2);
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
