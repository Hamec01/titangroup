// UT8-B / UT8-B-fixup — pure unit coverage for lib/reporting/customer-hours-summary.ts's exported
// validateSummaryRange, plus a fast smoke test of the CSV/PDF renderers' preview/final marking and
// the fixup's new historical/source-error preview sections. No database.
export {}; // forces module scope (avoids TS2393 colliding with other test scripts' own global main())

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
}

async function main() {
  const { validateSummaryRange, SUMMARY_MAX_WEEKS } = await import('../lib/reporting/customer-hours-summary');
  const { buildCustomerHoursSummaryCsv } = await import('../lib/reporting/customer-hours-summary-csv');
  const { buildCustomerHoursSummaryPdf } = await import('../lib/reporting/customer-hours-summary-pdf');
  const { customerHoursApprovalEnabled } = await import('../lib/customer-hours-approval-flag');

  // ---------------------------------------------------------------------------------------------
  // 1. validateSummaryRange — allTime is always rejected, regardless of any range also present.
  // ---------------------------------------------------------------------------------------------
  {
    const r1 = validateSummaryRange({ allTime: true, requestedRange: null });
    check('1: allTime=true, no range -> ALL_TIME_NOT_ALLOWED', r1?.code === 'ALL_TIME_NOT_ALLOWED', r1);
    const r2 = validateSummaryRange({ allTime: true, requestedRange: { startDate: '2036-01-05', endDate: '2036-01-11' } });
    check('1b: allTime=true even WITH a range -> still ALL_TIME_NOT_ALLOWED', r2?.code === 'ALL_TIME_NOT_ALLOWED', r2);
    const r3 = validateSummaryRange({ allTime: false, requestedRange: null });
    check('1c: allTime=false but no range -> ALL_TIME_NOT_ALLOWED', r3?.code === 'ALL_TIME_NOT_ALLOWED', r3);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. validateSummaryRange — exactly 6 weeks (the boundary) is allowed; 7 is not.
  // ---------------------------------------------------------------------------------------------
  {
    // 2036-01-07 is a real Monday (same anchor date the diff-browser test fixture already uses).
    // 6 full weeks = 42 days, ending Sunday 2036-02-17.
    const sixWeeks = validateSummaryRange({ allTime: false, requestedRange: { startDate: '2036-01-07', endDate: '2036-02-17' } });
    check('2: exactly 6 weeks -> allowed (null)', sixWeeks === null, sixWeeks);

    const sevenWeeks = validateSummaryRange({ allTime: false, requestedRange: { startDate: '2036-01-07', endDate: '2036-02-24' } });
    check('2b: 7 weeks -> RANGE_TOO_LARGE', sevenWeeks?.code === 'RANGE_TOO_LARGE', sevenWeeks);
    if (sevenWeeks?.code === 'RANGE_TOO_LARGE') {
      check('2c: actualWeeks reported correctly (7)', sevenWeeks.actualWeeks === 7, sevenWeeks);
      check('2d: maxWeeks reported correctly', sevenWeeks.maxWeeks === SUMMARY_MAX_WEEKS, sevenWeeks);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 3. validateSummaryRange — a non-week-aligned range is normalized to full Helsinki weeks before
  //    counting (mirrors getTimeLedger's own normalizeToFullWeeks), so a request that LOOKS like
  //    under 6 weeks in raw days can still be rejected once expanded to whole weeks.
  // ---------------------------------------------------------------------------------------------
  {
    // Both endpoints mid-week, spanning well past the 6-week boundary once normalized outward.
    const midWeek = validateSummaryRange({ allTime: false, requestedRange: { startDate: '2036-01-10', endDate: '2036-02-28' } });
    check('3: a raw range normalizing to more than 6 full weeks is still rejected', midWeek?.code === 'RANGE_TOO_LARGE', midWeek);
  }

  // ---------------------------------------------------------------------------------------------
  // 4. CSV — formula-injection guard applies to human-text columns (customer/site/employee name).
  // ---------------------------------------------------------------------------------------------
  {
    const fakeRow: any = {
      logicalKey: { employeeId: 'e1', timesheetId: 't1', siteId: 's1', workAreaId: 'w1', weekStart: '2036-01-05', weekEnd: '2036-01-11' },
      employeeName: '=cmd|/c calc',
      employeeNumber: 'E-1',
      approvalState: 'APPROVED',
      submissionState: 'SUBMITTED',
      workedMinutes: 450,
      currentApprovalItem: { approvedByUserName: 'Admin', approvedAt: '2036-01-12T10:00:00.000Z' }
    };
    const fakeSummary: any = {
      requestedRange: { startDate: '2036-01-05', endDate: '2036-01-11' },
      rows: [fakeRow],
      historical: [],
      notSubmitted: [],
      sourceErrors: [],
      totals: { historicalTruncated: false },
      byCustomer: [{ siteId: 's1', siteName: 'Site A', workAreaId: 'w1', workAreaName: 'Aros Marine' }]
    };
    const csv = buildCustomerHoursSummaryCsv(fakeSummary, 'final');
    const text = csv.toString('utf8');
    check('4: a formula-triggering employee name is prefixed with a quote in the CSV (never a raw = at cell start)', text.includes("'=cmd|/c calc") && !text.includes('"=cmd|/c calc"'), text);
    check('4b: worked_minutes/worked_hours reflect the row (450 -> 7.50)', text.includes('450') && text.includes('7.50'), text);
  }

  // ---------------------------------------------------------------------------------------------
  // 5. CSV — mode='final' excludes non-APPROVED rows even if passed in `rows`.
  // ---------------------------------------------------------------------------------------------
  {
    const approved: any = {
      logicalKey: { employeeId: 'e1', timesheetId: 't1', siteId: 's1', workAreaId: 'w1', weekStart: '2036-01-05', weekEnd: '2036-01-11' },
      employeeName: 'Approved Worker',
      employeeNumber: 'E-1',
      approvalState: 'APPROVED',
      submissionState: 'SUBMITTED',
      workedMinutes: 100,
      currentApprovalItem: { approvedByUserName: 'Admin', approvedAt: '2036-01-12T10:00:00.000Z' }
    };
    const changed: any = {
      logicalKey: { employeeId: 'e2', timesheetId: 't2', siteId: 's1', workAreaId: 'w1', weekStart: '2036-01-05', weekEnd: '2036-01-11' },
      employeeName: 'Changed Worker',
      employeeNumber: 'E-2',
      approvalState: 'CHANGED_AFTER_APPROVAL',
      submissionState: 'SUBMITTED',
      workedMinutes: 200,
      currentApprovalItem: null
    };
    const fakeSummary: any = {
      requestedRange: { startDate: '2036-01-05', endDate: '2036-01-11' },
      rows: [approved, changed],
      historical: [],
      notSubmitted: [],
      sourceErrors: [],
      totals: { historicalTruncated: false },
      byCustomer: [{ siteId: 's1', siteName: 'Site A', workAreaId: 'w1', workAreaName: 'Aros Marine' }]
    };
    const finalCsv = buildCustomerHoursSummaryCsv(fakeSummary, 'final').toString('utf8');
    check('5: final CSV includes the approved worker', finalCsv.includes('Approved Worker'), finalCsv);
    check('5b: final CSV excludes the changed-after-approval worker', !finalCsv.includes('Changed Worker'), finalCsv);

    const previewCsv = buildCustomerHoursSummaryCsv(fakeSummary, 'preview').toString('utf8');
    check('5c: preview CSV includes BOTH workers', previewCsv.includes('Approved Worker') && previewCsv.includes('Changed Worker'), previewCsv);
    check('5d: preview CSV labels the changed row', previewCsv.includes('changed_after_approval'), previewCsv);
  }

  // ---------------------------------------------------------------------------------------------
  // 6. PDF — preview and final both render without throwing, and carry the right marker text.
  // ---------------------------------------------------------------------------------------------
  {
    const approved: any = {
      logicalKey: { employeeId: 'e1', timesheetId: 't1', siteId: 's1', workAreaId: 'w1', weekStart: '2036-01-05', weekEnd: '2036-01-11' },
      employeeName: 'Approved Worker',
      employeeNumber: 'E-1',
      approvalState: 'APPROVED',
      submissionState: 'SUBMITTED',
      workedMinutes: 450,
      currentApprovalItem: { approvedByUserName: 'Admin', approvedAt: '2036-01-12T10:00:00.000Z' }
    };
    const fakeSummary: any = {
      requestedRange: { startDate: '2036-01-05', endDate: '2036-01-11' },
      rows: [approved],
      historical: [],
      notSubmitted: [],
      sourceErrors: [],
      totals: { confirmedWorkerCount: 1, historicalTruncated: false },
      byCustomer: [{ siteId: 's1', siteName: 'Site A', workAreaId: 'w1', workAreaName: 'Aros Marine' }]
    };
    const meta = { generatedAtHelsinki: '05.01.2036 10:00', preparedBy: 'admin' };
    const finalPdf = await buildCustomerHoursSummaryPdf(fakeSummary, 'final', meta);
    check('6: final PDF is a real PDF buffer (starts with %PDF)', finalPdf.subarray(0, 4).toString('ascii') === '%PDF', finalPdf.length);
    const previewPdf = await buildCustomerHoursSummaryPdf(fakeSummary, 'preview', meta);
    check('6b: preview PDF is a real PDF buffer too', previewPdf.subarray(0, 4).toString('ascii') === '%PDF', previewPdf.length);
    check('6c: preview and final PDFs are byte-different (the watermark text differs)', !finalPdf.equals(previewPdf));
  }

  // ---------------------------------------------------------------------------------------------
  // 7. UT8-B-fixup #2 — preview CSV/PDF show historical + source-error rows explicitly, with their
  //    own reason, never folded into any total; final never shows them at all.
  // ---------------------------------------------------------------------------------------------
  {
    const historicalRow: any = {
      timesheetId: 't-h1',
      employeeId: 'e-h1',
      employeeName: 'Removed Worker',
      employeeNumber: 'E-H1',
      siteId: 's1',
      siteName: 'Site A',
      workAreaId: 'w1',
      workAreaName: 'Aros Marine',
      weekStart: '2036-01-05',
      weekEnd: '2036-01-11',
      reason: 'SLICE_REMOVED',
      lastApproval: { fingerprint: 'f'.repeat(64), workedMinutes: 300, grossMinutes: 330, breakMinutes: 30, approvedAt: '2036-01-06T10:00:00.000Z', approvedByUserName: 'Admin' }
    };
    const sourceErrorRow: any = {
      kind: 'SOURCE_ERROR',
      employeeId: 'e-se1',
      employeeName: 'Broken Worker',
      employeeNumber: 'E-SE1',
      timesheetId: 't-se1',
      periodId: 'p1',
      periodStartDate: '2036-01-05',
      periodEndDate: '2036-01-11',
      reason: 'REPORT_CANONICAL_SOURCE_INVARIANT_FAILURE: test',
      workedMinutes: null,
      approvable: false
    };
    const notSubmittedRow: any = {
      kind: 'NOT_SUBMITTED',
      employeeId: 'e-ns1',
      employeeName: 'Missing Worker',
      employeeNumber: 'E-NS1',
      periodId: 'p2',
      periodStartDate: '2036-01-05',
      periodEndDate: '2036-01-11',
      timesheetId: null,
      timesheetStatus: null,
      weeksCovered: ['2036-01-05']
    };
    const approvedRow: any = {
      logicalKey: { employeeId: 'e1', timesheetId: 't1', siteId: 's1', workAreaId: 'w1', weekStart: '2036-01-05', weekEnd: '2036-01-11' },
      employeeName: 'Approved Worker',
      employeeNumber: 'E-1',
      approvalState: 'APPROVED',
      submissionState: 'SUBMITTED',
      workedMinutes: 450,
      currentApprovalItem: { approvedByUserName: 'Admin', approvedAt: '2036-01-06T10:00:00.000Z' }
    };
    const fakeSummary: any = {
      requestedRange: { startDate: '2036-01-05', endDate: '2036-01-11' },
      rows: [approvedRow],
      historical: [historicalRow],
      sourceErrors: [sourceErrorRow],
      notSubmitted: [notSubmittedRow],
      totals: { confirmedWorkerCount: 1, historicalTruncated: false },
      byCustomer: [{ siteId: 's1', siteName: 'Site A', workAreaId: 'w1', workAreaName: 'Aros Marine' }]
    };

    const previewCsv = buildCustomerHoursSummaryCsv(fakeSummary, 'preview').toString('utf8');
    check('7: preview CSV lists the historical row (HISTORICAL row_type + employee name)', previewCsv.includes('HISTORICAL') && previewCsv.includes('Removed Worker'), previewCsv);
    check('7b: preview CSV lists the source-error row (SOURCE_ERROR row_type + employee name)', previewCsv.includes('SOURCE_ERROR') && previewCsv.includes('Broken Worker'), previewCsv);
    check('7c: preview CSV marks the historical row removed_after_confirmation', previewCsv.includes('removed_after_confirmation'), previewCsv);
    check('7c2: preview CSV lists the not-submitted row under row_type NOT_SUBMITTED with no hours', previewCsv.includes('NOT_SUBMITTED') && previewCsv.includes('Missing Worker'), previewCsv);
    const notSubmittedLine = previewCsv.split('\r\n').find((l) => l.startsWith('"NOT_SUBMITTED"'));
    check('7c3: the NOT_SUBMITTED row carries no worked_minutes value', !!notSubmittedLine && notSubmittedLine.split(',')[7] === '""', notSubmittedLine);

    // GRAND_TOTAL only appears with >1 customer in the DETAIL set; here there's only one, so the
    // strongest available check is that the historical row's OLD minutes (300 -> 5.00h) never merge
    // into the CUSTOMER_TOTAL line, which must still read exactly the approved row's own 450 min.
    const customerTotalLine = previewCsv.split('\r\n').find((l) => l.startsWith('"CUSTOMER_TOTAL"'));
    check('7d: CUSTOMER_TOTAL still reflects only the approved row (450 min), not 450+300', !!customerTotalLine && customerTotalLine.includes('450') && !customerTotalLine.includes('750'), customerTotalLine);

    const finalCsv = buildCustomerHoursSummaryCsv(fakeSummary, 'final').toString('utf8');
    check('7e: final CSV never lists HISTORICAL rows', !finalCsv.includes('HISTORICAL'), finalCsv);
    check('7f: final CSV never lists SOURCE_ERROR rows', !finalCsv.includes('SOURCE_ERROR'), finalCsv);
    check('7f2: final CSV never lists NOT_SUBMITTED rows', !finalCsv.includes('NOT_SUBMITTED'), finalCsv);

    const truncatedSummary: any = { ...fakeSummary, totals: { ...fakeSummary.totals, historicalTruncated: true } };
    const previewCsvTruncated = buildCustomerHoursSummaryCsv(truncatedSummary, 'preview').toString('utf8');
    check('7g: a truncated historical list adds an explicit NOTE row in preview', previewCsvTruncated.includes('NOTE') && previewCsvTruncated.toLowerCase().includes('incomplete'), previewCsvTruncated);

    const meta = { generatedAtHelsinki: '05.01.2036 10:00', preparedBy: 'admin' };
    const previewPdfWithHistory = await buildCustomerHoursSummaryPdf(fakeSummary, 'preview', meta);
    const previewPdfNoHistory = await buildCustomerHoursSummaryPdf({ ...fakeSummary, historical: [], sourceErrors: [], notSubmitted: [] }, 'preview', meta);
    check('7h: preview PDF renders more content when historical/source-error rows exist (real, non-throwing render)', previewPdfWithHistory.length > previewPdfNoHistory.length, { withHistory: previewPdfWithHistory.length, noHistory: previewPdfNoHistory.length });
    const finalPdfWithHistory = await buildCustomerHoursSummaryPdf(fakeSummary, 'final', meta);
    check('7i: final PDF still renders successfully even when historical/source-error data is present (never included, never throws)', finalPdfWithHistory.subarray(0, 4).toString('ascii') === '%PDF', finalPdfWithHistory.length);

    const previewPdfNoNotSubmitted = await buildCustomerHoursSummaryPdf({ ...fakeSummary, notSubmitted: [] }, 'preview', meta);
    check('7j: preview PDF renders MORE content with the not-submitted row than without it (its own section is real)', previewPdfWithHistory.length > previewPdfNoNotSubmitted.length, { withNotSubmitted: previewPdfWithHistory.length, without: previewPdfNoNotSubmitted.length });
  }

  // ---------------------------------------------------------------------------------------------
  // 8. UT8-B-fixup #3 (renderer robustness) — the CSV/PDF builders are the ONLY step allowed to run
  //    before the audit write in the export route; genuinely malformed input at that step throws
  //    rather than silently producing a corrupt file, so a real failure there is never mistaken for
  //    success (which is exactly why the route builds content BEFORE writing the audit — a thrown
  //    error here must propagate out before any AuditEvent is written). End-to-end fault injection
  //    through the real HTTP route was not attempted here — see the DB test / fixup report for why
  //    that specific path is not practically constructible without weakening production code.
  // ---------------------------------------------------------------------------------------------
  {
    // A row missing its own logicalKey — CSV code reads r.logicalKey.workAreaId unconditionally.
    const malformedCsv: any = { requestedRange: { startDate: '2036-01-05', endDate: '2036-01-11' }, rows: [{ employeeName: 'X' }], historical: [], sourceErrors: [], notSubmitted: [], totals: { confirmedWorkerCount: 0, historicalTruncated: false }, byCustomer: [] };
    let threw = false;
    try {
      buildCustomerHoursSummaryCsv(malformedCsv, 'preview');
    } catch {
      threw = true;
    }
    check('8: the CSV builder throws (not silently produces a broken file) for a row missing its logicalKey', threw);

    // requestedRange missing — PDF code reads summary.requestedRange.startDate unconditionally.
    const malformedPdf: any = { requestedRange: undefined, rows: [], historical: [], sourceErrors: [], notSubmitted: [], totals: { confirmedWorkerCount: 0, historicalTruncated: false }, byCustomer: [] };
    let pdfThrew = false;
    try {
      await buildCustomerHoursSummaryPdf(malformedPdf, 'preview', { generatedAtHelsinki: 'x', preparedBy: 'x' });
    } catch {
      pdfThrew = true;
    }
    check('8b: the PDF builder throws too for a summary missing requestedRange', pdfThrew);
  }

  // ---------------------------------------------------------------------------------------------
  // 9. UT8-B-fixup-3 #2 — submissionState overrides approvalState for BOTH the final-mode filter
  //    and the displayed status: a row an admin already approved while it was still an unsubmitted
  //    DRAFT/RETURNED slice (submissionState !== 'SUBMITTED') must never reach final output, and in
  //    preview must show its real hours labeled not_submitted, never "confirmed".
  // ---------------------------------------------------------------------------------------------
  {
    const approvedSubmitted: any = {
      logicalKey: { employeeId: 'e1', timesheetId: 't1', siteId: 's1', workAreaId: 'w1', weekStart: '2036-01-05', weekEnd: '2036-01-11' },
      employeeName: 'Submitted Worker',
      employeeNumber: 'E-1',
      approvalState: 'APPROVED',
      submissionState: 'SUBMITTED',
      workedMinutes: 300,
      currentApprovalItem: { approvedByUserName: 'Admin', approvedAt: '2036-01-06T10:00:00.000Z' }
    };
    const approvedButUnsubmitted: any = {
      logicalKey: { employeeId: 'e2', timesheetId: 't2', siteId: 's1', workAreaId: 'w1', weekStart: '2036-01-05', weekEnd: '2036-01-11' },
      employeeName: 'Draft Worker',
      employeeNumber: 'E-2',
      approvalState: 'APPROVED',
      submissionState: 'NOT_SUBMITTED',
      workedMinutes: 400,
      currentApprovalItem: { approvedByUserName: 'Admin', approvedAt: '2036-01-06T10:00:00.000Z' }
    };
    const fakeSummary: any = {
      requestedRange: { startDate: '2036-01-05', endDate: '2036-01-11' },
      rows: [approvedSubmitted, approvedButUnsubmitted],
      historical: [],
      sourceErrors: [],
      notSubmitted: [],
      totals: { confirmedWorkerCount: 1, historicalTruncated: false },
      byCustomer: [{ siteId: 's1', siteName: 'Site A', workAreaId: 'w1', workAreaName: 'Aros Marine' }]
    };

    const finalCsv = buildCustomerHoursSummaryCsv(fakeSummary, 'final').toString('utf8');
    check('9: final CSV includes the truly submitted+approved worker', finalCsv.includes('Submitted Worker'), finalCsv);
    check('9b: final CSV excludes the approved-but-unsubmitted worker even though approvalState is APPROVED', !finalCsv.includes('Draft Worker'), finalCsv);

    const previewCsv = buildCustomerHoursSummaryCsv(fakeSummary, 'preview').toString('utf8');
    check('9c: preview CSV shows the approved-but-unsubmitted worker with its real hours (400 min -> 6.67h)', previewCsv.includes('Draft Worker') && previewCsv.includes('400') && previewCsv.includes('6.67'), previewCsv);
    const draftLine = previewCsv.split('\r\n').find((l) => l.startsWith('"DETAIL"') && l.includes('Draft Worker'));
    check('9d: preview CSV labels the approved-but-unsubmitted row not_submitted, never confirmed', !!draftLine && draftLine.includes('not_submitted') && !draftLine.includes('confirmed'), draftLine);
    const submittedLine = previewCsv.split('\r\n').find((l) => l.startsWith('"DETAIL"') && l.includes('Submitted Worker'));
    check('9e: preview CSV still labels the genuinely submitted+approved row confirmed', !!submittedLine && submittedLine.includes('confirmed'), submittedLine);

    const meta = { generatedAtHelsinki: '05.01.2036 10:00', preparedBy: 'admin' };
    const finalPdf = await buildCustomerHoursSummaryPdf(fakeSummary, 'final', meta);
    const previewPdf = await buildCustomerHoursSummaryPdf(fakeSummary, 'preview', meta);
    check('9f: final PDF renders (real PDF, unsubmitted-but-approved row silently excluded)', finalPdf.subarray(0, 4).toString('ascii') === '%PDF', finalPdf.length);
    check('9g: preview PDF renders more content than final (it includes the extra unsubmitted row)', previewPdf.length > finalPdf.length, { preview: previewPdf.length, final: finalPdf.length });
  }

  // ---------------------------------------------------------------------------------------------
  // 10. Optional approval mode — backwards-compatible flag plus approval-free recorded exports.
  // ---------------------------------------------------------------------------------------------
  {
    check('10: approval defaults to enabled when the variable is absent', customerHoursApprovalEnabled({}));
    check('10b: exact false disables approval', !customerHoursApprovalEnabled({ CUSTOMER_HOURS_APPROVAL_ENABLED: 'false' }));
    check('10c: other values do not accidentally disable approval', customerHoursApprovalEnabled({ CUSTOMER_HOURS_APPROVAL_ENABLED: 'FALSE' }));

    const recordedRow: any = {
      logicalKey: { employeeId: 'e1', timesheetId: 't1', siteId: 's1', workAreaId: 'w1', weekStart: '2036-01-05', weekEnd: '2036-01-11' },
      employeeName: 'Current Worker', employeeNumber: 'E-1', approvalState: 'READY', submissionState: 'NOT_SUBMITTED', workedMinutes: 275, currentApprovalItem: null
    };
    const fakeSummary: any = {
      requestedRange: { startDate: '2036-01-05', endDate: '2036-01-11' }, rows: [recordedRow], historical: [], sourceErrors: [], notSubmitted: [],
      totals: { recordedWorkerCount: 1, recordedMinutes: 275, historicalTruncated: false },
      byCustomer: [{ siteId: 's1', siteName: 'Site A', workAreaId: 'w1', workAreaName: 'Aros Marine', recordedMinutes: 275, recordedWorkerCount: 1 }]
    };
    const recordedCsv = buildCustomerHoursSummaryCsv(fakeSummary, 'recorded').toString('utf8');
    const header = recordedCsv.split('\r\n')[0];
    check('10d: recorded CSV contains every current row regardless of approval/submission state', recordedCsv.includes('Current Worker') && recordedCsv.includes('275') && recordedCsv.includes('4.58'), recordedCsv);
    check('10e: recorded CSV has no approval/history columns', !header.includes('approval_status') && !header.includes('confirmed_by') && !recordedCsv.includes('pending'), header);
    const recordedPdf = await buildCustomerHoursSummaryPdf(fakeSummary, 'recorded', { generatedAtHelsinki: '05.01.2036 10:00', preparedBy: 'admin' });
    check('10f: recorded PDF renders without requiring approval', recordedPdf.subarray(0, 4).toString('ascii') === '%PDF', recordedPdf.length);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
