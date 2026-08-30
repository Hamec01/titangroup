import { AccessDeniedNotice } from '@/components/admin/AccessDeniedNotice';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { getCompanyAttendancePolicy } from '@/lib/attendance-policy';
import { PolicyForm } from '@/components/attendance-policy/PolicyForm';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md `/admin/attendance/policy` (T7A.10B) — Server Component reads
// CompanyAttendancePolicy directly through the same server-only lib/attendance-policy.ts the route
// handler uses (no HTTP self-fetch to our own API). Read and update are gated independently by
// permission (attendance.policy.read / attendance.policy.update), never by role membership — a
// viewer with read but not update gets a read-only view of the same data, matching the established
// pattern from /admin/attendance/exceptions/[exceptionId].
export default async function AdminAttendancePolicyPage() {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();

  const canRead = await hasPermission(session.user.roles, 'attendance.policy.read');
  if (!canRead) {
    return (
      <AccessDeniedNotice area="attendance-policy" locale={locale} permission="attendance.policy.read" />
    );
  }

  const canUpdate = await hasPermission(session.user.roles, 'attendance.policy.update');
  const policy = await getCompanyAttendancePolicy();

  return (
    <main className="setup-page">
      <div className="setup-card policy-card">
        <h1>{localeText(locale, 'Attendance policy', 'Политика учёта времени')}</h1>
        <p className="setup-subtitle">
          {localeText(locale, 'Company-wide settings controlling when an unsubmitted timesheet is automatically submitted, and how long a late-sync reopen waits before retrying.', 'Общекорпоративные настройки, определяющие, когда неотправленный табель отправляется автоматически, и сколько ждёт повторная попытка при повторном открытии из-за поздней синхронизации.')}
        </p>
        <div className="policy-notice" role="note">
          {localeText(locale, 'Auto-submit is not an approval. An automatically submitted version still goes through the same foreman and admin review route as a manual submission.', 'Автоотправка — это не одобрение. Автоматически отправленная версия всё равно проходит тот же маршрут проверки прорабом и администратором, что и ручная отправка.')}
        </div>
        <div className="policy-notice policy-notice-warning" role="note">
          {localeText(locale, 'Changing this policy never rewrites any existing timesheet version or auto-submission attempt — a new value only applies to candidates not yet processed by the next scheduler tick.', 'Изменение этой политики никогда не переписывает существующие версии табелей или попытки автоотправки — новое значение применяется только к кандидатам, ещё не обработанным следующим тактом планировщика.')}
        </div>
        <PolicyForm initialPolicy={policy} canUpdate={canUpdate} />
      </div>
    </main>
  );
}
