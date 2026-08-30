import { NextResponse } from 'next/server';

// R07-B — CSRF guard for public-site admin mutations. Same "custom header a cross-site form or a
// simple request cannot set" mechanism Titanor Time uses: the admin UI (client components) sends
// `X-Requested-With: titanor-admin` on every mutating fetch. A browser cannot attach that header
// on a cross-origin form POST or `<img>`/`<script>` request, so a state-changing request that
// carries it must have come from our own first-party JavaScript.

export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'titanor-admin';

/** Returns a 403 `NextResponse` when the CSRF header is missing/wrong, or `null` when it is fine. */
export function rejectIfCsrfMissing(request: Request): NextResponse | null {
  if (request.headers.get(CSRF_HEADER) === CSRF_HEADER_VALUE) return null;
  return NextResponse.json(
    { error: 'Missing or invalid X-Requested-With header.' },
    { status: 403, headers: { 'Cache-Control': 'no-store' } }
  );
}
