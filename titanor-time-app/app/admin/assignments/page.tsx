import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listAssignments } from '@/lib/assignments';
import { EndAssignmentAction } from './EndAssignmentAction';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { helsinkiToday } from '@/lib/workers';
import { localeText, type AppLocale } from '@/lib/i18n/locale';
import type { AssignmentListItem } from '@/lib/assignments';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

type ListState = 'ACTIVE' | 'SCHEDULED' | 'REMOVED' | 'ENDED';

/** Removed (Check-In disabled) and past assignments no longer run — they get no "End" action. */
function listState(a: AssignmentListItem, todayIso: string, nowIso: string): ListState {
  if (a.clockInDisabledAt !== null && a.clockInDisabledAt <= nowIso) return 'REMOVED';
  if (a.validTo !== null && a.validTo < todayIso) return 'ENDED';
  return a.validFrom > todayIso ? 'SCHEDULED' : 'ACTIVE';
}

function stateText(locale: AppLocale, state: ListState): string {
  switch (state) {
    case 'ACTIVE': return localeText(locale, 'Active', 'Действует');
    case 'SCHEDULED': return localeText(locale, 'Scheduled', 'Запланировано');
    case 'REMOVED': return localeText(locale, 'Removed', 'Снято');
    default: return localeText(locale, 'Ended', 'Завершено');
  }
}

// docs/titanor-time/01_SCREEN_MAP.md — read-only assignment list
// (PROJECT_ROADMAP.md T6.8 continuation, GET /api/admin/assignments).
// Page 1 only, no search/filter/sort UI — not called out for this specific
// endpoint's contract (unlike GET /api/admin/sites), same scope call as
// /admin/workers's list page.
export default async function AdminAssignmentsPage() {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();
  const s = adminDailyStrings(locale);
  const todayIso = helsinkiToday().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();

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

  const { items, totalItems } = await listAssignments(1, PAGE_SIZE);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{s.assignments.title}</h1>
        <p className="setup-subtitle">
          {totalItems} {totalItems === 1 ? s.assignments.singular : s.assignments.plural} ·{' '}
          <Link href="/admin/assignments/new">{s.common.createNew}</Link>
        </p>
        {items.length === 0 ? (
          <p>{s.assignments.empty}</p>
        ) : (
          <div className="worker-table-scroll">
          <table className="worker-table">
            <thead>
              <tr>
                <th>{s.assignments.worker}</th>
                <th>{s.assignments.site}</th>
                <th>{s.assignments.workArea}</th>
                <th>{s.assignments.template}</th>
                <th>{s.assignments.validFrom}</th>
                <th>{s.assignments.validTo}</th>
                <th>{localeText(locale, 'Status', 'Статус')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((assignment) => (
                <tr key={assignment.id}>
                  <td>
                    <Link href={`/admin/workers/${assignment.employeeId}`}>{assignment.employeeName}</Link>
                  </td>
                  <td>
                    <Link href={`/admin/sites/${assignment.siteId}`}>{assignment.siteName}</Link>
                  </td>
                  <td>{assignment.workAreaName ?? '—'}</td>
                  <td>{assignment.templateName ?? '—'}</td>
                  <td>{assignment.validFrom}</td>
                  <td>{assignment.validTo ?? s.common.indefinite}</td>
                  <td className={`assignment-list-state is-${listState(assignment, todayIso, nowIso).toLowerCase()}`}>{stateText(locale, listState(assignment, todayIso, nowIso))}</td>
                  <td>
                    {['ACTIVE', 'SCHEDULED'].includes(listState(assignment, todayIso, nowIso)) ? (
                      <EndAssignmentAction assignment={assignment} defaultValidTo={assignment.validFrom > todayIso ? assignment.validFrom : todayIso} />
                    ) : null}
                  </td>
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
