#!/usr/bin/env -S npx tsx
/**
 * Titanor Time — reset an existing user's password.
 *
 * Usage:
 *   npm run reset-password -- --username=<name> [--dry-run]
 *
 * For emergencies like a forgotten SUPER_ADMIN password — there is no
 * self-service "forgot password" flow yet (PasswordResetToken/email delivery
 * is a later, unbuilt feature). This is deliberately an owner-run server-side
 * tool, not an HTTP endpoint: the same trust boundary as direct database
 * access, not something exposed to end users.
 *
 * The new password is NEVER accepted as a command-line argument or
 * environment variable, and is never written to disk or printed — it is
 * only ever read from an interactive, hidden-echo TTY prompt (entered
 * twice) and passed directly to Argon2id, same as bootstrap-super-admin.ts.
 *
 * Resetting also revokes every currently-active UserSession for that user —
 * a password only worth resetting because it may be known to someone else
 * (or simply forgotten) means any session issued under the old password
 * should not be trusted either.
 */

import { prisma } from '../lib/prisma';
import { hasRealTty, promptHidden } from '../lib/tty-prompt';

// This privileged, local-only recovery CLI follows the owner-approved administrative
// password minimum. Public worker/foreman activation flows remain at 16 characters.
const MIN_PASSWORD_LENGTH = 8;

class UsageError extends Error {}
class NotFoundError extends Error {}
class SystemUserNotEligibleError extends Error {}
class DryRunCompleted extends Error {
  constructor(public readonly summary: string) {
    super('dry-run');
  }
}

interface ParsedArgs {
  username: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let username: string | null = null;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--password' || arg.startsWith('--password=')) {
      throw new UsageError(
        'The new password can never be passed as a command-line argument. Run without --password; you will be prompted interactively.'
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
      default:
        throw new UsageError(`Unrecognized argument: --${key}`);
    }
  }

  if (!username) {
    throw new UsageError('--username=<name> is required.');
  }

  return { username: username.trim().toLowerCase(), dryRun };
}

function requireRealTty(): void {
  if (!hasRealTty()) {
    throw new UsageError(
      'A real interactive terminal (TTY) is required for the password prompt — refusing to run under a pipe/redirect.'
    );
  }
}

async function promptForNewPassword(): Promise<string> {
  const first = await promptHidden(`New password (min ${MIN_PASSWORD_LENGTH} characters, hidden): `);
  if (first.length < MIN_PASSWORD_LENGTH) {
    throw new UsageError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const second = await promptHidden('Confirm new password: ');
  if (first !== second) {
    throw new UsageError('Passwords did not match.');
  }
  return first;
}

export interface ResetPasswordInput {
  username: string;
  dryRun: boolean;
  /** Plaintext — caller's responsibility for how it was obtained; the shipped
   * CLI entrypoint only ever gets this from an interactive, hidden, real-TTY
   * double-prompt (see main() below). Never logged here. */
  password: string;
}

export interface ResetPasswordResult {
  userId: string;
  username: string;
  revokedSessions: number;
}

/**
 * Core transactional logic, independent of any TTY/prompt concerns so it can
 * be exercised directly by tests — same split as bootstrapSuperAdmin().
 */
export async function resetPassword(rawInput: ResetPasswordInput): Promise<ResetPasswordResult> {
  if (rawInput.password.length < MIN_PASSWORD_LENGTH) {
    throw new UsageError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const username = rawInput.username.trim().toLowerCase();

  const argon2 = await import('argon2');
  const passwordHash = await argon2.hash(rawInput.password, { type: argon2.argon2id });

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { username } });
    if (!user) {
      throw new NotFoundError(`No user found with username "${username}".`);
    }

    // T7A §13/§15 — the reserved SYSTEM actor (userKind=SYSTEM, passwordHash always NULL by
    // invariant) must never have a password written by this tool, dry-run or not.
    if (user.userKind !== 'HUMAN') {
      throw new SystemUserNotEligibleError(`SYSTEM_USER_NOT_ELIGIBLE: username="${username}" is a reserved system actor, not a resettable account.`);
    }

    if (rawInput.dryRun) {
      const activeSessionCount = await tx.userSession.count({
        where: { userId: user.id, revokedAt: null }
      });
      throw new DryRunCompleted(
        `Would reset password for username=${username} and revoke ${activeSessionCount} active session(s).`
      );
    }

    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });

    const { count: revokedSessions } = await tx.userSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() }
    });

    return { id: user.id, username: user.username, revokedSessions };
  });

  return { userId: result.id, username: result.username, revokedSessions: result.revokedSessions };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  requireRealTty();

  const password = await promptForNewPassword();
  const result = await resetPassword({ ...args, password });

  console.log(JSON.stringify(result, null, 2));
}

// Only run the interactive CLI when this file is executed directly — never
// as a side effect of importing resetPassword() for tests.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      if (error instanceof DryRunCompleted) {
        console.log(`DRY RUN — no changes written. ${error.summary}`);
        process.exit(0);
      }
      if (error instanceof NotFoundError) {
        console.error(`No changes made: ${error.message}`);
        process.exit(3);
      }
      if (error instanceof SystemUserNotEligibleError) {
        console.error(`No changes made: ${error.message}`);
        process.exit(4);
      }
      if (error instanceof UsageError) {
        console.error(`Usage error: ${error.message}`);
        process.exit(1);
      }
      console.error('Failed to reset password — no partial change was left committed.');
      process.exit(2);
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
