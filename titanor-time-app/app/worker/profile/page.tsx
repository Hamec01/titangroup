import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getEmployeeProfileView } from '@/lib/employee-profile';
import { WorkerProfileForm } from './WorkerProfileForm';
import { ConnectivityBanner } from '@/components/worker-pwa/ConnectivityBanner';
import { resolveAppLocale } from '@/lib/i18n/server';
import { COMMON_STRINGS } from '@/lib/i18n/common';
import { WORKER_STRINGS } from '@/lib/i18n/worker';
import { getAccountSettings } from '@/lib/account';
import { AccountSettingsForm } from '@/components/account/AccountSettingsForm';
import { hasPermission } from '@/lib/permissions';
import { listEmployeeProfessions, listProfessionCatalog } from '@/lib/professions';
import { EmployeeProfessionsEditor } from '@/components/professions/EmployeeProfessionsEditor';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §1 (/profile, "смена языка/пароля, просмотр своих
// данных") + Worker Profile feature (2026-08-24 plan) — extends that planned-but-unbuilt
// screen with self-service write capability (photo, specialty, skills, qualification
// cards). Everything here is optional; the page never blocks Check In/Out.
export default async function WorkerProfilePage() {
  const [session, locale] = await Promise.all([resolveServerSession(), resolveAppLocale()]);
  const common = COMMON_STRINGS[locale];
  const t = WORKER_STRINGS[locale];
  if (!session) {
    redirect('/login');
  }
  if (!session.user.roles.includes('WORKER')) {
    return (
      <main className="wk-page">
        <p className="login-error" role="alert">
          {common.accessDeniedWorker}
        </p>
      </main>
    );
  }
  if (!session.user.employeeId) {
    return (
      <main className="wk-page">
        <div className="wk-card">
          <p>{common.noEmployeeProfile}</p>
        </div>
      </main>
    );
  }

  const canManageProfessions = await hasPermission(session.user.roles, 'worker.profession.manage.own');
  const [profile, account, professions, professionCatalog] = await Promise.all([
    getEmployeeProfileView(session.user.employeeId, false),
    getAccountSettings(session.user.id),
    canManageProfessions ? listEmployeeProfessions(session.user.employeeId) : Promise.resolve([]),
    canManageProfessions ? listProfessionCatalog() : Promise.resolve([])
  ]);
  if (!profile) {
    return (
      <main className="wk-page">
        <div className="wk-card">
          <p>{common.noEmployeeProfile}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="wk-page">
      <div className="wk-card">
        <ConnectivityBanner />
        <h1>{t.profileTitle}</h1>
        {account ? <AccountSettingsForm initialEmail={account.email} username={account.username} roles={account.roles} /> : null}
        <WorkerProfileForm initialProfile={profile} />
        {canManageProfessions ? (
          <EmployeeProfessionsEditor
            employeeId={session.user.employeeId}
            apiBase="/api/worker/professions"
            ownProfile
            initialProfessions={professions}
            catalog={professionCatalog}
          />
        ) : null}
      </div>
    </main>
  );
}
