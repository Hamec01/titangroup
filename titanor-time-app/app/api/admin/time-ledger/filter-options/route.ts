import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { searchCustomerWorkAreas } from '@/lib/reporting/customer-workarea-picker';

// UT4-B — GET /api/admin/time-ledger/filter-options?type=customer&q=... . The единый табель page's
// OWN customer/work-area picker, deliberately separate from GET /api/admin/reports/customer/scope
// (that endpoint requires export.read + worker.read.all + site.read.all, a strictly larger
// permission set than the ledger page itself needs — timesheet.read.all only). Read-only, bounded
// (searchCustomerWorkAreas's own take<=200), never derives options from the paginated ledger
// response itself (options must stay stable across pagination).
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SUPPORTED_PARAMS = ['type', 'q'] as const;
const VALID_TYPES = new Set(['customer']);
const OPTIONS_LIMIT = 200;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'timesheet.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const sp = request.nextUrl.searchParams;
  const fieldErrors: Record<string, string[]> = {};

  for (const name of SUPPORTED_PARAMS) {
    if (sp.getAll(name).length > 1) {
      fieldErrors[name] = ['must not be repeated'];
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'A query parameter was repeated.', fieldErrors }, requestId);
  }

  const type = sp.get('type');
  if (type === null || !VALID_TYPES.has(type)) {
    fieldErrors.type = [`must be one of: ${[...VALID_TYPES].join(', ')}`];
  }
  const q = sp.get('q') ?? '';
  if (q.length > 120) {
    fieldErrors.q = ['must be 120 characters or fewer'];
  }

  if (Object.keys(fieldErrors).length > 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid query parameters.', fieldErrors }, requestId);
  }

  const workAreas = await searchCustomerWorkAreas(q, { limit: OPTIONS_LIMIT });
  return NextResponse.json({ workAreas }, { status: 200, headers: successHeaders(requestId) });
}
