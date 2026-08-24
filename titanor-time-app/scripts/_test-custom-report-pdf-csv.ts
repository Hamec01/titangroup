// Task spec §37F — CSV/PDF byte-level checks: BOM, no UUIDs, correct totals, PDF %PDF- header,
// non-empty, Unicode (Cyrillic + Finnish) names don't crash generation.
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { getCustomTimeReport } from '../lib/reporting/custom-time-report';
import { buildCustomReportSummaryCsv, buildCustomReportDetailedCsv, customReportCsvFileName } from '../lib/reporting/custom-report-csv';
import { buildCustomReportSummaryPdf, buildCustomReportDetailedPdf, customReportPdfFileName } from '../lib/reporting/custom-report-pdf';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra ?? '');
  }
}

async function main() {
  const adminRole = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const admin = await prisma.user.create({ data: { username: `csvpdf-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: adminRole.id } } } });

  // Cyrillic + Finnish diacritics worker names — exactly the case that produces empty boxes if
  // the PDF font has no Unicode coverage.
  const empRu = await prisma.employee.create({ data: { employeeNumber: `PDFTEST-RU-${randomUUID().slice(0, 6)}`, firstName: 'Игорь', lastName: 'Чурыгин' } });
  const empFi = await prisma.employee.create({ data: { employeeNumber: `PDFTEST-FI-${randomUUID().slice(0, 6)}`, firstName: 'Änne', lastName: 'Mäkinen' } });
  const site = await prisma.workSite.create({ data: { name: 'Тестовый объект — Ähtäri' } });
  const workArea = await prisma.workArea.create({ data: { siteId: site.id, name: 'Зона А' } });

  const period = await prisma.payrollPeriod.create({ data: { startDate: new Date('2060-01-01'), endDate: new Date('2060-01-14'), status: 'OPEN', openedByUserId: admin.id } });

  for (const emp of [empRu, empFi]) {
    const asg = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, workAreaId: workArea.id, isPrimary: true, validFrom: new Date('2000-01-01'), assignedByUserId: admin.id } });
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
    const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'FINAL_APPROVED' } });
    const version = await prisma.timesheetVersion.create({ data: { timesheetId: ts.id, employeeId: emp.id, versionNumber: 1, source: 'WORKER', createdByUserId: admin.id, submissionSource: 'MANUAL' } });
    await prisma.timesheet.update({ where: { id: ts.id }, data: { currentVersionId: version.id } });
    const date = new Date('2060-01-02');
    const day = await prisma.timesheetDay.create({ data: { timesheetVersionId: version.id, date, dayType: 'WORK', confirmedZero: false } });
    await prisma.timesheetPlannedShift.create({ data: { timesheetVersionId: version.id, employeeId: emp.id, date, siteId: site.id, sourceAssignmentId: asg.id, plannedBreakMinutes: 0 } });
    const seg = await prisma.workSegment.create({ data: { timesheetDayId: day.id, timesheetVersionId: version.id, employeeId: emp.id, date, startAt: new Date('2060-01-02T08:00:00.000Z'), endAt: new Date('2060-01-02T16:00:00.000Z'), siteId: site.id, workAreaId: workArea.id, sourceAssignmentId: asg.id, crossesMidnight: false } });
    await prisma.breakSegment.create({ data: { workSegmentId: seg.id, startAt: new Date('2060-01-02T12:00:00.000Z'), endAt: new Date('2060-01-02T12:30:00.000Z'), paid: false } });
  }

  const report = await getCustomTimeReport({ dateFrom: period.startDate, dateTo: period.endDate, employeeIds: null, siteIds: null, dataMode: 'FINAL_APPROVED_ONLY' });
  check('fixture: report has 2 summary rows', report.summaryRows.length === 2, report.summaryRows.length);

  // --- CSV ---
  const summaryCsv = buildCustomReportSummaryCsv(report, 'EN');
  const detailedCsv = buildCustomReportDetailedCsv(report, 'RU');
  check('CSV summary starts with UTF-8 BOM', summaryCsv[0] === 0xef && summaryCsv[1] === 0xbb && summaryCsv[2] === 0xbf);
  check('CSV detailed starts with UTF-8 BOM', detailedCsv[0] === 0xef && detailedCsv[1] === 0xbb && detailedCsv[2] === 0xbf);
  const summaryText = summaryCsv.toString('utf8');
  const detailedText = detailedCsv.toString('utf8');
  check('CSV summary contains Cyrillic name', summaryText.includes('Чурыгин'));
  check('CSV detailed contains Finnish diacritics', detailedText.includes('Mäkinen'));
  check('CSV summary has no UUID-looking substrings', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(summaryText), summaryText.slice(0, 300));
  check('CSV detailed has no UUID-looking substrings', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(detailedText));
  check('CSV summary has no JSON braces', !summaryText.includes('{') && !summaryText.includes('}'));
  check('CSV summary uses CRLF line endings', summaryText.includes('\r\n'));
  // formula-injection guard: a name starting with "=" must be prefixed with a literal quote.
  // Cell is assembled as "lastName firstName" (see custom-report-csv.ts) — the trigger char must
  // lead lastName, not firstName, to actually land at the start of the cell.
  const injectionEmp = await prisma.employee.create({ data: { employeeNumber: `PDFTEST-INJ-${randomUUID().slice(0, 6)}`, firstName: 'Injector', lastName: '=CMD' } });
  const asgInj = await prisma.siteAssignment.create({ data: { employeeId: injectionEmp.id, siteId: site.id, isPrimary: true, validFrom: new Date('2000-01-01'), assignedByUserId: admin.id } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: injectionEmp.id, expected: true } });
  const tsInj = await prisma.timesheet.create({ data: { employeeId: injectionEmp.id, periodId: period.id, status: 'FINAL_APPROVED' } });
  const versionInj = await prisma.timesheetVersion.create({ data: { timesheetId: tsInj.id, employeeId: injectionEmp.id, versionNumber: 1, source: 'WORKER', createdByUserId: admin.id, submissionSource: 'MANUAL' } });
  await prisma.timesheet.update({ where: { id: tsInj.id }, data: { currentVersionId: versionInj.id } });
  const dayInj = await prisma.timesheetDay.create({ data: { timesheetVersionId: versionInj.id, date: new Date('2060-01-03'), dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetPlannedShift.create({ data: { timesheetVersionId: versionInj.id, employeeId: injectionEmp.id, date: new Date('2060-01-03'), siteId: site.id, sourceAssignmentId: asgInj.id, plannedBreakMinutes: 0 } });
  await prisma.workSegment.create({ data: { timesheetDayId: dayInj.id, timesheetVersionId: versionInj.id, employeeId: injectionEmp.id, date: new Date('2060-01-03'), startAt: new Date('2060-01-03T08:00:00.000Z'), endAt: new Date('2060-01-03T09:00:00.000Z'), siteId: site.id, sourceAssignmentId: asgInj.id, crossesMidnight: false } });

  const reportWithInjection = await getCustomTimeReport({ dateFrom: period.startDate, dateTo: period.endDate, employeeIds: [injectionEmp.id], siteIds: null, dataMode: 'FINAL_APPROVED_ONLY' });
  const injectionCsv = buildCustomReportSummaryCsv(reportWithInjection, 'EN').toString('utf8');
  check('CSV formula-injection guard prefixes a leading "=" cell with a quote', injectionCsv.includes('"\'=CMD Injector"'), injectionCsv);

  // --- totals correctness ---
  check('CSV summary grand total row present', summaryText.includes('GRAND TOTAL'));
  const expectedWorked = report.grandTotal.workedMinutes;
  check('report grand total worked minutes = 2 x 7h30m = 900', expectedWorked === 900, expectedWorked);

  // --- PDF ---
  const meta = { generatedAtHelsinki: '24.08.2026 22:00', workersLabel: 'All', sitesLabel: 'All', dataModeLabel: 'Final approved only' };
  const summaryPdf = await buildCustomReportSummaryPdf(report, meta, 'EN');
  const detailedPdf = await buildCustomReportDetailedPdf(report, meta, 'RU');
  check('PDF summary starts with %PDF-', summaryPdf.subarray(0, 5).toString('ascii') === '%PDF-');
  check('PDF detailed starts with %PDF-', detailedPdf.subarray(0, 5).toString('ascii') === '%PDF-');
  check('PDF summary non-empty (>1KB)', summaryPdf.byteLength > 1024, summaryPdf.byteLength);
  check('PDF detailed non-empty (>1KB)', detailedPdf.byteLength > 1024, detailedPdf.byteLength);
  check('PDF generation with Cyrillic + Finnish names did not throw', true);

  check('CSV filename pattern', /^titanor-time-report_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/.test(customReportCsvFileName(report)), customReportCsvFileName(report));
  check('PDF filename pattern', /^titanor-time-report_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.pdf$/.test(customReportPdfFileName(report)), customReportPdfFileName(report));

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error('SCRIPT ERROR', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
