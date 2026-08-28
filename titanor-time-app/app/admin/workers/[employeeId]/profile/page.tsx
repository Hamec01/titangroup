import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { getEmployeeProfileView } from '@/lib/employee-profile';
import { listEmployeeProfessions, listProfessionCatalog } from '@/lib/professions';
import { AdminWorkerProfileForm } from './AdminWorkerProfileForm';
import { EmployeeProfessionsEditor } from '@/components/professions/EmployeeProfessionsEditor';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

// Worker Profile feature (2026-08-24 plan) — sibling to timeline/locations sub-pages.
// Does not touch the existing #worker-profile anchor/inline edit form in WorkerActions.tsx.
export default async function AdminWorkerProfilePage({ params }: { params: Promise<{ employeeId: string }> }) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();
  if (!(await hasPermission(session.user.roles, 'worker.profile.read.all'))) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          {localeText(locale, 'Access denied.', 'Доступ запрещён.')}
        </p>
      </main>
    );
  }

  const { employeeId } = await params;
  const canManageProfessions = await hasPermission(session.user.roles, 'worker.profession.manage');
  const [profile, professions, professionCatalog] = await Promise.all([
    getEmployeeProfileView(employeeId, true),
    listEmployeeProfessions(employeeId),
    listProfessionCatalog()
  ]);
  if (!profile) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p className="login-error" role="alert">
            {localeText(locale, 'Worker not found.', 'Работник не найден.')}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <p>
          <Link href={`/admin/workers/${employeeId}`}>← {localeText(locale, 'Back to worker', 'Назад к работнику')}</Link>
        </p>
        <h1>{localeText(locale, 'Worker profile & documents', 'Профиль и документы работника')}</h1>
        {canManageProfessions ? (
          <EmployeeProfessionsEditor employeeId={employeeId} initialProfessions={professions} catalog={professionCatalog} />
        ) : null}
        <AdminWorkerProfileForm employeeId={employeeId} initialProfile={profile} />
      </div>
    </main>
  );
}
