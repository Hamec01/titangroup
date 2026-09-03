import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { helsinkiToday } from '@/lib/workers';
import { groupChangeWorkplace, groupChangeWorkplacePreview } from '@/lib/assignment-lifecycle-service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §M / §8-E — "Групповой перевод". GET
// returns the preflight breakdown (READY / has hours after / already scheduled) for every live
// assignment on a source site (optionally one customer); POST moves the READY ones in ONE
// transaction under one groupId. FUTURE-dated only. No migration.
const CSRF = 'titanor-time';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseDateUtcMidnight(s: unknown): Date | null {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  if (!(await hasPermission(authenticated.user.roles, 'assignment.split'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  const url = new URL(request.url);
  const sourceSiteId = url.searchParams.get('sourceSiteId') ?? '';
  const sourceWorkAreaId = url.searchParams.get('sourceWorkAreaId');
  const effectiveFrom = parseDateUtcMidnight(url.searchParams.get('effectiveFrom'));
  const targetIsPrimary = url.searchParams.get('isPrimary') !== 'false';
  if (!UUID.test(sourceSiteId)) return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId);
  if (sourceWorkAreaId !== null && !UUID.test(sourceWorkAreaId)) {
    return jsonError(404, { code: 'WORK_AREA_NOT_FOUND', message: 'No customer with this id.' }, requestId);
  }
  if (!effectiveFrom) return jsonError(400, { code: 'VALIDATION_ERROR', message: 'effectiveFrom must be YYYY-MM-DD.' }, requestId);
  if (effectiveFrom.getTime() <= helsinkiToday().getTime()) {
    return jsonError(400, { code: 'EFFECTIVE_FROM_NOT_FUTURE', message: 'A group transfer is always scheduled — pick a future date.' }, requestId);
  }

  const preview = await groupChangeWorkplacePreview({ sourceSiteId, sourceWorkAreaId, effectiveFrom, targetIsPrimary });
  if (!preview) return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId);
  return NextResponse.json(preview, { status: 200, headers: successHeaders(requestId) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.headers.get('x-requested-with') !== CSRF) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  if (!(await hasPermission(authenticated.user.roles, 'assignment.split'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.json();
    body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const { assignmentIds, siteId, workAreaId, templateId, isPrimary, effectiveFrom, reason } = body as {
    assignmentIds?: unknown;
    siteId?: unknown;
    workAreaId?: unknown;
    templateId?: unknown;
    isPrimary?: unknown;
    effectiveFrom?: unknown;
    reason?: unknown;
  };

  const fieldErrors: Record<string, string[]> = {};
  const ids = Array.isArray(assignmentIds) ? assignmentIds.filter((x): x is string => typeof x === 'string' && UUID.test(x)) : [];
  if (ids.length === 0 || ids.length !== (Array.isArray(assignmentIds) ? assignmentIds.length : -1)) fieldErrors.assignmentIds = ['required, all UUIDs'];
  if (typeof siteId !== 'string' || !UUID.test(siteId)) fieldErrors.siteId = ['required'];
  const normalizedWorkAreaId = workAreaId === undefined || workAreaId === null || workAreaId === '' ? null : workAreaId;
  if (normalizedWorkAreaId !== null && (typeof normalizedWorkAreaId !== 'string' || !UUID.test(normalizedWorkAreaId))) fieldErrors.workAreaId = ['invalid'];
  const normalizedTemplateId = templateId === undefined || templateId === null || templateId === '' ? null : templateId;
  if (normalizedTemplateId !== null && (typeof normalizedTemplateId !== 'string' || !UUID.test(normalizedTemplateId))) fieldErrors.templateId = ['invalid'];
  if (isPrimary !== undefined && typeof isPrimary !== 'boolean') fieldErrors.isPrimary = ['invalid'];
  const effFrom = parseDateUtcMidnight(effectiveFrom);
  if (!effFrom) fieldErrors.effectiveFrom = ['required, YYYY-MM-DD'];
  if (reason !== undefined && typeof reason !== 'string') fieldErrors.reason = ['invalid'];
  if (Object.keys(fieldErrors).length > 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId);
  }

  // Target site / customer — a clean 409 before the batch (the service enforces it too).
  const site = await prisma.workSite.findUnique({ where: { id: siteId as string }, select: { active: true, finishedAt: true } });
  if (!site) return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'siteId does not reference an existing site.' }, requestId);
  if (site.finishedAt !== null || !site.active) {
    return jsonError(409, { code: 'SITE_FINISHED', message: 'The target site is finished — pick an active site.' }, requestId);
  }
  if (normalizedWorkAreaId !== null) {
    const wa = await prisma.workArea.findFirst({ where: { id: normalizedWorkAreaId as string, siteId: siteId as string }, select: { active: true } });
    if (!wa) return jsonError(404, { code: 'WORK_AREA_NOT_FOUND', message: 'workAreaId does not reference a customer on this site.' }, requestId);
    if (!wa.active) return jsonError(409, { code: 'CUSTOMER_DISABLED', message: 'The target customer is disabled.' }, requestId);
  }

  let templateVersionId: string | null = null;
  if (normalizedTemplateId !== null) {
    const v = await prisma.workScheduleTemplateVersion.findFirst({
      where: { templateId: normalizedTemplateId as string },
      orderBy: { versionNumber: 'desc' },
      select: { id: true }
    });
    if (!v) return jsonError(404, { code: 'TEMPLATE_NOT_FOUND', message: 'templateId does not reference an existing template.' }, requestId);
    templateVersionId = v.id;
  }

  const result = await groupChangeWorkplace({
    assignmentIds: ids,
    siteId: siteId as string,
    workAreaId: normalizedWorkAreaId as string | null,
    templateVersionId,
    isPrimary: isPrimary === undefined ? true : (isPrimary as boolean),
    effectiveFrom: effFrom!,
    reasonText: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
    actorUserId: authenticated.user.id,
    requestId
  });

  if ('code' in result) {
    switch (result.code) {
      case 'NO_ASSIGNMENTS':
        return jsonError(400, { code: 'NO_ASSIGNMENTS', message: 'assignmentIds is empty.' }, requestId);
      case 'EFFECTIVE_FROM_NOT_FUTURE':
        return jsonError(400, { code: 'EFFECTIVE_FROM_NOT_FUTURE', message: 'A group transfer must be scheduled for a future date.' }, requestId);
      case 'SOURCE_NOT_FOUND':
        return jsonError(404, { code: 'SOURCE_NOT_FOUND', message: 'One or more assignmentIds no longer exist — refresh and try again.' }, requestId);
      case 'SITE_FINISHED':
        return jsonError(409, { code: 'SITE_FINISHED', message: 'The target site is finished.' }, requestId);
      case 'CUSTOMER_DISABLED':
        return jsonError(409, { code: 'CUSTOMER_DISABLED', message: 'The target customer is disabled.' }, requestId);
      case 'BATCH_CONFLICT':
        return jsonError(
          409,
          {
            code: 'BATCH_CONFLICT',
            message: `One worker in the batch could not be transferred (${result.conflict}). Nothing was changed — refresh the preview and exclude that worker.`,
            employeeId: result.employeeId,
            assignmentId: result.assignmentId,
            conflict: result.conflict
          },
          requestId
        );
    }
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
