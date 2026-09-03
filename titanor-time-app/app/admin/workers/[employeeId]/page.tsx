import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getWorkerDetail, helsinkiToday, assignmentEndDateDefaults } from '@/lib/workers';
import { getWorkerAssignmentCard } from '@/lib/assignment-card';
import { NewAssignmentForm } from '@/app/admin/assignments/new/NewAssignmentForm';
import { WorkplaceNowSection, ScheduledChangesSection, PastAssignmentsSection } from './WorkplaceSections';
import { WorkerActions } from './WorkerActions';
import { RecoveryCodeIssuer } from '@/components/account/RecoveryCodeIssuer';
import { WorkerSubmissionScheduleForm } from './WorkerSubmissionScheduleForm';
import { getWorkerSubmissionScheduleView } from '@/lib/timesheet-submission-schedules';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { getEmployeeProfileView } from '@/lib/employee-profile';
import { QualificationBadge } from '@/components/qualifications/QualificationBadge';
import { WorkerCardNav } from '@/components/admin/WorkerCardNav';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §2 (/admin/workers/[employeeId]).
// "Последние Timesheet" from the screen map's data list is not shown —
// Timesheet has no real data or endpoints yet (ЭТАП 7), so this only
// renders what getWorkerDetail() actually computes from real rows, same
// "не декоративный dashboard" principle as /admin/setup.
export default async function WorkerDetailPage({ params }: { params: Promise<{ employeeId: string }> }) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();
  const ru = locale === 'RU';
  const s = adminDailyStrings(locale);

  const isAdmin = session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN');
  if (!isAdmin) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          {s.accessDenied}
        </p>
      </main>
    );
  }

  const { employeeId } = await params;
  const worker = await getWorkerDetail(employeeId);

  if (!worker) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p className="login-error" role="alert">
            {s.workers.notFound}
          </p>
        </div>
      </main>
    );
  }

  const [submissionSchedule, profile, assignmentCard] = await Promise.all([
    getWorkerSubmissionScheduleView(employeeId),
    getEmployeeProfileView(employeeId, false),
    getWorkerAssignmentCard(employeeId)
  ]);
  const endDateDefaults = Object.fromEntries(
    await assignmentEndDateDefaults(assignmentCard.currentAssignments.map((a) => a.assignmentId))
  );
  const todayIso = helsinkiToday().toISOString().slice(0, 10);
  const tomorrowIso = new Date(helsinkiToday().getTime() + 86400000).toISOString().slice(0, 10);
  const safetyCard = profile?.qualifications.find((q) => q.definitionCode === 'OCCUPATIONAL_SAFETY_CARD') ?? null;
  const hotWorkCard = profile?.qualifications.find((q) => q.definitionCode === 'HOT_WORK_CARD') ?? null;
  const expiryDates = (profile?.qualifications ?? []).filter((q) => q.expiresOn !== null).sort((a, b) => (a.expiresOn! < b.expiresOn! ? -1 : 1));
  const nearestExpiry = expiryDates[0] ?? null;

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <WorkerCardNav employeeId={employeeId} employeeName={`${worker.firstName} ${worker.lastName}`} current="overview" locale={locale} />
        <h1>
          {worker.firstName} {worker.lastName}
        </h1>
        <section id="worker-status" aria-label="Worker status">
          <h2>{s.common.status}</h2>
          <p className="setup-subtitle">
            {s.workers.employeeNumber}: {worker.employeeNumber} · {s.workers.login}: {worker.username} ·{' '}
            {worker.employment?.active ? s.workers.activeEmployment : s.workers.employmentEnded} ·{' '}
            {s.workers.activation[worker.activationStatus as keyof typeof s.workers.activation]}
          </p>
          {worker.activationStatus === 'ALREADY_ACTIVE' ? (
            <div style={{ marginTop: 8 }}>
              <p className="setup-subtitle">{ru ? 'Работник забыл пароль?' : 'Worker forgot their password?'}</p>
              <RecoveryCodeIssuer kind="worker" id={employeeId} login={worker.username} />
            </div>
          ) : null}
        </section>
        <section className="worker-work-setup" aria-label={ru ? 'Допуски и сертификаты' : 'Qualifications'}>
          <h2>{ru ? 'Допуски и сертификаты' : 'Qualifications'}</h2>
          <p className="setup-subtitle">
            <Link href={`/admin/workers/${employeeId}/profile#qualifications`}>
              {ru ? 'Карта техники безопасности' : 'Occupational safety'}:{' '}
            </Link>
            {safetyCard ? <QualificationBadge status={safetyCard.expiryStatus} color={safetyCard.expiryColor} locale={locale} /> : <QualificationBadge status="MISSING_EXPIRY" color="RED" locale={locale} missingCard />}
          </p>
          <p className="setup-subtitle">
            <Link href={`/admin/workers/${employeeId}/profile#qualifications`}>
              {ru ? 'Карта огневых работ' : 'Hot work'}:{' '}
            </Link>
            {hotWorkCard ? <QualificationBadge status={hotWorkCard.expiryStatus} color={hotWorkCard.expiryColor} locale={locale} /> : <QualificationBadge status="MISSING_EXPIRY" color="RED" locale={locale} missingCard />}
          </p>
          <p className="setup-subtitle">
            {ru ? 'Сертификаты' : 'Certificates'}: {profile?.qualifications.length ?? 0}
            {nearestExpiry ? (
              <>
                {' · '}
                <Link href={`/admin/workers/${employeeId}/profile#qualifications`}>
                  {ru ? 'Ближайшее истечение' : 'Next expiry'}: {locale === 'RU' && nearestExpiry.nameRu ? nearestExpiry.nameRu : nearestExpiry.name} · {nearestExpiry.expiresOn}
                </Link>
              </>
            ) : null}
          </p>
        </section>
        <section className="worker-work-setup" aria-label={ru ? 'Быстрые действия' : 'Quick actions'}>
          <h2>{ru ? 'Быстрые действия' : 'Quick actions'}</h2>
          <ul className="setup-list">
            <li className="setup-item"><Link href={`/admin?employeeId=${employeeId}`}>{ru ? 'Статус работника на «Сегодня»' : 'Worker status on Today'}</Link></li>
            <li className="setup-item"><Link href={`#worker-assignments`}>{ru ? 'Объект и назначения' : 'Site and assignments'}</Link></li>
            <li className="setup-item"><Link href={`#worker-profile`}>{ru ? 'Редактирование имени и статуса' : 'Edit name and status'}</Link></li>
            <li className="setup-item"><Link href={`/admin/attendance/exceptions?employeeId=${employeeId}`}>{ru ? 'Проблемы работника' : 'Worker issues'}</Link></li>
            <li className="setup-item"><Link href={`/admin/reports?employeeId=${employeeId}`}>{s.workers.report}</Link></li>
          </ul>
        </section>

        <WorkplaceNowSection
          card={assignmentCard}
          today={todayIso}
          tomorrow={tomorrowIso}
          endDateDefaults={endDateDefaults}
          locale={locale}
        />
        <ScheduledChangesSection card={assignmentCard} locale={locale} />
        <PastAssignmentsSection card={assignmentCard} locale={locale} />

        <section className="worker-work-setup">
          <h2>{s.workers.addWork}</h2>
          <p className="setup-subtitle">{s.workers.addWorkHelp}</p>
          <NewAssignmentForm
            initialEmployeeId={worker.id}
            initialValidFrom={todayIso}
            initialIsPrimary={assignmentCard.currentAssignments.length === 0}
            returnEmployeeId={worker.id}
            lockEmployee
          />
        </section>

        {submissionSchedule ? (
          <section id="worker-submission" className="worker-work-setup">
            <h2>{s.workers.submission}</h2>
            <p className="setup-subtitle">{s.workers.submissionHelp}</p>
            <WorkerSubmissionScheduleForm employeeId={worker.id} view={submissionSchedule} />
          </section>
        ) : null}

        {worker.employment && !worker.employment.active ? (
          <p className="setup-subtitle">
            Ended {worker.employment.endDate}
            {worker.employment.deactivationReason ? ` — ${worker.employment.deactivationReason}` : ''}
          </p>
        ) : null}

        <WorkerActions worker={worker} />
      </div>
    </main>
  );
}
