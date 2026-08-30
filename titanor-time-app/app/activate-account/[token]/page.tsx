import Link from 'next/link';
import { headers } from 'next/headers';
import { verifySystemActivationToken } from '@/lib/system-activation';
import { checkRateLimit } from '@/lib/rate-limit';
import { clientRateLimitKey } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  TOKEN_EXPIRED: 'This activation code has expired. Ask your admin to issue a new one.',
  TOKEN_USED: 'This activation code has already been used. If you already set a password, log in instead.',
  TOKEN_INVALID: 'This activation code is not valid.',
  RATE_LIMITED: 'Too many attempts. Try again later.'
};

// Same IP rate-limit namespace as GET /api/auth/activate-account (app/api/auth/activate-account/
// route.ts) — this Server Component calls lib/system-activation.ts directly (project convention:
// no internal fetch to the app's own API), same pattern as app/activate/[token]/page.tsx (worker),
// but the two surfaces intentionally share one bucket per IP.
const IP_RATE_LIMIT = { limit: 30, windowMs: 15 * 60 * 1000 };

type RouteParams = { params: Promise<{ token: string }> };

// docs/titanor-time/01_SCREEN_MAP.md — /activate-account/[token]. Confirms identity ("это вы?")
// before handing off to /set-account-password. Only ever calls verifySystemActivationToken —
// never the worker's verifyActivationToken.
export default async function ActivateAccountTokenPage({ params }: RouteParams) {
  const { token } = await params;
  const requestHeaders = await headers();
  const result = (await checkRateLimit(
    `activate-account-ip:${clientRateLimitKey(requestHeaders)}`,
    IP_RATE_LIMIT.limit,
    IP_RATE_LIMIT.windowMs
  ))
    ? await verifySystemActivationToken(token)
    : { code: 'RATE_LIMITED' as const };

  if ('code' in result) {
    return (
      <main className="login-page">
        <div className="login-card">
          <h1>Activate your foreman account</h1>
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
        <h1>Activate your foreman account</h1>
        <p>
          Is this you? <strong>{result.username}</strong>
        </p>
        <p>
          <Link className="login-submit" href={`/set-account-password?token=${encodeURIComponent(token)}`}>
            Continue
          </Link>
        </p>
      </div>
    </main>
  );
}
