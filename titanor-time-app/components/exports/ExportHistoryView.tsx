import Link from 'next/link';
import type { ExportBatchListResult } from '@/lib/csv-export';
import { buildOverviewQueryString } from '@/lib/attendance-overview-ui';
import { formatHelsinkiDateTime } from '@/lib/helsinki-datetime';
import { exportKindLabel, formatFileSize, shortenHash } from '@/lib/exports-ui';
import { AdminReportTabs } from '@/components/reports/AdminReportTabs';
import { ExportCreateControl } from '@/components/exports/ExportCreateControl';
import type { AppLocale } from '@/lib/i18n/locale';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4C" §BR/§BU — the only place the export
// history + create panel is rendered. app/admin/export/page.tsx is a thin Server Component wrapper
// that resolves session/permissions, parses searchParams, calls listExportBatches()/
// listPeriodOptions()/getPeriodDetail() directly (no HTTP self-fetch), and passes everything here
// as props. This component makes zero database/API calls of its own.

export interface PeriodOption {
  id: string;
  label: string;
  status: string;
}

export interface RawExportFilters {
  periodId: string | null;
  page: string | null;
  pageSize: string | null;
}

export type ExportHistoryOutcome = { kind: 'invalid'; fieldErrors: Record<string, string[]> } | { kind: 'ok'; list: ExportBatchListResult };

export type CreatePanelInfo =
  | { kind: 'no-permission' }
  | { kind: 'no-period-selected' }
  | { kind: 'period-not-found' }
  | { kind: 'open' }
  | { kind: 'locked'; periodId: string }
  | { kind: 'exported'; periodId: string };

export interface ExportHistoryViewProps {
  rawFilters: RawExportFilters;
  periodOptions: PeriodOption[];
  outcome: ExportHistoryOutcome;
  createPanel: CreatePanelInfo;
  locale: AppLocale;
}

const BASE_PATH = '/admin/export';
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export function ExportHistoryView({ rawFilters, periodOptions, outcome, createPanel, locale }: ExportHistoryViewProps) {
  const ru = locale === 'RU';
  const periodLabelById = new Map(periodOptions.map((p) => [p.id, p.label]));

  return (
    <div>
      <h1>{ru ? 'Выгрузки CSV' : 'CSV exports'}</h1>
      <AdminReportTabs active="export" locale={locale} />
      <p className="setup-subtitle">{ru ? 'Выгрузки содержат отработанные часы — никогда не зарплату или расчётные данные.' : 'Exports contain worked hours — never salary or payroll data.'}</p>
      <ul className="exp-explainer">
        <li>{ru ? 'Полная выгрузка создаётся, как только период заблокирован — одна строка на (работник, объект, дата).' : 'A full export is created once a period is LOCKED — one row per (worker, site, date).'}</li>
        <li>{ru ? 'Выгрузка корректировок — это полный замещающий снимок, а не разница — всегда полностью заменяет предыдущий файл, никогда не объединяется с ним.' : 'A correction export is a complete replacement snapshot, not a delta — always replace the previous file entirely, never merge them.'}</li>
        <li>{ru ? 'Старые файлы никогда не перезаписываются и не пересоздаются — каждая выгрузка является отдельной неизменяемой скачиваемой записью.' : 'Old files are never overwritten or regenerated — every export is a separate, immutable, downloadable record.'}</li>
      </ul>

      <form method="GET" action={BASE_PATH} className="ov-filters" aria-label={ru ? 'Фильтр истории выгрузок' : 'Filter export history'}>
        <div className="ov-filter-field">
          <label htmlFor="export-filter-period">{ru ? 'Расчётный период' : 'Payroll period'}</label>
          <select id="export-filter-period" name="periodId" defaultValue={rawFilters.periodId ?? ''}>
            <option value="">{ru ? 'Все периоды' : 'All periods'}</option>
            {periodOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="ov-filter-field">
          <label htmlFor="export-filter-pagesize">{ru ? 'На странице' : 'Per page'}</label>
          <select id="export-filter-pagesize" name="pageSize" defaultValue={rawFilters.pageSize ?? '20'}>
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="ov-filter-actions">
          <button type="submit" className="exc-apply-button">
            {ru ? 'Применить' : 'Apply'}
          </button>
          <Link href={BASE_PATH} className="exc-reset-link">
            {ru ? 'Сбросить' : 'Reset'}
          </Link>
        </div>
      </form>

      <CreatePanel info={createPanel} locale={locale} />

      <HistoryBody rawFilters={rawFilters} outcome={outcome} periodLabelById={periodLabelById} locale={locale} />
    </div>
  );
}

function CreatePanel({ info, locale }: { info: CreatePanelInfo; locale: AppLocale }) {
  const ru = locale === 'RU';
  return (
    <section className="exp-create-section" aria-labelledby="exp-create-heading">
      <h2 id="exp-create-heading">{ru ? 'Создать выгрузку' : 'Create export'}</h2>
      {info.kind === 'no-permission' && <p className="exp-create-note">{ru ? 'У вас нет права создавать выгрузки.' : 'You do not have permission to create exports.'}</p>}
      {info.kind === 'no-period-selected' && <p className="exp-create-note">{ru ? 'Выберите конкретный период выше, чтобы создать выгрузку.' : 'Select a specific period above to create an export.'}</p>}
      {info.kind === 'period-not-found' && <p className="exp-create-note">{ru ? 'Выберите конкретный существующий период выше, чтобы создать выгрузку.' : 'Select a specific, existing period above to create an export.'}</p>}
      {info.kind === 'open' && <p className="exp-create-note">{ru ? 'Заблокируйте период перед выгрузкой.' : 'Lock the period before exporting.'}</p>}
      {(info.kind === 'locked' || info.kind === 'exported') && (
        <>
          {/* A single, stable JSX slot for both 'locked' and 'exported' — router.refresh() after a
              successful create flips info.kind from 'locked' to 'exported' (the period this control
              is mounted for just became EXPORTED); if ExportCreateControl instead lived in two
              separate conditional branches, React would treat the kind flip as unmount+remount
              (same key, different tree position) and silently wipe the sticky success view a moment
              after it appeared. Keeping it in one slot and only varying its buttonLabel prop
              preserves that state across the refresh, as designed (§BV rule 6). */}
          <ExportCreateControl key={info.periodId} periodId={info.periodId} buttonLabel={info.kind === 'locked' ? (ru ? 'Создать полную выгрузку CSV' : 'Create full CSV export') : (ru ? 'Создать выгрузку корректировок CSV' : 'Create correction CSV export')} />
          {info.kind === 'exported' && (
            <p className="exp-create-note">
              {ru ? 'Статус EXPORTED не гарантирует наличие ожидающей корректировки — сервер остаётся источником истины и может сообщить, что выгружать нечего.' : 'An EXPORTED period does not guarantee a pending correction exists — the server remains authoritative and may report that nothing needs exporting.'}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function HistoryBody({ rawFilters, outcome, periodLabelById, locale }: { rawFilters: RawExportFilters; outcome: ExportHistoryOutcome; periodLabelById: Map<string, string>; locale: AppLocale }) {
  const ru = locale === 'RU';
  if (outcome.kind === 'invalid') {
    const messages = Object.entries(outcome.fieldErrors).map(([field, errors]) => `${field}: ${errors.join(', ')}`);
    return (
      <div className="login-error" role="alert">
        <p>{ru ? 'Некоторые фильтры некорректны:' : 'Some filters are invalid:'}</p>
        <ul>
          {messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </div>
    );
  }

  const { list } = outcome;
  const baseQuery = { periodId: rawFilters.periodId, pageSize: rawFilters.pageSize };

  return (
    <section aria-live="polite">
      <h2>{ru ? 'История' : 'History'}</h2>
      {list.items.length === 0 ? (
        <p role="status">{list.totalItems === 0 ? (ru ? 'Выгрузок пока нет.' : 'No exports yet.') : (ru ? `На этой странице нет выгрузок (всего: ${list.totalItems}, страниц: ${list.totalPages}).` : `This page has no exports (${list.totalItems} total, ${list.totalPages} pages).`)}</p>
      ) : (
        <ul className="ov-worker-list">
          {list.items.map((batch) => (
            <li key={batch.id} className="ov-worker-card exp-history-card">
              <div className="ov-worker-head">
                <h3 className="ov-worker-name">
                  {exportKindLabel(batch.kind, locale)}
                  {batch.kind === 'CORRECTION' && <span className="exp-replacement-badge">{ru ? 'Полный замещающий снимок' : 'Full replacement snapshot'}</span>}
                </h3>
              </div>
              <dl className="ov-worker-grid">
                <div>
                  <dt>{ru ? 'Период' : 'Period'}</dt>
                  <dd>
                    <Link href={`/admin/periods/${batch.periodId}`}>{periodLabelById.get(batch.periodId) ?? batch.periodId}</Link>
                  </dd>
                </div>
                <div>
                  <dt>{ru ? 'Создано' : 'Created'}</dt>
                  <dd>{formatHelsinkiDateTime(batch.createdAt)}</dd>
                </div>
                <div>
                  <dt>{ru ? 'Строки' : 'Rows'}</dt>
                  <dd>{batch.rowCount}</dd>
                </div>
                <div>
                  <dt>{ru ? 'Размер файла' : 'File size'}</dt>
                  <dd>{formatFileSize(batch.fileSizeBytes)}</dd>
                </div>
                <div>
                  <dt>SHA-256</dt>
                  <dd className="exp-hash" title={batch.fileHash}>
                    {shortenHash(batch.fileHash)}
                  </dd>
                </div>
                {batch.correctsBatchId && (
                  <div>
                    <dt>{ru ? 'Исправляет' : 'Corrects'}</dt>
                    <dd>
                      <Link href={`/admin/export/${batch.correctsBatchId}`}>{ru ? 'предыдущую выгрузку' : 'previous batch'}</Link>
                    </dd>
                  </div>
                )}
              </dl>
              <p className="exp-history-actions">
                <Link href={`/admin/export/${batch.id}`}>{ru ? 'Подробнее' : 'View details'}</Link>
                {' · '}
                <a href={batch.downloadUrl}>{ru ? 'Скачать CSV' : 'Download CSV'}</a>
              </p>
            </li>
          ))}
        </ul>
      )}

      <Pagination baseQuery={baseQuery} page={list.page} totalPages={list.totalPages} totalItems={list.totalItems} locale={locale} />
    </section>
  );
}

function Pagination({
  baseQuery,
  page,
  totalPages,
  totalItems,
  locale
}: {
  baseQuery: Record<string, string | number | null | undefined>;
  page: number;
  totalPages: number;
  totalItems: number;
  locale: AppLocale;
}) {
  const ru = locale === 'RU';
  if (totalItems === 0) {
    return null;
  }
  const pageHref = (p: number) => `${BASE_PATH}${buildOverviewQueryString({ ...baseQuery, page: p })}`;
  return (
    <nav className="exc-pagination" aria-label={ru ? 'Постраничная навигация' : 'Pagination'}>
      {page > 1 ? <Link href={pageHref(page - 1)}>{ru ? 'Назад' : 'Previous'}</Link> : <span className="exc-pagination-disabled">{ru ? 'Назад' : 'Previous'}</span>}
      <span>
        {ru ? `Выгрузок: ${totalItems} · страница ${page} из ${totalPages}` : `${totalItems} export${totalItems === 1 ? '' : 's'} · page ${page} of ${totalPages}`}
      </span>
      {page < totalPages ? <Link href={pageHref(page + 1)}>{ru ? 'Далее' : 'Next'}</Link> : <span className="exc-pagination-disabled">{ru ? 'Далее' : 'Next'}</span>}
    </nav>
  );
}
