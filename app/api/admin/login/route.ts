import { NextResponse } from 'next/server';
import {
  createAdminSessionToken,
  getAdminSessionCookieName,
  getAdminSessionCookieOptions,
  isAdminPasswordValid
} from '../../../../lib/admin-auth';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { password?: string };
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!password || !isAdminPasswordValid(password)) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(
      getAdminSessionCookieName(),
      createAdminSessionToken(),
      getAdminSessionCookieOptions()
    );

    return response;
  } catch {
    return NextResponse.json({ error: 'Unable to sign in' }, { status: 500 });
  }
}
