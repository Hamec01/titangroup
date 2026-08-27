import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getReviewQueue, type ReviewQueueSort } from '@/lib/admin-timesheets';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { ApproveTimesheetButton } from './ApproveTimesheetButton';

export const dynamic = 'force-dynamic';

type RouteParams = { searchParams: Promise<{ site?: string; issues?: string; sort?: string }> };

function fmtHours(minutes: number, ru: boolean): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return ru ? `${h} ч ${m} мин` : `${h} h ${m} min`;
}

// Task B — docs/titanor-time/T10_B_UNIFIED_REVIEW_DESIGN.md. One screen: every timesheet awaiting
// the admin across all OPEN periods, worker-centric, filter by site / only-issues / sort, one-click
// approve on clean rows, and a separate "ещё не сдали" block. Plain GET-form filters, no client fetch.
export default async function AdminReviewPage({ searchParams }: RouteParams) {
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

  const sp = await searchParams;
  const sort: ReviewQueueSort = sp.sort === 'hours' || sp.sort === 'site' ? sp.sort : 'name';
  const onlyIssues = sp.issues === '1';
  const siteId = sp.site || undefined;

  const queue = await getReviewQueue({ siteId, onlyIssues, sort });

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{ru ? 'На утверждении' : 'Awaiting approval'}</h1>
        <p className="setup-subtitle">{ru ? `Табелей: ${queue.rows.length}` : `${queue.rows.length} timesheets`}</p>

        <form method="GET" className="wk-menu-language" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
          <div className="login-field" style={{ margin: 0 }}>
            <label htmlFor="rv-site">{ru ? 'Объект' : 'Site'}</label>
            <select id="rv-site" name="site" defaultValue={siteId ?? ''}>
              <option value="">{ru ? 'Все объекты' : 'All sites'}</option>
              {queue.siteOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <div className="login-field" style={{ margin: 0 }}>
            <label htmlFor="rv-sort">{ru ? 'Сортировка' : 'Sort'}</label>
            <select id="rv-sort" name="sort" defaultValue={sort}>
              <option value="name">{ru ? 'По фамилии' : 'By name'}</option>
              <option value="hours">{ru ? 'По часам' : 'By hours'}</option>
              <option value="site">{ru ? 'По объекту' : 'By site'}</option>
            </select>
          </div>
          <label className="wk-checkbox-row" style={{ margin: 0 }}>
            <input type="checkbox" name="issues" value="1" defaultChecked={onlyIssues} />
            {ru ? 'Только с замечаниями' : 'Only with issues'}
          </label>
          <button type="submit" className="wk-inline-secondary">
            {ru ? 'Применить' : 'Apply'}
          </button>
        </form>

        {queue.rows.length === 0 ? (
          <p>{ru ? 'Нет табелей на утверждении.' : 'Nothing awaiting approval.'}</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>{ru ? 'Работник' : 'Worker'}</th>
                <th>{ru ? 'Период' : 'Period'}</th>
                <th>{ru ? 'Часы' : 'Hours'}</th>
                <th>{ru ? 'Объект(ы)' : 'Site(s)'}</th>
                <th>{ru ? 'Замечания' : 'Issues'}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {queue.rows.map((r) => {
                const clean = r.exceptionCount === 0 && !r.planMismatch;
                return (
                  <tr key={r.timesheetId}>
                    <td>
                      <Link href={`/admin/timesheets/${r.timesheetId}`}>{r.employeeName}</Link>
                      <br />
                      <small>
                        {r.status === 'FOREMAN_APPROVED' ? (ru ? 'готов к утверждению' : 'ready to approve') : ru ? 'на проверке' : 'in review'}
                      </small>
                    </td>
                    <td>
                      {r.periodStartDate} – {r.periodEndDate}
                    </td>
                    <td>{fmtHours(r.workedMinutes, ru)}</td>
                    <td>{r.siteNames.join(', ') || '—'}</td>
                    <td>
                      {clean ? (
                        <span className="wk-empty">—</span>
                      ) : (
                        <span className="field-error">
                          {r.exceptionCount > 0 ? (ru ? `исключений: ${r.exceptionCount}` : `${r.exceptionCount} exception(s)`) : ''}
                          {r.exceptionCount > 0 && r.planMismatch ? ' · ' : ''}
                          {r.planMismatch ? (ru ? 'план ≠ факт' : 'plan ≠ actual') : ''}
                        </span>
                      )}
                    </td>
                    <td>{clean ? <ApproveTimesheetButton timesheetId={r.timesheetId} variant="inline" /> : <Link href={`/admin/timesheets/${r.timesheetId}`}>{ru ? 'Открыть' : 'Open'}</Link>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {queue.notSubmitted.length > 0 ? (
        <div className="setup-card worker-card">
          <details>
            <summary>{ru ? `Ещё не сдали: ${queue.notSubmitted.length}` : `Not submitted yet: ${queue.notSubmitted.length}`}</summary>
            <table className="worker-table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>{ru ? 'Работник' : 'Worker'}</th>
                  <th>{ru ? 'Период' : 'Period'}</th>
                  <th>{ru ? 'Статус' : 'Status'}</th>
                </tr>
              </thead>
              <tbody>
                {queue.notSubmitted.map((r) => (
                  <tr key={r.timesheetId}>
                    <td>
                      <Link href={`/admin/timesheets/${r.timesheetId}`}>{r.employeeName}</Link>
                    </td>
                    <td>
                      {r.periodStartDate} – {r.periodEndDate}
                    </td>
                    <td>{r.status === 'RETURNED' ? (ru ? 'возвращён' : 'returned') : ru ? 'черновик' : 'draft'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      ) : null}
    </main>
  );
}
