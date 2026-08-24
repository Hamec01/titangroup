import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';
import { listSiteOptionsForAdmin } from '@/lib/attendance-overview-lookups';
import { buildOverviewQueryString } from '@/lib/attendance-overview-ui';
import { listSelectableQualificationDefinitions } from '@/lib/qualification-catalog';
import { getQualificationMatrix, type MatrixStatusFilter, type MatrixVerificationFilter, type MatrixSort } from '@/lib/qualification-matrix';
import { QualificationMatrixTable } from '@/components/qualifications/QualificationMatrixTable';

export const dynamic = 'force-dynamic';

const REQUIRED_PERMISSIONS = ['worker.profile.read.all', 'worker.read.all'];

type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(v: string | string[] | undefined): string {
  if (v === undefined) return '';
  return Array.isArray(v) ? (v[0] ?? '') : v;
}

const STATUS_OPTIONS: { value: MatrixStatusFilter; en: string; ru: string }[] = [
  { value: 'ALL', en: 'All statuses', ru: 'Все статусы' },
  { value: 'VALID', en: 'Valid', ru: 'Действительно' },
  { value: 'EXPIRING_SOON', en: 'Expiring soon', ru: 'Скоро истекает' },
  { value: 'CRITICAL', en: 'Critical', ru: 'Критично' },
  { value: 'EXPIRED', en: 'Expired', ru: 'Истекло' },
  { value: 'MISSING', en: 'Missing', ru: 'Отсутствует' }
];

const VERIFICATION_OPTIONS: { value: MatrixVerificationFilter; en: string; ru: string }[] = [
  { value: 'ALL', en: 'All', ru: 'Все' },
  { value: 'VERIFIED', en: 'Verified', ru: 'Подтверждено' },
  { value: 'SELF_REPORTED', en: 'Self-reported', ru: 'Указано самостоятельно' }
];

const SORT_OPTIONS: { value: MatrixSort; en: string; ru: string }[] = [
  { value: 'ATTENTION', en: 'Attention first', ru: 'Сначала важное' },
  { value: 'NAME', en: 'Name', ru: 'Имя' },
  { value: 'EXPIRY', en: 'Expiry date', ru: 'Срок действия' }
];

export default async function AdminQualificationsPage({ searchParams }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();
  const ru = locale === 'RU';

  for (const permissionCode of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(session.user.roles, permissionCode))) {
      return (
        <main className="setup-page">
          <p className="login-error" role="alert">
            {localeText(locale, `Access denied — this page requires the ${permissionCode} permission.`, `Доступ запрещён — для этой страницы требуется право ${permissionCode}.`)}
          </p>
        </main>
      );
    }
  }

  const sp = await searchParams;
  const search = one(sp.search);
  const qualificationCode = one(sp.qualification) || null;
  const statusRaw = one(sp.status) || 'ALL';
  const status = (STATUS_OPTIONS.some((o) => o.value === statusRaw) ? statusRaw : 'ALL') as MatrixStatusFilter;
  const siteId = one(sp.siteId) || null;
  const verificationRaw = one(sp.verification) || 'ALL';
  const verification = (VERIFICATION_OPTIONS.some((o) => o.value === verificationRaw) ? verificationRaw : 'ALL') as MatrixVerificationFilter;
  const sortRaw = one(sp.sort) || 'ATTENTION';
  const sort = (SORT_OPTIONS.some((o) => o.value === sortRaw) ? sortRaw : 'ATTENTION') as MatrixSort;
  const pageRaw = Number(one(sp.page) || '1');
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;

  const [sites, catalog, result] = await Promise.all([
    listSiteOptionsForAdmin(),
    listSelectableQualificationDefinitions(),
    getQualificationMatrix({ search, qualificationCode, status, siteId, verification, sort, page, pageSize: 20 })
  ]);

  const baseQuery = { search, qualification: qualificationCode, status: status === 'ALL' ? null : status, siteId, verification: verification === 'ALL' ? null : verification, sort: sort === 'ATTENTION' ? null : sort };

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{ru ? 'Допуски и сертификаты' : 'Qualifications'}</h1>
        <p className="setup-subtitle">
          {ru ? `Всего работников: ${result.totalItems}` : `${result.totalItems} worker${result.totalItems === 1 ? '' : 's'} total`}
        </p>

        <form method="GET" action="/admin/qualifications" className="ov-filters" aria-label={ru ? 'Фильтры' : 'Filters'}>
          <div className="ov-filter-field">
            <label htmlFor="qm-search">{ru ? 'Поиск' : 'Search'}</label>
            <input id="qm-search" type="text" name="search" defaultValue={search} placeholder={ru ? 'Имя или номер' : 'Name or number'} />
          </div>
          <div className="ov-filter-field">
            <label htmlFor="qm-qualification">{ru ? 'Квалификация' : 'Qualification'}</label>
            <select id="qm-qualification" name="qualification" defaultValue={qualificationCode ?? ''}>
              <option value="">{ru ? 'Все' : 'All'}</option>
              {catalog.map((c) => (
                <option key={c.id} value={c.code}>
                  {ru ? c.nameRu : c.nameEn}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="qm-status">{ru ? 'Статус' : 'Status'}</label>
            <select id="qm-status" name="status" defaultValue={status}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {ru ? o.ru : o.en}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="qm-site">{ru ? 'Объект' : 'Site'}</label>
            <select id="qm-site" name="siteId" defaultValue={siteId ?? ''}>
              <option value="">{ru ? 'Все объекты' : 'All sites'}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="qm-verification">{ru ? 'Подтверждение' : 'Verification'}</label>
            <select id="qm-verification" name="verification" defaultValue={verification}>
              {VERIFICATION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {ru ? o.ru : o.en}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="qm-sort">{ru ? 'Сортировка' : 'Sort'}</label>
            <select id="qm-sort" name="sort" defaultValue={sort}>
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {ru ? o.ru : o.en}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-actions">
            <button type="submit" className="exc-apply-button">
              {ru ? 'Применить' : 'Apply'}
            </button>
            <Link href="/admin/qualifications" className="exc-reset-link">
              {ru ? 'Сбросить' : 'Reset'}
            </Link>
          </div>
        </form>

        {result.items.length === 0 ? (
          <p role="status" className="setup-subtitle">
            {ru ? 'Никого не найдено по выбранным фильтрам.' : 'No one matches the selected filters.'}
          </p>
        ) : (
          <QualificationMatrixTable rows={result.items} locale={locale} />
        )}

        <nav className="exc-pagination" aria-label={ru ? 'Постраничная навигация' : 'Pagination'}>
          {result.page > 1 ? (
            <Link href={`/admin/qualifications${buildOverviewQueryString({ ...baseQuery, page: result.page - 1 })}`}>{ru ? 'Назад' : 'Previous'}</Link>
          ) : (
            <span className="exc-pagination-disabled">{ru ? 'Назад' : 'Previous'}</span>
          )}
          <span>
            {ru ? `Страница ${result.page} из ${result.totalPages}` : `Page ${result.page} of ${result.totalPages}`}
          </span>
          {result.page < result.totalPages ? (
            <Link href={`/admin/qualifications${buildOverviewQueryString({ ...baseQuery, page: result.page + 1 })}`}>{ru ? 'Далее' : 'Next'}</Link>
          ) : (
            <span className="exc-pagination-disabled">{ru ? 'Далее' : 'Next'}</span>
          )}
        </nav>
      </div>
    </main>
  );
}
