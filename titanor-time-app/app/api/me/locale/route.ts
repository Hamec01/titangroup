import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { isAppLocale, LOCALE_COOKIE_NAME } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/01_SCREEN_MAP.md §1 (/profile, not yet built) — the one endpoint from that
// screen's documented contract implemented ahead of the rest: "смена языка применяется без
// перезагрузки всего приложения" is satisfied by the caller doing router.refresh() after this
// call succeeds, not by anything server-side here. Same minimal self-service shape as
// POST /api/auth/logout (CSRF -> auth -> mutate -> cookie-bearing response), no extra permission
// gate beyond being authenticated as the account itself (same class as session.revoke.own,
// 02_ROLE_PERMISSION_MATRIX.md §2.1). No Idempotency-Key: this sets one scalar column to an
// explicit value with no derived side effects (no AuditEvent, no created resource) — unlike the
// row-creating POSTs that require one, two identical retries of this PATCH converge on the exact
// same end state regardless of ordering. Only 'EN'/'RU' accepted — 'FI' is a valid User.locale
// value elsewhere in the app (e.g. worker creation) but this endpoint's own UI (the EN/RU
// switcher) never offers it, so accepting it here would silently create a value the UI itself
// can't produce or reason about.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { locale } = bodyObject as { locale?: unknown };

  if (typeof locale !== 'string' || !isAppLocale(locale)) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { locale: ['must be EN or RU'] }, requestId } },
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  await prisma.user.update({ where: { id: authenticated.user.id }, data: { locale } });

  const response = new NextResponse(null, { status: 204, headers: successHeaders(requestId) });
  // A plain preference cookie, not a session credential — same reasoning app/login/page.tsx
  // already documents for its own copy of this cookie: not HttpOnly (the client mirrors it
  // itself for the offline-shell's client-only locale read), not a security boundary.
  response.cookies.set(LOCALE_COOKIE_NAME, locale, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365
  });
  return response;
}
