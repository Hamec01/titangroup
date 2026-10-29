import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listWorkers } from '@/lib/workers';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { localeText } from '@/lib/i18n/locale';
import { WorkerSearchInput } from './WorkerSearchInput';

export const dynamic = 'force-dynamic';

const WORKER_LIST_LIMIT = 10_000;
type WorkerSort = 'name_asc' | 'name_desc' | 'number_asc' | 'number_desc' | 'assignment_asc' | 'assignment_desc';
const WORKER_SORTS = new Set<WorkerSort>(['name_asc', 'name_desc', 'number_asc', 'number_desc', 'assignment_asc', 'assignment_desc']);

// docs/titanor-time/01_SCREEN_MAP.md — read-only worker list
// (PROJECT_ROADMAP.md T6.2: "Список работников. Сначала read-only."). The admin list deliberately
// renders as one continuous table; URL-backed search and column sorting keep it manageable.
export default async function AdminWorkersPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  const searchParams = await props.searchParams;
  const showArchived = searchParams.archived === '1';
  const queryParam = Array.isArray(searchParams.q) ? searchParams.q[0] : searchParams.q;
  const query = (queryParam ?? '').trim().slice(0, 100);
  const sortParam = Array.isArray(searchParams.sort) ? searchParams.sort[0] : searchParams.sort;
  const sort: WorkerSort = WORKER_SORTS.has(sortParam as WorkerSort) ? sortParam as WorkerSort : 'name_asc';
  const hrefFor = (next: { archived?: boolean; sort?: WorkerSort } = {}): string => {
    const params = new URLSearchParams();
    if (next.archived ?? showArchived) params.set('archived', '1');
    if (query) params.set('q', query);
    const nextSort = next.sort ?? sort;
    if (nextSort !== 'name_asc') params.set('sort', nextSort);
    const suffix = params.toString();
    return suffix ? `/admin/workers?${suffix}` : '/admin/workers';
  };
  const { items: unsortedItems, totalItems, archivedCount } = await listWorkers(1, WORKER_LIST_LIMIT, { includeArchived: showArchived, q: query });
  const collator = new Intl.Collator(locale === 'RU' ? 'ru' : 'en', { sensitivity: 'base', numeric: true });
  const nameKey = (worker: (typeof unsortedItems)[number]) => `${worker.firstName} ${worker.lastName}`;
  const assignmentKey = (worker: (typeof unsortedItems)[number]) => worker.currentAssignments
    .map((assignment) => `${assignment.workAreaName ?? ''}\u0000${assignment.siteName}\u0000${assignment.isPrimary ? '0' : '1'}`)
    .sort(collator.compare)
    .join('\u0001');
  const direction = sort.endsWith('_desc') ? -1 : 1;
  const items = unsortedItems.toSorted((a, b) => {
    let compared: number;
    if (sort.startsWith('assignment_')) {
      const aAssignment = assignmentKey(a);
      const bAssignment = assignmentKey(b);
      if (!aAssignment && bAssignment) return 1;
      if (aAssignment && !bAssignment) return -1;
      compared = collator.compare(aAssignment, bAssignment);
    } else {
      compared = sort.startsWith('number_')
        ? collator.compare(a.employeeNumber, b.employeeNumber)
        : collator.compare(nameKey(a), nameKey(b));
    }
    return direction * compared || collator.compare(nameKey(a), nameKey(b));
  });
  const nextSort = (column: 'name' | 'number' | 'assignment'): WorkerSort => sort === `${column}_asc` ? `${column}_desc` : `${column}_asc`;
  const ariaSort = (column: 'name' | 'number' | 'assignment'): 'ascending' | 'descending' | 'none' => sort === `${column}_asc` ? 'ascending' : sort === `${column}_desc` ? 'descending' : 'none';
  const sortArrow = (column: 'name' | 'number' | 'assignment') => ariaSort(column) === 'ascending' ? ' ↑' : ariaSort(column) === 'descending' ? ' ↓' : '';

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{s.workers.title}</h1>
        <p className="setup-subtitle">
          {totalItems} {totalItems === 1 ? s.workers.singular : s.workers.plural} · <Link href="/admin/workers/new">{s.common.createNew}</Link>
          {showArchived ? (
            <>
              {' · '}
              <Link href={hrefFor({ archived: false })}>{s.workers.hideArchived}</Link>
            </>
          ) : archivedCount > 0 ? (
            <>
              {' · '}
              <Link href={hrefFor({ archived: true })}>
                {s.workers.showArchived} ({archivedCount})
              </Link>
            </>
          ) : null}
        </p>
        <WorkerSearchInput initialQuery={query} includeArchived={showArchived} sort={sort} locale={locale} />
        {items.length === 0 ? (
          <p>{query ? localeText(locale, 'No workers match this search.', 'По этому поиску работники не найдены.') : s.workers.empty}</p>
        ) : (
          <div className="worker-table-scroll">
          <table className="worker-table">
            <thead>
              <tr>
                <th aria-sort={ariaSort('number')}><Link className="worker-sort-link" href={hrefFor({ sort: nextSort('number') })}>#{sortArrow('number')}</Link></th>
                <th aria-sort={ariaSort('name')}><Link className="worker-sort-link" href={hrefFor({ sort: nextSort('name') })}>{s.common.name}{sortArrow('name')}</Link></th>
                <th>{s.workers.login}</th>
                <th>{s.common.status}</th>
                <th aria-sort={ariaSort('assignment')}><Link className="worker-sort-link" href={hrefFor({ sort: nextSort('assignment') })}>{s.workers.assignment}{sortArrow('assignment')}</Link></th>
              </tr>
            </thead>
            <tbody>
              {items.map((worker) => (
                <tr key={worker.id}>
                  <td>{worker.employeeNumber}</td>
                  <td>
                    <Link href={`/admin/workers/${worker.id}`}>
                      {worker.firstName} {worker.lastName}
                    </Link>
                  </td>
                  <td>{worker.username}</td>
                  <td>{worker.active ? s.common.active : s.common.inactive}</td>
                  <td>
                    {worker.currentAssignments.length === 0
                      ? '—'
                      : worker.currentAssignments
                          .map(
                            (assignment) =>
                              assignment.siteName +
                              (assignment.workAreaName ? ` — ${assignment.workAreaName}` : '') +
                              (assignment.isPrimary ? ` (${s.common.primary})` : '')
                          )
                          .join(', ')}
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
