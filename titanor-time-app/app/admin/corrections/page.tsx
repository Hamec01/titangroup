import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listCorrections } from '@/lib/corrections';
import { correctionStatusLabel } from '@/lib/attendance-overview-ui';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.7 T7.9 — admin-only corrections list. New requests are
// started from the FINAL_APPROVED timesheet's own card (/admin/timesheets/[timesheetId]), not a
// standalone form here — a timesheetId is meaningless to type in by hand.
export default async function AdminCorrectionsPage() {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();
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

  const items = await listCorrections();

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{localeText(locale, 'Corrections', 'Корректировки')}</h1>
        <p className="setup-subtitle">{localeText(locale, `${items.length} total`, `Всего: ${items.length}`)}</p>
        {items.length === 0 ? (
          <p>{localeText(locale, "No correction requests yet. Start one from a FINAL_APPROVED timesheet's card.", 'Запросов на корректировку пока нет. Начните с карточки окончательно одобренного табеля.')}</p>
        ) : (
          <div className="worker-table-scroll">
          <table className="worker-table">
            <thead>
              <tr>
                <th>{s.common.name}</th>
                <th>{s.common.status}</th>
                <th>{localeText(locale, 'Reason', 'Причина')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.employeeName}</td>
                  <td>
                    <Link href={`/admin/corrections/${item.id}`}>{correctionStatusLabel(item.status, locale)}</Link>
                  </td>
                  <td>{item.directEdit ? <em>{localeText(locale, 'direct hours edit', 'прямая правка часов')}</em> : item.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </main>
  );
}
