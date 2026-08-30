import { NextResponse } from 'next/server';
import { getAdminSessionCookieName, getAdminSessionClearOptions } from '../../../../lib/admin-auth';
import { rejectIfCsrfMissing } from '../../../../lib/csrf';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const csrf = rejectIfCsrfMissing(request);
  if (csrf) return csrf;

  const response = NextResponse.json({ ok: true });
  response.cookies.set(getAdminSessionCookieName(), '', getAdminSessionClearOptions());
  return response;
}
