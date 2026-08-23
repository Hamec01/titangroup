import Link from 'next/link';
import type { ExportBatchDetail } from '@/lib/csv-export';
import { buildOverviewQueryString } from '@/lib/attendance-overview-ui';
import { formatHelsinkiDateTime } from '@/lib/helsinki-datetime';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { exportKindLabel, formatFileSize } from '@/lib/exports-ui';
import type { AppLocale } from '@/lib/i18n/locale';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4C" §BR/§BX — the only place a single
// ExportBatch's detail (metadata + paginated ExportItem rows) is rendered. app/admin/export/
// [batchId]/page.tsx is a thin Server Component wrapper that calls getExportBatchDetail() directly
// and passes the result (or `null` for a safe not-found state) here as props.

export type ExportBatchDetailOutcome = { kind: 'not-found' } | { kind: 'ok'; detail: ExportBatchDetail; periodLabel: string | null };

export interface ExportBatchDetailViewProps {
  batchId: string;
  outcome: ExportBatchDetailOutcome;
  page: number;
  pageSize: number;
  locale: AppLocale;
}

export function ExportBatchDetailView({ outcome, page, pageSize, locale }: ExportBatchDetailViewProps) {
  const ru = locale === 'RU';
  if (outcome.kind === 'not-found') {
    return (
      <div>
        <p className="login-error" role="alert">
          {ru ? 'Выгрузка с таким идентификатором не найдена.' : 'No export batch with this id.'}
        </p>
        <Link href="/admin/export">{ru ? 'К выгрузкам' : 'Back to exports'}</Link>
      </div>
    );
  }

  const { detail, periodLabel } = outcome;
  const { batch } = detail;

  return (
    <div>
      <h1>
        {exportKindLabel(batch.kind, locale)}
        {batch.kind === 'CORRECTION' && <span className="exp-replacement-badge">{ru ? 'Полный замещающий снимок' : 'Full replacement snapshot'}</span>}
      </h1>
      <p className="setup-subtitle">{ru ? 'Только часы — без расчёта зарплаты.' : 'Hours only — no salary or payroll calculation.'}</p>

      <dl className="ov-worker-grid">
        <div>
          <dt>{ru ? 'Период' : 'Period'}</dt>
          <dd>
            <Link href={`/admin/periods/${batch.periodId}`}>{periodLabel ?? batch.periodId}</Link>
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
          <dd className="exp-hash">{batch.fileHash}</dd>
        </div>
        <div>
          <dt>{ru ? 'Имя файла' : 'File name'}</dt>
          <dd className="exp-hash">{batch.fileName}</dd>
        </div>
        {batch.correctsBatchId && (
          <div>
            <dt>{ru ? 'Исправляет' : 'Corrects'}</dt>
            <dd>
              <Link href={`/admin/export/${batch.correctsBatchId}`}>{ru ? 'предыдущую выгрузку' : 'previous batch'}</Link>
            </dd>
          </div>
        )}
        <div>
          <dt>{ru ? 'Охваченные корректировки' : 'Covered corrections'}</dt>
          <dd>{detail.coveredCorrectionCount}</dd>
        </div>
      </dl>

      {detail.coveredCorrectionIds.length > 0 && (
        <section aria-labelledby="exp-covered-corrections-heading">
          <h2 id="exp-covered-corrections-heading">{ru ? 'Охваченные запросы на корректировку' : 'Covered correction requests'}</h2>
          <ul className="setup-list">
            {detail.coveredCorrectionIds.map((id) => (
              <li key={id} className="setup-item">
                <Link href={`/admin/corrections/${id}`}>{id}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p>
        <a href={batch.downloadUrl}>{ru ? 'Скачать CSV' : 'Download CSV'}</a>
      </p>

      <ItemsSection batchId={batch.id} items={detail.items} page={page} pageSize={pageSize} totalItems={detail.totalItems} totalPages={detail.totalPages} locale={locale} />

      <p>
        <Link href="/admin/export">{ru ? 'К выгрузкам' : 'Back to exports'}</Link>
      </p>
    </div>
  );
}

function ItemsSection({
  batchId,
  items,
  page,
  pageSize,
  totalItems,
  totalPages,
  locale
}: {
  batchId: string;
  items: ExportBatchDetail['items'];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  locale: AppLocale;
}) {
  const ru = locale === 'RU';
  return (
    <section aria-labelledby="exp-items-heading">
      <h2 id="exp-items-heading">{ru ? 'Строки' : 'Rows'}</h2>
      {items.length === 0 ? (
        <p role="status">{ru ? 'В этой выгрузке нет строк (ноль отработанных часов за этот период).' : 'This export has no rows (zero worked hours for this period).'}</p>
      ) : (
        <ul className="ov-worker-list exp-item-list">
          {items.map((item) => (
            <li key={item.id} className="ov-worker-card">
              <div className="ov-worker-head">
                <h3 className="ov-worker-name">
                  {item.employeeNameSnapshot} <span className="ov-muted">({item.employeeNumberSnapshot})</span>
                </h3>
              </div>
              <dl className="ov-worker-grid">
                <div>
                  <dt>{ru ? 'Объект' : 'Site'}</dt>
                  <dd>{item.siteNameSnapshot}</dd>
                </div>
                <div>
                  <dt>{ru ? 'Дата' : 'Date'}</dt>
                  <dd>{item.date}</dd>
                </div>
                <div>
                  <dt>{ru ? 'Всего' : 'Gross'}</dt>
                  <dd>{formatWorkedDuration(item.grossMinutes, locale)}</dd>
                </div>
                <div>
                  <dt>{ru ? 'Оплач. перерыв' : 'Paid break'}</dt>
                  <dd>{formatWorkedDuration(item.paidBreakMinutes, locale)}</dd>
                </div>
                <div>
                  <dt>{ru ? 'Неоплач. перерыв' : 'Unpaid break'}</dt>
                  <dd>{formatWorkedDuration(item.unpaidBreakMinutes, locale)}</dd>
                </div>
                <div>
                  <dt>{ru ? 'Отработано' : 'Worked'}</dt>
                  <dd>{formatWorkedDuration(item.workedMinutes, locale)}</dd>
                </div>
                <div>
                  <dt>{ru ? 'Интервалы' : 'Segments'}</dt>
                  <dd>{item.segmentCount}</dd>
                </div>
              </dl>
              <p className="exp-item-version ov-muted">{ru ? 'Версия:' : 'Version:'} {item.timesheetVersionId}</p>
            </li>
          ))}
        </ul>
      )}

      {totalItems > 0 && (
        <nav className="exc-pagination" aria-label={ru ? 'Постраничная навигация строк' : 'Row pagination'}>
          {page > 1 ? (
            <Link href={`/admin/export/${batchId}${buildOverviewQueryString({ page: page - 1, pageSize })}`}>{ru ? 'Назад' : 'Previous'}</Link>
          ) : (
            <span className="exc-pagination-disabled">{ru ? 'Назад' : 'Previous'}</span>
          )}
          <span>
            {ru ? `Строк: ${totalItems} · страница ${page} из ${totalPages}` : `${totalItems} row${totalItems === 1 ? '' : 's'} · page ${page} of ${totalPages}`}
          </span>
          {page < totalPages ? (
            <Link href={`/admin/export/${batchId}${buildOverviewQueryString({ page: page + 1, pageSize })}`}>{ru ? 'Далее' : 'Next'}</Link>
          ) : (
            <span className="exc-pagination-disabled">{ru ? 'Далее' : 'Next'}</span>
          )}
        </nav>
      )}
    </section>
  );
}
