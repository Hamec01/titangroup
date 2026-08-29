import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';
import { listSiteOptionsForAdmin } from '@/lib/attendance-overview-lookups';
import { buildOverviewQueryString } from '@/lib/attendance-overview-ui';
import { listSelectableQualificationDefinitions } from '@/lib/qualification-catalog';
import { listProfessionCatalog } from '@/lib/professions';
import {
  getQualificationMatrix,
  type MatrixStatusFilter,
  type MatrixVerificationFilter,
  type MatrixSort,
  type MatrixProfessionCategory,
  type MatrixActiveFilter
} from '@/lib/qualification-matrix';
import { WorkforceMatrixTable } from '@/components/workforce/WorkforceMatrixTable';

export const dynamic = 'force-dynamic';

// T13.5 — the workforce matrix (was /admin/qualifications). Adds profession category / profession
// filters, an active/inactive filter, and profession/number/site sorts on top of the existing
// qualification matrix. /admin/qualifications now 301-redirects here.
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
  { value: 'MISSING_EXPIRY', en: 'No expiry date', ru: 'Срок не указан' },
  { value: 'MISSING', en: 'Missing', ru: 'Отсутствует' }
];
const VERIFICATION_OPTIONS: { value: MatrixVerificationFilter; en: string; ru: string }[] = [
  { value: 'ALL', en: 'All', ru: 'Все' },
  { value: 'VERIFIED', en: 'Verified', ru: 'Подтверждено' },
  { value: 'SELF_REPORTED', en: 'Self-reported', ru: 'Указано самостоятельно' }
];
const CATEGORY_OPTIONS: { value: MatrixProfessionCategory; en: string; ru: string }[] = [
  { value: 'ALL', en: 'All categories', ru: 'Все категории' },
  { value: 'SHIPBUILDING', en: 'Shipbuilding', ru: 'Судостроение' },
  { value: 'CONSTRUCTION', en: 'Construction', ru: 'Строительство' }
];
const ACTIVE_OPTIONS: { value: MatrixActiveFilter; en: string; ru: string }[] = [
  { value: 'ALL', en: 'All', ru: 'Все' },
  { value: 'ACTIVE', en: 'Active only', ru: 'Только активные' },
  { value: 'INACTIVE', en: 'Inactive only', ru: 'Только неактивные' }
];
const SORT_OPTIONS: { value: MatrixSort; en: string; ru: string }[] = [
  { value: 'ATTENTION', en: 'Attention first', ru: 'Сначала важное' },
  { value: 'NAME', en: 'Name', ru: 'Имя' },
  { value: 'NUMBER', en: 'Employee number', ru: 'Табельный номер' },
  { value: 'PROFESSION', en: 'Profession', ru: 'Профессия' },
  { value: 'CURRENT_SITE', en: 'Current site', ru: 'Текущий объект' },
  { value: 'EXPIRY', en: 'Expiry date', ru: 'Срок действия' }
];

export default async function AdminWorkforcePage({ searchParams }: RouteParams) {
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
  const professionCategoryRaw = one(sp.professionCategory) || 'ALL';
  const professionCategory = (CATEGORY_OPTIONS.some((o) => o.value === professionCategoryRaw) ? professionCategoryRaw : 'ALL') as MatrixProfessionCategory;
  const professionCode = one(sp.professionCode) || null;
  const activeRaw = one(sp.active) || 'ALL';
  const active = (ACTIVE_OPTIONS.some((o) => o.value === activeRaw) ? activeRaw : 'ALL') as MatrixActiveFilter;
  const sortRaw = one(sp.sort) || 'ATTENTION';
  const sort = (SORT_OPTIONS.some((o) => o.value === sortRaw) ? sortRaw : 'ATTENTION') as MatrixSort;
  const pageRaw = Number(one(sp.page) || '1');
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;

  const [sites, catalog, professionCatalog, result] = await Promise.all([
    listSiteOptionsForAdmin(),
    listSelectableQualificationDefinitions(),
    listProfessionCatalog(),
    getQualificationMatrix({ search, qualificationCode, status, siteId, verification, professionCategory, professionCode, active, sort, page, pageSize: 20 })
  ]);

  const baseQuery = {
    search,
    qualification: qualificationCode,
    status: status === 'ALL' ? null : status,
    siteId,
    verification: verification === 'ALL' ? null : verification,
    professionCategory: professionCategory === 'ALL' ? null : professionCategory,
    professionCode,
    active: active === 'ALL' ? null : active,
    sort: sort === 'ATTENTION' ? null : sort
  };
  const exportQuery = buildOverviewQueryString(baseQuery);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{ru ? 'Работники — матрица' : 'Workforce matrix'}</h1>
        <p className="setup-subtitle">
          {ru ? `Всего работников: ${result.totalItems}` : `${result.totalItems} worker${result.totalItems === 1 ? '' : 's'} total`}
        </p>

        <form method="GET" action="/admin/workforce" className="ov-filters" aria-label={ru ? 'Фильтры' : 'Filters'}>
          <div className="ov-filter-field">
            <label htmlFor="wf-search">{ru ? 'Поиск' : 'Search'}</label>
            <input id="wf-search" type="text" name="search" defaultValue={search} placeholder={ru ? 'Имя или номер' : 'Name or number'} />
          </div>
          <div className="ov-filter-field">
            <label htmlFor="wf-prof-category">{ru ? 'Категория профессии' : 'Profession category'}</label>
            <select id="wf-prof-category" name="professionCategory" defaultValue={professionCategory}>
              {CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {ru ? o.ru : o.en}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="wf-profession">{ru ? 'Профессия' : 'Profession'}</label>
            <select id="wf-profession" name="professionCode" defaultValue={professionCode ?? ''}>
              <option value="">{ru ? 'Все' : 'All'}</option>
              {professionCatalog.map((group) => (
                <optgroup key={group.category} label={ru ? (group.category === 'SHIPBUILDING' ? 'Судостроение' : 'Строительство') : group.category === 'SHIPBUILDING' ? 'Shipbuilding' : 'Construction'}>
                  {group.professions.map((p) => (
                    <option key={p.id} value={p.code}>
                      {ru ? p.nameRu : p.nameEn}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="wf-qualification">{ru ? 'Допуск / сертификат' : 'Qualification'}</label>
            <select id="wf-qualification" name="qualification" defaultValue={qualificationCode ?? ''}>
              <option value="">{ru ? 'Все' : 'All'}</option>
              {catalog.map((c) => (
                <option key={c.id} value={c.code}>
                  {ru ? c.nameRu : c.nameEn}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="wf-status">{ru ? 'Статус срока' : 'Expiry status'}</label>
            <select id="wf-status" name="status" defaultValue={status}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {ru ? o.ru : o.en}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="wf-site">{ru ? 'Объект' : 'Site'}</label>
            <select id="wf-site" name="siteId" defaultValue={siteId ?? ''}>
              <option value="">{ru ? 'Все объекты' : 'All sites'}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="wf-verification">{ru ? 'Подтверждение' : 'Verification'}</label>
            <select id="wf-verification" name="verification" defaultValue={verification}>
              {VERIFICATION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {ru ? o.ru : o.en}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="wf-active">{ru ? 'Занятость' : 'Employment'}</label>
            <select id="wf-active" name="active" defaultValue={active}>
              {ACTIVE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {ru ? o.ru : o.en}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="wf-sort">{ru ? 'Сортировка' : 'Sort'}</label>
            <select id="wf-sort" name="sort" defaultValue={sort}>
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
            <Link href="/admin/workforce" className="exc-reset-link">
              {ru ? 'Сбросить' : 'Reset'}
            </Link>
          </div>
        </form>

        <p className="setup-subtitle" style={{ marginTop: 4 }}>
          {ru ? 'Выгрузить текущую выборку: ' : 'Export the current selection: '}
          <a href={`/api/admin/workforce/export${exportQuery}${exportQuery ? '&' : '?'}format=PDF`}>PDF</a>
          {' · '}
          <a href={`/api/admin/workforce/export${exportQuery}${exportQuery ? '&' : '?'}format=CSV`}>CSV</a>
        </p>

        {result.items.length === 0 ? (
          <p role="status" className="setup-subtitle">
            {ru ? 'Никого не найдено по выбранным фильтрам.' : 'No one matches the selected filters.'}
          </p>
        ) : (
          <WorkforceMatrixTable rows={result.items} locale={locale} />
        )}

        <nav className="exc-pagination" aria-label={ru ? 'Постраничная навигация' : 'Pagination'}>
          {result.page > 1 ? (
            <Link href={`/admin/workforce${buildOverviewQueryString({ ...baseQuery, page: result.page - 1 })}`}>{ru ? 'Назад' : 'Previous'}</Link>
          ) : (
            <span className="exc-pagination-disabled">{ru ? 'Назад' : 'Previous'}</span>
          )}
          <span>{ru ? `Страница ${result.page} из ${result.totalPages}` : `Page ${result.page} of ${result.totalPages}`}</span>
          {result.page < result.totalPages ? (
            <Link href={`/admin/workforce${buildOverviewQueryString({ ...baseQuery, page: result.page + 1 })}`}>{ru ? 'Далее' : 'Next'}</Link>
          ) : (
            <span className="exc-pagination-disabled">{ru ? 'Далее' : 'Next'}</span>
          )}
        </nav>
      </div>
    </main>
  );
}
