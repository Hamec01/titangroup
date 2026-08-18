import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { prisma } from '../lib/prisma';

function helsinkiToday(): Date {
  const isoDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
  return new Date(`${isoDate}T00:00:00.000Z`);
}

async function makeUser(username: string, roleNames: string[]) {
  const user = await prisma.user.create({ data: { username: `${username}-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  for (const roleName of roleNames) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  const rawToken = randomBytes(32).toString('base64url');
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(rawToken).digest('hex'), expiresAt: new Date(Date.now() + 3600_000) } });
  return { user, rawToken };
}

async function makeClockEvent(employeeId: string, siteId: string, operationType: 'CHECK_IN' | 'CHECK_OUT', at: Date) {
  const id = randomUUID();
  await prisma.clockEvent.create({
    data: {
      id,
      employeeId,
      operationType,
      siteId,
      clientCapturedAt: at,
      capturedOffline: false,
      serverReceivedAt: at,
      effectiveAt: at,
      gpsVerification: 'NOT_VERIFIED',
      processingState: 'ACCEPTED',
      channel: 'ONLINE',
      payloadHash: createHash('sha256').update(id).digest('hex'),
      requestId: randomUUID()
    }
  });
  return id;
}

async function main() {
  const { user: admin1, rawToken: admin1Token } = await makeUser('ovadmin1', ['ADMIN']);
  const { user: superadmin, rawToken: superadminToken } = await makeUser('ovsuper', ['SUPER_ADMIN']);
  const { user: worker, rawToken: workerToken } = await makeUser('ovworker', ['WORKER']);
  const { user: foreman1, rawToken: foreman1Token } = await makeUser('ovforeman1', ['FOREMAN']);
  const { user: foreman2, rawToken: foreman2Token } = await makeUser('ovforeman2', ['FOREMAN']);

  const siteA = await prisma.workSite.create({ data: { name: `Overview Site A ${randomUUID().slice(0, 4)}` } });
  const siteB = await prisma.workSite.create({ data: { name: `Overview Site B ${randomUUID().slice(0, 4)}` } });

  const assignmentStart = new Date('2020-01-01T00:00:00.000Z');
  await prisma.foremanAssignment.create({ data: { foremanUserId: foreman1.id, siteId: siteA.id, validFrom: assignmentStart, validTo: null, assignedByUserId: admin1.id } });
  await prisma.foremanAssignment.create({ data: { foremanUserId: foreman2.id, siteId: siteB.id, validFrom: assignmentStart, validTo: null, assignedByUserId: admin1.id } });
  // T7A.9A test: EXPIRED and FUTURE ForemanAssignment for foreman1 at siteB — must not widen scope.
  await prisma.foremanAssignment.create({ data: { foremanUserId: foreman1.id, siteId: siteB.id, validFrom: new Date('2019-01-01'), validTo: new Date('2019-06-01'), assignedByUserId: admin1.id } });
  await prisma.foremanAssignment.create({ data: { foremanUserId: foreman1.id, siteId: siteB.id, validFrom: new Date('2099-01-01'), validTo: null, assignedByUserId: admin1.id } });

  const today = helsinkiToday();
  const period = await prisma.payrollPeriod.create({ data: { startDate: today, endDate: new Date(today.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: admin1.id } });

  async function makeEmployee(tag: string, siteId: typeof siteA) {
    const emp = await prisma.employee.create({ data: { employeeNumber: `TEST-OV-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
    await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: assignmentStart } });
    const asg = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: siteId.id, isPrimary: true, validFrom: assignmentStart, validTo: null, assignedByUserId: admin1.id } });
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
    return { emp, asg };
  }

  async function makeTimesheet(employeeId: string, status: string, submissionSource: 'MANUAL' | 'AUTO' = 'MANUAL') {
    const ts = await prisma.timesheet.create({ data: { employeeId, periodId: period.id, status: status as never } });
    const version = await prisma.timesheetVersion.create({ data: { timesheetId: ts.id, employeeId, versionNumber: 1, source: 'WORKER', createdByUserId: admin1.id, submissionSource } });
    await prisma.timesheet.update({ where: { id: ts.id }, data: { currentVersionId: version.id } });
    return { ts, version };
  }

  async function makeDraft(timesheetId: string, employeeId: string) {
    return prisma.timesheetDraft.create({ data: { timesheetId, employeeId } });
  }

  // ---- WORKING_NOW ------------------------------------------------------------------------
  const { emp: empWorkingNow } = await makeEmployee('WorkingNow', siteA);
  const checkInEvt = await makeClockEvent(empWorkingNow.id, siteA.id, 'CHECK_IN', new Date());
  await prisma.employeeOpenShift.create({ data: { employeeId: empWorkingNow.id, openedByClockEventId: checkInEvt, siteId: siteA.id, openedAt: new Date() } });

  // ---- FINISHED_TODAY -----------------------------------------------------------------------
  const { emp: empFinishedToday } = await makeEmployee('FinishedToday', siteA);
  const startAt = new Date(today.getTime() + 8 * 3600000);
  const endAt = new Date(today.getTime() + 16 * 3600000);
  const inEvt = await makeClockEvent(empFinishedToday.id, siteA.id, 'CHECK_IN', startAt);
  const outEvt = await makeClockEvent(empFinishedToday.id, siteA.id, 'CHECK_OUT', endAt);
  await prisma.clockShift.create({ data: { employeeId: empFinishedToday.id, checkInEventId: inEvt, checkOutEventId: outEvt, siteId: siteA.id, recordedStartAt: startAt, recordedEndAt: endAt } });

  // ---- MISSING_CHECKOUT / GPS_ISSUE / SYNC_ISSUE -----------------------------------------------
  const { emp: empMissingCheckout } = await makeEmployee('MissingCheckout', siteA);
  await prisma.attendanceException.create({ data: { type: 'MISSING_CHECKOUT_AT_CUTOFF', employeeId: empMissingCheckout.id, payrollPeriodId: period.id, occurredAt: new Date(), status: 'OPEN' } });

  const { emp: empGpsIssue } = await makeEmployee('GpsIssue', siteA);
  await prisma.attendanceException.create({ data: { type: 'GPS_NOT_VERIFIED', employeeId: empGpsIssue.id, payrollPeriodId: period.id, occurredAt: new Date(), status: 'OPEN' } });

  const { emp: empSyncIssue } = await makeEmployee('SyncIssue', siteA);
  await prisma.attendanceException.create({ data: { type: 'DOUBLE_CHECK_IN', employeeId: empSyncIssue.id, payrollPeriodId: period.id, occurredAt: new Date(), status: 'OPEN' } });
  // A second OPEN exception of a type outside the three named flags (STALE_ASSIGNMENT is not in
  // GPS_ISSUE_TYPES/SYNC_ISSUE_TYPES/MISSING_CHECKOUT) — must count in openAttendanceExceptions but
  // must NOT raise any of the three named flags (Addendum §A explicit sub-scope note).
  await prisma.attendanceException.create({ data: { type: 'STALE_ASSIGNMENT', employeeId: empSyncIssue.id, payrollPeriodId: period.id, occurredAt: new Date(), status: 'OPEN' } });

  // ---- DRAFT (with recorded-vs-reported diff via TimesheetDraftSegment) ---------------------
  const { emp: empDraft, asg: asgDraft } = await makeEmployee('Draft', siteA);
  const { ts: tsDraft } = await makeTimesheet(empDraft.id, 'DRAFT');
  const draft = await makeDraft(tsDraft.id, empDraft.id);
  const draftFragStart = new Date(today.getTime() + 8 * 3600000);
  const draftFragEnd = new Date(today.getTime() + 16 * 3600000); // 480 recorded minutes
  const draftShift = await prisma.clockShift.create({
    data: { employeeId: empDraft.id, checkInEventId: await makeClockEvent(empDraft.id, siteA.id, 'CHECK_IN', draftFragStart), checkOutEventId: await makeClockEvent(empDraft.id, siteA.id, 'CHECK_OUT', draftFragEnd), siteId: siteA.id, recordedStartAt: draftFragStart, recordedEndAt: draftFragEnd }
  });
  const draftFragment = await prisma.clockShiftFragment.create({
    data: { clockShiftId: draftShift.id, employeeId: empDraft.id, fragmentIndex: 0, payrollPeriodId: period.id, timesheetId: tsDraft.id, date: today, recordedStartAt: draftFragStart, recordedEndAt: draftFragEnd, siteId: siteA.id }
  });
  const draftDay = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: today, dayType: 'WORK' } });
  await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId: empDraft.id, date: today, siteId: siteA.id, sourceAssignmentId: asgDraft.id, plannedBreakMinutes: 0 } });
  // Reported = 450 minutes (30 min unpaid break subtracted from the 480 recorded) — diff test.
  const draftSegment = await prisma.timesheetDraftSegment.create({
    data: { draftDayId: draftDay.id, draftId: draft.id, employeeId: empDraft.id, date: today, startAt: draftFragStart, endAt: draftFragEnd, siteId: siteA.id, sourceAssignmentId: asgDraft.id, originClockShiftFragmentId: draftFragment.id }
  });
  await prisma.timesheetDraftBreakSegment.create({ data: { draftSegmentId: draftSegment.id, startAt: new Date(draftFragStart.getTime() + 4 * 3600000), endAt: new Date(draftFragStart.getTime() + 4.5 * 3600000), paid: false } });

  // ---- SUBMITTED_MANUAL + AWAITING_FOREMAN + REMOVED-fragment diff --------------------------
  const { emp: empSubmitted, asg: asgSubmitted } = await makeEmployee('SubmittedManual', siteA);
  const { ts: tsSubmitted, version: versionSubmitted } = await makeTimesheet(empSubmitted.id, 'SUBMITTED', 'MANUAL');
  await prisma.timesheetReviewScope.create({ data: { timesheetVersionId: versionSubmitted.id, scopeType: 'SITE', siteId: siteA.id, status: 'PENDING', contentHash: randomUUID() } });
  const sFragStart = new Date(today.getTime() + 8 * 3600000);
  const sFragEnd = new Date(today.getTime() + 12 * 3600000); // 240 recorded minutes, kept (has a WorkSegment)
  const sShift = await prisma.clockShift.create({
    data: { employeeId: empSubmitted.id, checkInEventId: await makeClockEvent(empSubmitted.id, siteA.id, 'CHECK_IN', sFragStart), checkOutEventId: await makeClockEvent(empSubmitted.id, siteA.id, 'CHECK_OUT', sFragEnd), siteId: siteA.id, recordedStartAt: sFragStart, recordedEndAt: sFragEnd }
  });
  const sFragKept = await prisma.clockShiftFragment.create({ data: { clockShiftId: sShift.id, employeeId: empSubmitted.id, fragmentIndex: 0, payrollPeriodId: period.id, timesheetId: tsSubmitted.id, date: today, recordedStartAt: sFragStart, recordedEndAt: sFragEnd, siteId: siteA.id } });
  const tsDay = await prisma.timesheetDay.create({ data: { timesheetVersionId: versionSubmitted.id, date: today, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetPlannedShift.create({ data: { timesheetVersionId: versionSubmitted.id, employeeId: empSubmitted.id, date: today, siteId: siteA.id, sourceAssignmentId: asgSubmitted.id, plannedBreakMinutes: 0 } });
  await prisma.workSegment.create({ data: { timesheetDayId: tsDay.id, timesheetVersionId: versionSubmitted.id, employeeId: empSubmitted.id, date: today, startAt: sFragStart, endAt: sFragEnd, siteId: siteA.id, sourceAssignmentId: asgSubmitted.id, crossesMidnight: false, originClockShiftFragmentId: sFragKept.id } });
  // A second fragment, later REMOVED (adjustment) — no WorkSegment for it → visible negative delta.
  const rFragStart = new Date(today.getTime() + 13 * 3600000);
  const rFragEnd = new Date(today.getTime() + 14 * 3600000); // 60 recorded minutes, fully removed
  const rShift = await prisma.clockShift.create({
    data: { employeeId: empSubmitted.id, checkInEventId: await makeClockEvent(empSubmitted.id, siteA.id, 'CHECK_IN', rFragStart), checkOutEventId: await makeClockEvent(empSubmitted.id, siteA.id, 'CHECK_OUT', rFragEnd), siteId: siteA.id, recordedStartAt: rFragStart, recordedEndAt: rFragEnd }
  });
  const rFragRemoved = await prisma.clockShiftFragment.create({ data: { clockShiftId: rShift.id, employeeId: empSubmitted.id, fragmentIndex: 0, payrollPeriodId: period.id, timesheetId: tsSubmitted.id, date: today, recordedStartAt: rFragStart, recordedEndAt: rFragEnd, siteId: siteA.id } });
  await prisma.clockShiftAdjustment.create({
    data: { clockShiftFragmentId: rFragRemoved.id, clockShiftId: rShift.id, employeeId: empSubmitted.id, changeType: 'REMOVED', changedByUserId: admin1.id, beforeStartAt: rFragStart, beforeEndAt: rFragEnd, reason: 'test fixture: removed fragment', requestId: randomUUID() }
  });
  // recordedMinutes = 240+60 = 300; reportedMinutes = 240 (no breaks); deltaMinutes = -60.

  // ---- SUBMITTED_AUTO + AUTO_SUBMITTED_WITH_EXCEPTIONS ---------------------------------------
  const { emp: empAuto } = await makeEmployee('SubmittedAuto', siteA);
  const { ts: tsAuto } = await makeTimesheet(empAuto.id, 'SUBMITTED', 'AUTO');
  await prisma.attendanceException.create({ data: { type: 'MISSING_CHECKOUT_AT_CUTOFF', employeeId: empAuto.id, payrollPeriodId: period.id, timesheetId: tsAuto.id, occurredAt: new Date(), status: 'OPEN' } });

  // ---- RETURNED --------------------------------------------------------------------------------
  const { emp: empReturned } = await makeEmployee('Returned', siteA);
  const { ts: tsReturned } = await makeTimesheet(empReturned.id, 'RETURNED');
  await makeDraft(tsReturned.id, empReturned.id);

  // ---- READY_FOR_FINAL_APPROVAL (FOREMAN_APPROVED) ----------------------------------------------
  const { emp: empForemanApproved } = await makeEmployee('ForemanApproved', siteA);
  await makeTimesheet(empForemanApproved.id, 'FOREMAN_APPROVED');

  // ---- FINAL_APPROVED --------------------------------------------------------------------------
  const { emp: empFinalApproved } = await makeEmployee('FinalApproved', siteA);
  await makeTimesheet(empFinalApproved.id, 'FINAL_APPROVED');

  // ---- CORRECTION_OPEN -------------------------------------------------------------------------
  const { emp: empCorrection } = await makeEmployee('CorrectionOpen', siteA);
  const { ts: tsCorrection } = await makeTimesheet(empCorrection.id, 'FINAL_APPROVED');
  await prisma.correctionRequest.create({ data: { timesheetId: tsCorrection.id, requestedByUserId: admin1.id, reason: 'test fixture', status: 'PENDING' } });

  // ---- LATE_SYNC_AFTER_SUBMIT isolation (must NOT inflate a SUBMITTED version's recordedMinutes)
  const { emp: empLateSync, asg: asgLateSync } = await makeEmployee('LateSync', siteA);
  const { ts: tsLateSync, version: versionLateSync } = await makeTimesheet(empLateSync.id, 'SUBMITTED', 'MANUAL');
  const lsFragStart = new Date(today.getTime() + 8 * 3600000);
  const lsFragEnd = new Date(today.getTime() + 12 * 3600000);
  const lsShift = await prisma.clockShift.create({
    data: { employeeId: empLateSync.id, checkInEventId: await makeClockEvent(empLateSync.id, siteA.id, 'CHECK_IN', lsFragStart), checkOutEventId: await makeClockEvent(empLateSync.id, siteA.id, 'CHECK_OUT', lsFragEnd), siteId: siteA.id, recordedStartAt: lsFragStart, recordedEndAt: lsFragEnd }
  });
  const lsFragKept = await prisma.clockShiftFragment.create({ data: { clockShiftId: lsShift.id, employeeId: empLateSync.id, fragmentIndex: 0, payrollPeriodId: period.id, timesheetId: tsLateSync.id, date: today, recordedStartAt: lsFragStart, recordedEndAt: lsFragEnd, siteId: siteA.id } });
  const lsDay = await prisma.timesheetDay.create({ data: { timesheetVersionId: versionLateSync.id, date: today, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetPlannedShift.create({ data: { timesheetVersionId: versionLateSync.id, employeeId: empLateSync.id, date: today, siteId: siteA.id, sourceAssignmentId: asgLateSync.id, plannedBreakMinutes: 0 } });
  await prisma.workSegment.create({ data: { timesheetDayId: lsDay.id, timesheetVersionId: versionLateSync.id, employeeId: empLateSync.id, date: today, startAt: lsFragStart, endAt: lsFragEnd, siteId: siteA.id, sourceAssignmentId: asgLateSync.id, crossesMidnight: false, originClockShiftFragmentId: lsFragKept.id } });
  // Late-arriving fragment, same timesheetId, NOT yet in any WorkSegment — flagged OPEN.
  const lateFragStart = new Date(today.getTime() + 18 * 3600000);
  const lateFragEnd = new Date(today.getTime() + 20 * 3600000); // 120 minutes that must NOT show up in this version's recordedMinutes
  const lateShift = await prisma.clockShift.create({
    data: { employeeId: empLateSync.id, checkInEventId: await makeClockEvent(empLateSync.id, siteA.id, 'CHECK_IN', lateFragStart), checkOutEventId: await makeClockEvent(empLateSync.id, siteA.id, 'CHECK_OUT', lateFragEnd), siteId: siteA.id, recordedStartAt: lateFragStart, recordedEndAt: lateFragEnd }
  });
  const lateFragment = await prisma.clockShiftFragment.create({ data: { clockShiftId: lateShift.id, employeeId: empLateSync.id, fragmentIndex: 0, payrollPeriodId: period.id, timesheetId: tsLateSync.id, date: today, recordedStartAt: lateFragStart, recordedEndAt: lateFragEnd, siteId: siteA.id } });
  await prisma.attendanceException.create({ data: { type: 'LATE_SYNC_AFTER_SUBMIT', employeeId: empLateSync.id, payrollPeriodId: period.id, timesheetId: tsLateSync.id, clockShiftFragmentId: lateFragment.id, occurredAt: lateFragEnd, status: 'OPEN' } });
  // Expected: recordedMinutes=240 (late 120 excluded), reportedMinutes=240, deltaMinutes=0.

  // ---- Foreign site (must never appear for foreman1) --------------------------------------------
  const { emp: empForeignSite } = await makeEmployee('ForeignSite', siteB);

  // ---- Dual-role FOREMAN+WORKER self-exclusion --------------------------------------------------
  const dualEmp = await prisma.employee.create({ data: { employeeNumber: `TEST-OV-DUAL-${randomUUID().slice(0, 8)}`, firstName: 'Dual', lastName: 'Foreman' } });
  await prisma.employment.create({ data: { employeeId: dualEmp.id, active: true, startDate: assignmentStart } });
  await prisma.siteAssignment.create({ data: { employeeId: dualEmp.id, siteId: siteA.id, isPrimary: true, validFrom: assignmentStart, validTo: null, assignedByUserId: admin1.id } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: dualEmp.id, expected: true } });
  await prisma.user.update({ where: { id: foreman1.id }, data: { employeeId: dualEmp.id } });
  const { ts: tsDual, version: versionDual } = await makeTimesheet(dualEmp.id, 'SUBMITTED', 'MANUAL');
  await prisma.timesheetReviewScope.create({ data: { timesheetVersionId: versionDual.id, scopeType: 'SITE', siteId: siteA.id, status: 'PENDING', contentHash: randomUUID() } });
  void tsDual;

  // ---- Conflicts section (ADMIN-only) -----------------------------------------------------------
  const conflictEmp = empGpsIssue;
  await prisma.clockEventIdConflict.create({
    data: { conflictType: 'CLIENT_EVENT_ID_REUSED', clientEventId: randomUUID(), employeeId: conflictEmp.id, sanitizedConflictingPayload: { note: 'test fixture' }, conflictingPayloadHash: createHash('sha256').update('x').digest('hex'), requestId: randomUUID() }
  });
  const installation = await prisma.workerDeviceInstallation.create({ data: { id: randomUUID(), employeeId: conflictEmp.id, lastSeenAt: new Date() } });
  await prisma.deviceEventReceipt.create({
    data: { deviceInstallationId: installation.id, employeeId: conflictEmp.id, deviceSequence: BigInt(1), clientEventId: randomUUID(), outcome: 'REJECTED_TERMINAL', rejectionCode: 'VALIDATION_ERROR', payloadHash: createHash('sha256').update('y').digest('hex') }
  });
  await prisma.auditEvent.create({
    data: { eventType: 'FIFO_LEDGER_INCONSISTENT', entityType: 'WORKER_DEVICE_INSTALLATION', entityId: installation.id, requestId: randomUUID(), beforeValue: { lastProcessedSequence: '1', missingReceiptForSequence: '2' } }
  });

  console.log(
    JSON.stringify(
      {
        admin1Token,
        superadminToken,
        workerToken,
        foreman1Token,
        foreman2Token,
        periodId: period.id,
        siteAId: siteA.id,
        siteBId: siteB.id,
        empWorkingNowId: empWorkingNow.id,
        empFinishedTodayId: empFinishedToday.id,
        empMissingCheckoutId: empMissingCheckout.id,
        empGpsIssueId: empGpsIssue.id,
        empSyncIssueId: empSyncIssue.id,
        empDraftId: empDraft.id,
        empSubmittedId: empSubmitted.id,
        empAutoId: empAuto.id,
        empReturnedId: empReturned.id,
        empForemanApprovedId: empForemanApproved.id,
        empFinalApprovedId: empFinalApproved.id,
        empCorrectionId: empCorrection.id,
        empLateSyncId: empLateSync.id,
        empForeignSiteId: empForeignSite.id,
        dualEmpId: dualEmp.id
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
