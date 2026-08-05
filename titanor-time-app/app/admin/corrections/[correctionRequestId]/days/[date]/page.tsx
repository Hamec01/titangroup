import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getCorrectionDetail } from '@/lib/corrections';
import { listWorkerCurrentAssignments } from '@/lib/worker-context';
import CorrectionDayEditor from './CorrectionDayEditor';

export const dynamic = 'force-dynamic';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type RouteParams = { params: Promise<{ correctionRequestId: string; date: string }> };

export default async function CorrectionDayEditorPage({ params }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const isAdmin = session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN');
  if (!isAdmin) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          Access denied — this page requires the ADMIN or SUPER_ADMIN role.
        </p>
      </main>
    );
  }

  const { correctionRequestId, date } = await params;
  if (!DATE_PATTERN.test(date)) {
    redirect(`/admin/corrections/${correctionRequestId}`);
  }

  const correction = await getCorrectionDetail(correctionRequestId);
  if (!correction || correction.status !== 'DRAFT_OPEN') {
    redirect(`/admin/corrections/${correctionRequestId}`);
  }

  const day = correction.days.find((d) => d.date === date);
  const dayDate = new Date(`${date}T00:00:00.000Z`);
  const assignments = await listWorkerCurrentAssignments(correction.employeeId, dayDate);

  return (
    <CorrectionDayEditor
      correctionRequestId={correctionRequestId}
      date={date}
      initialDayType={day?.dayType ?? 'WORK'}
      initialConfirmedZero={day?.confirmedZero ?? false}
      initialSegments={day?.segments ?? []}
      assignmentOptions={assignments.map((a) => ({ siteId: a.siteId, siteName: a.siteName, workAreaId: a.workAreaId, workAreaName: a.workAreaName }))}
    />
  );
}
