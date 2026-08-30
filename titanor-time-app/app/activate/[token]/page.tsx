import Link from 'next/link';
import { headers } from 'next/headers';
import { verifyActivationToken } from '@/lib/activation';
import { checkRateLimit } from '@/lib/rate-limit';
import { clientRateLimitKey } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  TOKEN_EXPIRED: 'This activation code has expired. Ask your admin to issue a new one.',
  TOKEN_USED: 'This activation code has already been used. If you already set a password, log in instead.',
  TOKEN_INVALID: 'This activation code is not valid.',
  RATE_LIMITED: 'Too many attempts. Try again later.'
};

const IP_RATE_LIMIT = { limit: 30, windowMs: 15 * 60 * 1000 };

type RouteParams = { params: Promise<{ token: string }> };

// docs/titanor-time/01_SCREEN_MAP.md §1 `/activate/[token]` — confirms identity ("это вы?") before
// handing off to /set-password. Server Component calling lib/activation.ts directly, same
// convention as every other page in this app (no internal fetch to its own API route).
export default async function ActivatePage({ params }: RouteParams) {
  const { token } = await params;
  const requestHeaders = await headers();
  const result = (await checkRateLimit(
    `activate-ip:${clientRateLimitKey(requestHeaders)}`,
    IP_RATE_LIMIT.limit,
    IP_RATE_LIMIT.windowMs
  ))
    ? await verifyActivationToken(token)
    : { code: 'RATE_LIMITED' as const };

  if ('code' in result) {
    return (
      <main className="login-page">
        <div className="login-card">
          <h1>Activate your account</h1>
          <p className="login-error" role="alert">
            {ERROR_MESSAGES[result.code] ?? 'This activation code is not valid.'}
          </p>
          <p>
            <Link href="/login">Back to login</Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="login-page">
      <div className="login-card">
        <h1>Activate your account</h1>
        <p>
          Is this you? <strong>{result.employeeFirstName} {result.employeeLastNameInitial}</strong>
        </p>
        <p>
          <Link className="login-submit" href={`/set-password?token=${encodeURIComponent(token)}`}>
            Continue
          </Link>
        </p>
      </div>
    </main>
  );
}
