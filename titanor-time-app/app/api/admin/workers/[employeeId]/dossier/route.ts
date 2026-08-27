import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, personalDataEncryptionUnavailable } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { getWorkerDossierData, type WorkerDossierData } from '@/lib/worker-dossier';
import { buildWorkerDossierPdf, workerDossierPdfFileName } from '@/lib/reporting/worker-dossier-pdf';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Worker Dossier PDF export (task spec §27-29, §41) — canonical route:
// GET /api/admin/workers/:employeeId/dossier. Generated on demand, never persisted (no public/
// uploads/DB storage of the finished PDF) — this handler is the only place the bytes exist,
// for the duration of one request/response.
export async function GET(request: NextRequest, { params }: { params: Promise<{ employeeId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'worker.profile.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { employeeId } = await params;
  if (!UUID_PATTERN.test(employeeId)) {
    return jsonError(404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' }, requestId);
  }

  let data: WorkerDossierData | null;
  try {
    data = await getWorkerDossierData(employeeId);
  } catch (error) {
    return personalDataEncryptionUnavailable(error, requestId);
  }
  if (!data) {
    return jsonError(404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' }, requestId);
  }

  // Deliberately NOT the admin's own UI locale (resolveAppLocale()) — data entry stays in
  // Russian for worker accessibility, but exported official documents (dossier, accounting/
  // report exports) are always English, independent of the admin's display language.
  const locale = 'EN' as const;
  const generatedAtHelsinki = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const fileDateHelsinki = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  let pdf: Buffer;
  try {
    pdf = await buildWorkerDossierPdf(data, locale, generatedAtHelsinki);
  } catch (error) {
    // Never let a generation failure leak henkilötunnus/any profile field into the error path
    // (task spec §40) — log only that generation failed, not why in terms of field content.
    console.error('worker dossier PDF generation failed', { requestId, employeeId });
    throw error;
  }

  await prisma.$transaction(async (tx) => {
    await createAuditEvent(tx, {
      actorUserId: authenticated.user.id,
      eventType: 'WORKER_DOSSIER_DOWNLOADED',
      entityType: 'EMPLOYEE',
      entityId: employeeId,
      requestId,
      beforeValue: null,
      afterValue: { documentType: 'WORKER_DOSSIER' }
    });
  });

  const filename = workerDossierPdfFileName(data.employeeNumber, fileDateHelsinki);
  return new NextResponse(pdf, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': requestId
    }
  });
}
