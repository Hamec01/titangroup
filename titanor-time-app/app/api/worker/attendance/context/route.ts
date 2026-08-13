import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { helsinkiToday } from '@/lib/workers';
import { bootstrapDeviceInstallation, buildAttendanceContext } from '@/lib/attendance-sync';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.2 / task brief §2 —
// GET /api/worker/attendance/context. Bootstraps or refreshes the caller's own
// WorkerDeviceInstallation and returns current assignments + each site's CURRENT geofence
// snapshot (never historical versions, never raw employee GPS — this endpoint never touches
// ClockEventLocation). employeeId always resolved from the session, never from the request.
// Reuses the already-seeded attendance.clock.read.own permission — no new grant needed for this
// route (only POST /sync needed a new one, attendance.clock.sync.own).
const MAX_PLATFORM_LENGTH = 32;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'attendance.clock.read.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  if (!authenticated.user.employeeId) {
    return jsonError(403, { code: 'NO_EMPLOYEE_PROFILE', message: 'This user has no linked employee profile.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const deviceInstallationId = searchParams.get('deviceInstallationId');
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!deviceInstallationId || !UUID_PATTERN.test(deviceInstallationId)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request.', fieldErrors: { deviceInstallationId: ['required, must be a UUID query parameter'] } }, requestId);
  }

  const rawPlatform = searchParams.get('platform');
  if (rawPlatform !== null && rawPlatform.length > MAX_PLATFORM_LENGTH) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request.', fieldErrors: { platform: [`must be at most ${MAX_PLATFORM_LENGTH} characters`] } }, requestId);
  }
  const platform = rawPlatform && rawPlatform.length > 0 ? rawPlatform : null;

  // userAgent is taken ONLY from the HTTP header — never trusted from a query/body copy (§2 task
  // requirement).
  const userAgent = request.headers.get('user-agent');

  const bootstrap = await bootstrapDeviceInstallation(authenticated.user.employeeId, deviceInstallationId, platform, userAgent);

  switch (bootstrap.kind) {
    case 'FORBIDDEN':
      // Same code/message regardless of whether the id belongs to another employee or simply
      // doesn't resolve the way the caller expected — never reveals which is true (§2 task
      // requirement: "одинаковый безопасный FORBIDDEN/DEVICE_NOT_OWNED, без раскрытия владельца").
      return jsonError(403, { code: 'DEVICE_NOT_OWNED', message: 'This device is not registered to your account.' }, requestId);
    case 'REVOKED':
      return jsonError(403, { code: 'DEVICE_REVOKED', message: 'This device has been revoked.' }, requestId);
    case 'OK':
      break;
  }

  const context = await buildAttendanceContext(authenticated.user.employeeId, helsinkiToday(), bootstrap.installation.id, bootstrap.installation.lastProcessedSequence);
  return NextResponse.json(context, { status: 200, headers: successHeaders(requestId) });
}
