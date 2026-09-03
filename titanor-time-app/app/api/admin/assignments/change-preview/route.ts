import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { helsinkiToday } from '@/lib/workers';
import { overlappingPrimaryWhere } from '@/lib/assignment-lock';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §3.5 / §6 — the read-only "резюме перед
// подтверждением" for the worker card's ONE "Изменить место работы" form. Never mutates anything;
// it just tells the UI what POST /api/admin/assignments/:id/change WOULD do so the admin sees a
// plain-language summary (old → new, when, schedule change y/n, open-shift, and — critically — a
// warning when the change would replace an already-scheduled primary transfer, §P4).
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Place {
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
  templateId: string | null;
  templateName: string | null;
  isPrimary: boolean;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'assignment.split'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId : '';
  const effectiveFrom = typeof body.effectiveFrom === 'string' ? body.effectiveFrom : '';
  const siteId = typeof body.siteId === 'string' ? body.siteId : '';
  const workAreaId = typeof body.workAreaId === 'string' && body.workAreaId ? body.workAreaId : null;
  const templateId = typeof body.templateId === 'string' && body.templateId ? body.templateId : null;
  /** The form's "This is the main workplace" checkbox — defaults to the assignment's current flag. */
  const wantsPrimaryInput = typeof body.isPrimary === 'boolean' ? body.isPrimary : null;

  if (!UUID_PATTERN.test(assignmentId) || !DATE_PATTERN.test(effectiveFrom) || !UUID_PATTERN.test(siteId)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'assignmentId, effectiveFrom (YYYY-MM-DD) and siteId are required.' }, requestId);
  }

  const existing = await prisma.siteAssignment.findUnique({
    where: { id: assignmentId },
    include: {
      site: { select: { id: true, name: true } },
      workArea: { select: { id: true, name: true } },
      templateVersion: { select: { template: { select: { id: true, name: true } } } }
    }
  });
  if (!existing) {
    return jsonError(404, { code: 'ASSIGNMENT_NOT_FOUND', message: 'No assignment with this id.' }, requestId);
  }

  const today = helsinkiToday();
  const effectiveDate = new Date(`${effectiveFrom}T00:00:00.000Z`);
  const isImmediate = effectiveDate.getTime() <= today.getTime();
  const isBackdated = effectiveDate.getTime() < today.getTime();
  const startsToday = existing.validFrom.getTime() >= today.getTime();

  const [site, workArea, templateVersion] = await Promise.all([
    prisma.workSite.findUnique({ where: { id: siteId }, select: { id: true, name: true, active: true, finishedAt: true } }),
    workAreaId
      ? prisma.workArea.findFirst({ where: { id: workAreaId, siteId }, select: { id: true, name: true, active: true } })
      : Promise.resolve(null),
    templateId
      ? prisma.workScheduleTemplateVersion.findFirst({
          where: { templateId },
          orderBy: { versionNumber: 'desc' },
          select: { id: true, template: { select: { id: true, name: true } } }
        })
      : Promise.resolve(null)
  ]);

  if (!site) {
    return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'siteId does not reference an existing site.' }, requestId);
  }
  if (workAreaId && !workArea) {
    return jsonError(404, { code: 'WORK_AREA_NOT_FOUND', message: 'workAreaId does not reference a work area on this site.' }, requestId);
  }
  if (templateId && !templateVersion) {
    return jsonError(404, { code: 'TEMPLATE_NOT_FOUND', message: 'templateId does not reference an existing template.' }, requestId);
  }

  const newTemplateVersionId = templateVersion?.id ?? null;
  const wantsPrimary = wantsPrimaryInput ?? existing.isPrimary;

  const from: Place = {
    siteId: existing.site.id,
    siteName: existing.site.name,
    workAreaId: existing.workArea?.id ?? null,
    workAreaName: existing.workArea?.name ?? null,
    templateId: existing.templateVersion?.template.id ?? null,
    templateName: existing.templateVersion?.template.name ?? null,
    isPrimary: existing.isPrimary
  };
  const to: Place = {
    siteId: site.id,
    siteName: site.name,
    workAreaId: workArea?.id ?? null,
    workAreaName: workArea?.name ?? null,
    templateId: templateVersion?.template.id ?? null,
    templateName: templateVersion?.template.name ?? null,
    isPrimary: wantsPrimary
  };

  const sameSite = to.siteId === from.siteId;
  const sameArea = to.workAreaId === from.workAreaId;
  const sameTemplate = newTemplateVersionId === existing.templateVersionId;
  const nothingToChange = sameSite && sameArea && sameTemplate;

  // Open shift → the admin must choose KEEP_ON_OLD / MOVE_TO_NEW when the change is immediate.
  const openShift = await prisma.employeeOpenShift.findUnique({
    where: { employeeId: existing.employeeId },
    select: { id: true, openedAt: true }
  });
  const openShiftChoiceRequired = Boolean(openShift) && isImmediate;

  // §P4 — would making this primary overlap an ALREADY-SCHEDULED future primary transfer?
  let scheduledPrimaryConflict: { scheduledAssignmentId: string; scheduledValidFrom: string; label: string } | null = null;
  if (wantsPrimary) {
    const overlapping = await prisma.siteAssignment.findMany({
      where: {
        employeeId: existing.employeeId,
        id: { not: existing.id },
        ...overlappingPrimaryWhere({ validFrom: effectiveDate, validTo: existing.validTo })
      },
      select: { id: true, validFrom: true, site: { select: { name: true } }, workArea: { select: { name: true } } }
    });
    const scheduled = overlapping.filter((a) => a.validFrom > today).sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime())[0];
    if (scheduled) {
      scheduledPrimaryConflict = {
        scheduledAssignmentId: scheduled.id,
        scheduledValidFrom: scheduled.validFrom.toISOString().slice(0, 10),
        label: scheduled.workArea ? `${scheduled.site.name} — ${scheduled.workArea.name}` : scheduled.site.name
      };
    }
  }

  // Recorded / submitted time on the old assignment on or after the switch (mirrors the /change route
  // guard: for an immediate change only time AFTER today matters, §P5).
  const guardFrom = isImmediate ? new Date(today.getTime() + 24 * 60 * 60 * 1000) : effectiveDate;
  const [submittedCount, recordedCount] = await Promise.all([
    prisma.workSegment.count({ where: { sourceAssignmentId: existing.id, date: { gte: guardFrom } } }),
    prisma.timesheetDraftSegment.count({ where: { sourceAssignmentId: existing.id, date: { gte: guardFrom } } })
  ]);

  return NextResponse.json(
    {
      from,
      to,
      effectiveFrom,
      isImmediate,
      isBackdated,
      startsToday,
      nothingToChange: nothingToChange && wantsPrimary === existing.isPrimary,
      scheduleChanges: !sameTemplate,
      siteChanges: !sameSite,
      customerChanges: !sameArea,
      primaryChanges: wantsPrimary !== existing.isPrimary,
      openShiftChoiceRequired,
      openShiftOpenedAt: openShift?.openedAt.toISOString() ?? null,
      scheduledPrimaryConflict,
      siteFinished: site.finishedAt !== null || site.active === false,
      customerDisabled: workArea ? workArea.active === false : false,
      hasSubmittedTimeAfter: submittedCount > 0,
      hasRecordedTimeAfter: recordedCount > 0
    },
    { status: 200, headers: successHeaders(requestId) }
  );
}
