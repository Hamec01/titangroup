import Link from 'next/link';
import type { AppLocale } from '@/lib/i18n/locale';
import type { PeriodTimeReport } from '@/lib/period-time-report';
import type { WorkerTimeReport } from '@/lib/worker-time-report';
import type { SiteTimeReport } from '@/lib/site-time-report';
import type { ReportFileSummary } from '@/lib/report-files';
import { formatWorkedDuration, timesheetStatusLabel } from '@/lib/reporting/report-format';
import { formatHelsinkiDateTime } from '@/lib/helsinki-datetime';
import { ReportExportControls } from '@/components/reports/ReportExportControls';
import { ReportFileDeleteButton } from '@/components/reports/ReportFileDeleteButton';

interface Props {
  locale: AppLocale;
  periodOptions: { id: string; label: string; status: string }[];
  employeeOptions: { id: string; employeeNumber: string; firstName: string; lastName: string }[];
  siteOptions: { id: string; name: string }[];
  selectedPeriodId: string | null;
  selectedEmployeeId: string | null;
  selectedSiteId: string | null;
  view: string;
  periodReport: PeriodTimeReport | null;
  workerReport: WorkerTimeReport | null;
  siteReport: SiteTimeReport | null;
  files: ReportFileSummary[];
}

export function ReportsCommandCenter(props: Props) {
  const ru = props.locale === 'RU';
  const report = props.periodReport;
  const periodId = props.selectedPeriodId;
  const tab = props.view === 'files' ? 'files' : props.workerReport ? 'worker' : props.siteReport ? 'site' : 'overview';
  const detailQuery = (extra: Record<string, string>) => new URLSearchParams({ ...(periodId ? { periodId } : {}), ...extra }).toString();

  return (
    <div className="report-center">
      <div className="report-center-header">
        <div><p className="report-eyebrow">Titanor Time · {ru ? 'аналитика' : 'analytics'}</p><h1>{ru ? 'Отчёты' : 'Reports'}</h1><p className="report-center-lead">{ru ? 'Одна рабочая панель для часов, табелей и контроля недели. Выберите период — остальная информация соберётся здесь.' : 'One control center for hours, timesheets and weekly visibility. Choose a period and the full picture appears here.'}</p></div>
        {periodId && <ReportExportControls periodId={periodId} />}
      </div>

      <form className="report-filter-bar" method="GET" action="/admin/reports" aria-label={ru ? 'Фильтры отчёта' : 'Report filters'}>
        <div className="report-filter-field"><label htmlFor="report-period">{ru ? 'Расчётный период' : 'Payroll period'}</label><select id="report-period" name="periodId" defaultValue={periodId ?? ''}><option value="">{ru ? 'Выберите период' : 'Select a period'}</option>{props.periodOptions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
        <div className="report-filter-field"><label htmlFor="report-worker">{ru ? 'Быстрый переход к работнику' : 'Jump to worker'}</label><select id="report-worker" name="employeeId" defaultValue={props.selectedEmployeeId ?? ''}><option value="">{ru ? 'Все работники' : 'All workers'}</option>{props.employeeOptions.map((e) => <option key={e.id} value={e.id}>{e.lastName} {e.firstName} · {e.employeeNumber}</option>)}</select></div>
        <div className="report-filter-field"><label htmlFor="report-site">{ru ? 'Быстрый переход к объекту' : 'Jump to site'}</label><select id="report-site" name="siteId" defaultValue={props.selectedSiteId ?? ''}><option value="">{ru ? 'Все объекты' : 'All sites'}</option>{props.siteOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <button className="report-filter-submit" type="submit">{ru ? 'Показать' : 'Show report'}</button>
        <Link className="report-filter-reset" href="/admin/reports">{ru ? 'Сбросить' : 'Reset'}</Link>
      </form>

      <nav className="report-tabs" aria-label={ru ? 'Разделы отчёта' : 'Report sections'}>
        <Link className={tab === 'overview' ? 'report-tab report-tab-active' : 'report-tab'} href={periodId ? `/admin/reports?${detailQuery({})}` : '/admin/reports'}>{ru ? 'Обзор недели' : 'Period overview'}</Link>
        <Link className={tab === 'worker' ? 'report-tab report-tab-active' : 'report-tab'} href={periodId ? `/admin/reports?${detailQuery({ view: 'worker' })}` : '/admin/reports'}>{ru ? 'По работнику' : 'By worker'}</Link>
        <Link className={tab === 'site' ? 'report-tab report-tab-active' : 'report-tab'} href={periodId ? `/admin/reports?${detailQuery({ view: 'site' })}` : '/admin/reports'}>{ru ? 'По объекту' : 'By site'}</Link>
        <Link className={tab === 'files' ? 'report-tab report-tab-active' : 'report-tab'} href={periodId ? `/admin/reports?${detailQuery({ view: 'files' })}` : '/admin/reports'}>{ru ? `Сохранённые файлы${props.files.length ? ` (${props.files.length})` : ''}` : `Saved files${props.files.length ? ` (${props.files.length})` : ''}`}</Link>
      </nav>

      {!periodId || !report ? <section className="report-panel"><p className="report-empty">{props.periodOptions.length ? (ru ? 'Выберите период, чтобы увидеть сводку по компании.' : 'Choose a period to see the company summary.') : (ru ? 'Расчётных периодов пока нет.' : 'No payroll periods exist yet.')}</p></section> : tab === 'worker' && props.workerReport ? <WorkerDetail report={props.workerReport} locale={props.locale} /> : tab === 'site' && props.siteReport ? <SiteDetail report={props.siteReport} locale={props.locale} /> : tab === 'files' ? <FilesPanel files={props.files} locale={props.locale} /> : <PeriodOverview report={report} locale={props.locale} />}
    </div>
  );
}

function PeriodOverview({ report, locale }: { report: PeriodTimeReport; locale: AppLocale }) {
  const ru = locale === 'RU';
  const s = report.summary; const statuses = s.timesheetStatusCounts;
  const periodStatusLabel = report.period.status === 'OPEN' ? (ru ? 'Открыт' : 'Open') : report.period.status === 'EXPORTED' ? (ru ? 'Выгружен' : 'Exported') : (ru ? 'Заблокирован' : 'Locked');
  return <>
    <div className="report-period-strip"><div><strong>{ru ? 'Расчётный период' : 'Payroll period'}</strong><span>{report.period.startDate} – {report.period.endDate} · {ru ? 'обновлено' : 'updated'} {formatHelsinkiDateTime(report.asOf)}</span></div><span className={report.period.status === 'OPEN' ? 'report-status report-status-open' : 'report-status'}>{periodStatusLabel}</span></div>
    <div className="report-kpi-grid"><Kpi label={ru ? 'Отработано' : 'Worked'} value={formatWorkedDuration(s.workedMinutes, locale)} note={`${s.workedWorkerCount} ${ru ? 'работников с часами' : 'workers with hours'}`} /><Kpi label={ru ? 'Всего часов' : 'Gross time'} value={formatWorkedDuration(s.grossMinutes, locale)} note={`${s.paidBreakMinutes + s.unpaidBreakMinutes} ${ru ? 'минут перерывов' : 'break minutes'}`} /><Kpi label={ru ? 'Работники' : 'Workers'} value={String(s.workerCount)} note={`${s.siteCount} ${ru ? 'объектов' : 'sites'}`} /><Kpi label={ru ? 'Табели без проблем' : 'Final approved'} value={String(statuses.FINAL_APPROVED)} note={`${s.withoutTimesheetCount} ${ru ? 'без табеля' : 'without timesheet'}`} /></div>
    <div className="report-grid-2"><section className="report-panel"><div className="report-panel-heading"><div><h2>{ru ? 'Объекты и часы' : 'Sites and hours'}</h2><p>{ru ? 'Кликните объект для детализации по людям и дням.' : 'Open a site for people and daily detail.'}</p></div><Link className="report-button" href={`/admin/reports?periodId=${report.period.id}&view=site`}>{ru ? 'Все объекты' : 'All sites'} →</Link></div><div className="report-table-wrap"><table className="report-table"><thead><tr><th>{ru ? 'Объект' : 'Site'}</th><th>{ru ? 'Работники' : 'Workers'}</th><th>{ru ? 'Дни' : 'Days'}</th><th>{ru ? 'Отработано' : 'Worked'}</th><th>{ru ? 'Заполнение' : 'Coverage'}</th></tr></thead><tbody>{report.sites.map((site) => { const coverage = site.assignedWorkerCount ? Math.round(site.workedWorkerCount / site.assignedWorkerCount * 100) : 0; return <tr key={site.site.id}><td><Link href={`/admin/reports?periodId=${report.period.id}&siteId=${site.site.id}&view=site`}>{site.site.name}</Link></td><td>{site.workedWorkerCount} / {site.assignedWorkerCount}</td><td>{site.workedDayCount}</td><td>{formatWorkedDuration(site.workedMinutes, locale)}</td><td><div className="report-progress"><div className="report-progress-track"><span style={{ width: `${Math.min(100, coverage)}%` }} /></div>{coverage}%</div></td></tr>; })}</tbody><tfoot><tr><td>{ru ? 'Итого' : 'Total'}</td><td>{s.workedWorkerCount} / {s.assignedWorkerCount}</td><td>{s.workedDayCount}</td><td>{formatWorkedDuration(s.workedMinutes, locale)}</td><td>—</td></tr></tfoot></table></div></section><aside><section className="report-panel"><div className="report-panel-heading"><div><h2>{ru ? 'Статус табелей' : 'Timesheet status'}</h2><p>{ru ? 'Где требуется внимание' : 'Where attention is needed'}</p></div></div><ul className="report-status-list"><StatusRow dot="blue" label={ru ? 'Черновики' : 'Draft'} value={statuses.DRAFT} /><StatusRow dot="orange" label={ru ? 'На проверке' : 'Submitted'} value={statuses.SUBMITTED} /><StatusRow dot="red" label={ru ? 'Возвращены' : 'Returned'} value={statuses.RETURNED} /><StatusRow dot="green" label={ru ? 'Окончательно одобрены' : 'Final approved'} value={statuses.FINAL_APPROVED} /></ul></section><section className="report-panel"><div className="report-panel-heading"><div><h2>{ru ? 'Быстрые действия' : 'Quick actions'}</h2><p>{ru ? 'Открыть нужную детализацию' : 'Open a focused view'}</p></div></div><div className="report-quick-links"><Link className="report-quick-link" href={`/admin/reports?periodId=${report.period.id}&view=worker`}>{ru ? 'Найти работника' : 'Find a worker'} <span>→</span></Link><Link className="report-quick-link" href={`/admin/timesheets?periodId=${report.period.id}`}>{ru ? 'Открыть табели' : 'Open timesheets'} <span>→</span></Link><Link className="report-quick-link" href={`/admin/reports?periodId=${report.period.id}&view=files`}>{ru ? 'История файлов' : 'File history'} <span>→</span></Link></div></section></aside></div>
  </>;
}

function WorkerDetail({ report, locale }: { report: WorkerTimeReport; locale: AppLocale }) { const ru = locale === 'RU'; return <section className="report-panel"><div className="report-detail-head"><span className="report-avatar">{report.employee.firstName[0]}{report.employee.lastName[0]}</span><div><h2>{report.employee.lastName} {report.employee.firstName}</h2><p>{report.employee.employeeNumber} · {ru ? 'табель' : 'timesheet'}: {report.timesheet ? timesheetStatusLabel(report.timesheet.status, locale) : (ru ? 'нет' : 'none')}</p></div></div><div className="report-kpi-grid"><Kpi label={ru ? 'Отработано' : 'Worked'} value={formatWorkedDuration(report.total.workedMinutes, locale)} note={`${report.total.workedDayCount} ${ru ? 'дней' : 'days'}`} /><Kpi label={ru ? 'Объекты' : 'Sites'} value={String(report.total.siteCount)} note={`${report.total.segmentCount} ${ru ? 'интервалов' : 'segments'}`} /></div><div className="report-table-wrap"><table className="report-table"><thead><tr><th>{ru ? 'Объект' : 'Site'}</th><th>{ru ? 'Дни' : 'Days'}</th><th>{ru ? 'Всего' : 'Gross'}</th><th>{ru ? 'Перерывы' : 'Breaks'}</th><th>{ru ? 'Отработано' : 'Worked'}</th></tr></thead><tbody>{report.sites.map((site) => <tr key={site.siteId}><td>{site.siteName}</td><td>{site.workedDayCount}</td><td>{formatWorkedDuration(site.grossMinutes, locale)}</td><td>{formatWorkedDuration(site.paidBreakMinutes + site.unpaidBreakMinutes, locale)}</td><td><strong>{formatWorkedDuration(site.workedMinutes, locale)}</strong></td></tr>)}</tbody></table></div></section>; }
function SiteDetail({ report, locale }: { report: SiteTimeReport; locale: AppLocale }) { const ru = locale === 'RU'; return <section className="report-panel"><div className="report-detail-head"><span className="report-avatar">⌂</span><div><h2>{report.site.name}</h2><p>{report.period.startDate} – {report.period.endDate} · {report.items.length} {ru ? 'работников на странице' : 'workers on page'}</p></div></div><div className="report-kpi-grid"><Kpi label={ru ? 'Отработано' : 'Worked'} value={formatWorkedDuration(report.summary.workedMinutes, locale)} note={`${report.summary.workedDayCount} ${ru ? 'дней' : 'days'}`} /><Kpi label={ru ? 'Работники' : 'Workers'} value={String(report.summary.workerCount)} note={`${report.summary.withoutTimesheetCount} ${ru ? 'без табеля' : 'without timesheet'}`} /></div><div className="report-table-wrap"><table className="report-table"><thead><tr><th>{ru ? 'Работник' : 'Worker'}</th><th>{ru ? 'Статус табеля' : 'Timesheet'}</th><th>{ru ? 'Дни' : 'Days'}</th><th>{ru ? 'Отработано' : 'Worked'}</th></tr></thead><tbody>{report.items.map((item) => <tr key={item.employee.id}><td><Link href={`/admin/reports?periodId=${report.period.id}&employeeId=${item.employee.id}&view=worker`}>{item.employee.lastName} {item.employee.firstName}</Link><div className="report-muted">{item.employee.employeeNumber}</div></td><td>{item.timesheet ? timesheetStatusLabel(item.timesheet.status, locale) : '—'}</td><td>{item.total.workedDayCount}</td><td><strong>{formatWorkedDuration(item.total.workedMinutes, locale)}</strong></td></tr>)}</tbody></table></div></section>; }
function FilesPanel({ files, locale }: { files: ReportFileSummary[]; locale: AppLocale }) { const ru = locale === 'RU'; return <section className="report-panel"><div className="report-panel-heading"><div><h2>{ru ? 'Сохранённые файлы' : 'Saved report files'}</h2><p>{ru ? 'PDF и CSV остаются здесь, пока вы их не удалите.' : 'PDF and CSV files stay here until you remove them.'}</p></div></div>{files.length === 0 ? <p className="report-empty">{ru ? 'Сохранённых файлов пока нет.' : 'No saved files yet.'}</p> : <ul className="report-file-list">{files.map((file) => <li className="report-file-row" key={file.id}><div className="report-file-main"><strong>{file.fileName}</strong><span>{file.format} · {Math.max(1, Math.round(file.fileSizeBytes / 1024))} KB · {formatHelsinkiDateTime(file.createdAt)}</span></div><div className="report-file-actions"><Link href={file.downloadUrl}>{ru ? 'Скачать' : 'Download'}</Link><ReportFileDeleteButton fileId={file.id} /></div></li>)}</ul>}</section>; }
function Kpi({ label, value, note }: { label: string; value: string; note: string }) { return <div className="report-kpi"><p className="report-kpi-label">{label}</p><p className="report-kpi-value">{value}</p><p className="report-kpi-note">{note}</p></div>; }
function StatusRow({ dot, label, value }: { dot: string; label: string; value: number }) { return <li className="report-status-row"><span><span className={`report-status-dot report-status-dot-${dot}`} />{label}</span><span>{value}</span></li>; }
