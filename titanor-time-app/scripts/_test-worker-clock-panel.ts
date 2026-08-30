// R09.7 — WorkerClockPanel was split into ./app/worker/clock-panel/* (pure extraction, zero
// behaviour change). This locks that down: the extracted formatters keep their exact output, and
// every extracted presentational piece still renders its key affordances (and the overlays still
// render nothing while closed). unit lane — SSR only, no DB, no browser.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  assignmentKey,
  formatDuration,
  formatHelsinkiTime,
  outboxGpsFields,
  resolveGpsUiState
} from '../app/worker/clock-panel/format';
import { GpsNotices } from '../app/worker/clock-panel/GpsNotices';
import { WorkerStatusCard } from '../app/worker/clock-panel/WorkerStatusCard';
import { MainClockAction } from '../app/worker/clock-panel/MainClockAction';
import { TimeCardPreview } from '../app/worker/clock-panel/TimeCardPreview';
import { AssignmentSheet, SwitchSitePanel, WorkStatusSheet, OutsideZoneModal } from '../app/worker/clock-panel/ClockOverlays';
import { WORKER_STRINGS } from '../lib/i18n/worker';
import type { GpsSnapshot } from '../lib/worker-gps';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

const t = WORKER_STRINGS.EN;

// ---- format.ts — pure helpers keep their exact output ----------------------------------------
check('formatDuration 0', formatDuration(0) === '00:00:00');
check('formatDuration 1h01m01s', formatDuration(3_661_000) === '01:01:01');
check('formatDuration 90s', formatDuration(90_000) === '00:01:30');
check('formatDuration 100h+', formatDuration(100 * 3_600_000 + 5_000) === '100:00:05');

check('formatHelsinkiTime winter (UTC+2)', formatHelsinkiTime('2026-01-15T09:00:00Z') === '11:00', formatHelsinkiTime('2026-01-15T09:00:00Z'));
check('formatHelsinkiTime summer (UTC+3)', formatHelsinkiTime('2026-06-15T09:00:00Z') === '12:00', formatHelsinkiTime('2026-06-15T09:00:00Z'));

check('assignmentKey no work area', assignmentKey('site-1', null) === 'site-1::');
check('assignmentKey with work area', assignmentKey('site-1', 'wa-9') === 'site-1::wa-9');

const freshFix: GpsSnapshot = { location: { latitude: 60, longitude: 24, accuracyMeters: 12 }, approximate: false, gpsUnavailableReason: null, fixAgeSeconds: 1 };
const approxFix: GpsSnapshot = { location: { latitude: 60, longitude: 24, accuracyMeters: 400 }, approximate: true, gpsUnavailableReason: null, fixAgeSeconds: 120 };
const noFix: GpsSnapshot = { location: null, approximate: false, gpsUnavailableReason: 'PERMISSION_DENIED', fixAgeSeconds: null };

{
  const f = outboxGpsFields(freshFix);
  check('outboxGpsFields fresh → gps set, no approx', f.gps !== null && f.gpsApproximate === null && f.gpsUnavailableReason === null, f);
}
{
  const f = outboxGpsFields(approxFix);
  check('outboxGpsFields approx → gpsApproximate set, gps null', f.gps === null && f.gpsApproximate !== null, f);
  check('outboxGpsFields approx → reason defaults to POSITION_UNAVAILABLE', f.gpsUnavailableReason === 'POSITION_UNAVAILABLE', f);
}
{
  const f = outboxGpsFields(noFix);
  check('outboxGpsFields no fix → only the reason', f.gps === null && f.gpsApproximate === null && f.gpsUnavailableReason === 'PERMISSION_DENIED', f);
}

check('resolveGpsUiState fresh → READY', resolveGpsUiState(freshFix) === 'READY');
check('resolveGpsUiState approx (has location) → READY', resolveGpsUiState(approxFix) === 'READY');
check('resolveGpsUiState denied → PERMISSION', resolveGpsUiState(noFix) === 'PERMISSION');
check('resolveGpsUiState unavailable → UNAVAILABLE', resolveGpsUiState({ location: null, approximate: false, gpsUnavailableReason: 'POSITION_UNAVAILABLE', fixAgeSeconds: null }) === 'UNAVAILABLE');

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

// ---- GpsNotices ----------------------------------------------------------------------------
check('GpsNotices idle renders nothing', html(createElement(GpsNotices, { gpsPermission: 'granted', gpsWaitSecondsLeft: null, t, onGrant: () => {}, onSkipWait: () => {} })) === '');
{
  const h = html(createElement(GpsNotices, { gpsPermission: 'prompt', gpsWaitSecondsLeft: null, t, onGrant: () => {}, onSkipWait: () => {} }));
  check('GpsNotices prompt shows the grant button', h.includes(t.gpsGrantButton) && h.includes('wk-action-button'), h);
}
{
  const h = html(createElement(GpsNotices, { gpsPermission: 'denied', gpsWaitSecondsLeft: null, t, onGrant: () => {}, onSkipWait: () => {} }));
  check('GpsNotices denied is an alert with the blocked title', h.includes('role="alert"') && h.includes(t.gpsDeniedTitle), h);
}
{
  const h = html(createElement(GpsNotices, { gpsPermission: 'granted', gpsWaitSecondsLeft: 7, t, onGrant: () => {}, onSkipWait: () => {} }));
  check('GpsNotices wait countdown shows the proceed button', h.includes(t.gpsWaitProceed) && h.includes('aria-live="polite"'), h);
}

// ---- WorkerStatusCard ---------------------------------------------------------------------
{
  const h = html(createElement(WorkerStatusCard, {
    workerName: 'Matti', todayLabel: 'Mon 15 Jun', currentHelsinki: '12:00', activeSiteName: 'Harbour Site', activeWorkAreaName: 'Hull 3',
    isOnline: true, pendingCount: 2, syncSummary: '2 waiting', gpsStatus: 'READY', gpsSummary: 'Ready',
    showZoneStatus: true, zoneStatus: 'INSIDE', zoneSummary: 'In the zone', t, onOpen: () => {}
  }));
  check('WorkerStatusCard is a button', h.startsWith('<button type="button" class="wk-status-card"'), h.slice(0, 60));
  check('WorkerStatusCard shows name / time / site / work area', ['Matti', '12:00', 'Harbour Site', 'Hull 3'].every((s) => h.includes(s)), h);
  check('WorkerStatusCard shows all four status rows', h.includes(t.statusInternet) && h.includes(t.statusSync) && h.includes(t.statusGps) && h.includes(t.statusZone), h);
  check('WorkerStatusCard amber sync dot while pending', h.includes('wk-status-dot amber'), h);
}
{
  const h = html(createElement(WorkerStatusCard, {
    workerName: null, todayLabel: 'Mon', currentHelsinki: '08:00', activeSiteName: null, activeWorkAreaName: null,
    isOnline: false, pendingCount: 0, syncSummary: 'Synced', gpsStatus: 'IDLE', gpsSummary: 'Will check',
    showZoneStatus: false, zoneStatus: 'UNKNOWN', zoneSummary: '', t, onOpen: () => {}
  }));
  check('WorkerStatusCard falls back to the generic worker label', h.includes(t.worker), h);
  check('WorkerStatusCard "no workplace" copy when unassigned', h.includes(t.noWorkplaceAssigned), h);
  check('WorkerStatusCard hides the zone row when showZoneStatus is false', !h.includes(t.statusZone), h);
  check('WorkerStatusCard offline dot', h.includes('wk-status-dot offline'), h);
}

// ---- MainClockAction --------------------------------------------------------------------
{
  const h = html(createElement(MainClockAction, {
    isClockedIn: false, openedAt: null, durationMs: 0, actionLabel: 'CHECK IN', actionHint: 'Start work', actionHelper: 'GPS is checked when you press',
    disabled: false, onClick: () => {}, t
  }));
  check('MainClockAction clocked-out: "in" wrap + button', h.includes('wk-main-action-wrap out') && h.includes('wk-main-action in'), h);
  check('MainClockAction clocked-out: no elapsed timer', !h.includes('wk-main-action-timer'), h);
  check('MainClockAction clocked-out aria-label = Check in', h.includes(`aria-label="${t.checkIn}"`), h);
  check('MainClockAction shows label / hint / helper', h.includes('CHECK IN') && h.includes('Start work') && h.includes('GPS is checked when you press'), h);
}
{
  const h = html(createElement(MainClockAction, {
    isClockedIn: true, openedAt: '2026-06-15T09:00:00Z', durationMs: 3_661_000, actionLabel: 'CHECK OUT', actionHint: 'End work', actionHelper: 'helper',
    disabled: true, onClick: () => {}, t
  }));
  check('MainClockAction clocked-in shows the elapsed timer', h.includes('wk-main-action-timer') && h.includes('01:01:01'), h);
  check('MainClockAction clocked-in shows the "since" line', h.includes('wk-main-action-since') && h.includes('12:00'), h);
  check('MainClockAction clocked-in aria-label = Check out', h.includes(`aria-label="${t.checkOut}"`), h);
  check('MainClockAction honours disabled', h.includes('disabled'), h);
}

// ---- TimeCardPreview -------------------------------------------------------------------
{
  const h = html(createElement(TimeCardPreview, {
    displayWeekActivity: { totalMinutes: 130, days: [
      { date: '2026-06-15', label: 'Mon', totalMinutes: 70, isToday: true, href: '/worker/periods/p/hours/2026-06-15' },
      { date: '2026-06-16', label: 'Tue', totalMinutes: 0, isToday: false, href: null }
    ] },
    timeCardHref: '/worker/periods/p/hours', locale: 'EN', t
  }));
  check('TimeCardPreview renders the section + heading', h.includes('wk-time-preview') && h.includes(t.timeCardTitle), h);
  check('TimeCardPreview deep link when timeCardHref set', h.includes('href="/worker/periods/p/hours"') && h.includes(t.viewAndEditHours), h);
  check('TimeCardPreview per-day grid: today flagged, dayless cell shows dash', h.includes('wk-week-day today') && h.includes('>—<'), h);
  check('TimeCardPreview links only the days that have an href', h.includes('href="/worker/periods/p/hours/2026-06-15"'), h);
}
{
  const h = html(createElement(TimeCardPreview, { displayWeekActivity: null, timeCardHref: null, locale: 'EN', t }));
  check('TimeCardPreview empty state when no activity', h.includes(t.noCompletedTimeEntries), h);
  check('TimeCardPreview no deep link when timeCardHref null', !h.includes(t.viewAndEditHours), h);
}

// ---- overlays: render nothing while closed, key affordances while open ----------------
const A = { id: 'a1', siteId: 's1', siteName: 'Site One', workAreaId: null, workAreaName: null, isPrimary: true } as const;
const B = { id: 'a2', siteId: 's2', siteName: 'Site Two', workAreaId: 'w2', workAreaName: 'Deck', isPrimary: false } as const;

check('AssignmentSheet closed → empty', html(createElement(AssignmentSheet, { open: false, assignments: [A], selectedAssignmentId: 'a1', busy: false, t, onSelect: () => {}, onClose: () => {} })) === '');
check('SwitchSitePanel closed → empty', html(createElement(SwitchSitePanel, { open: false, projectedSiteName: 'Site One', alternateAssignments: [B], switchTargetId: 'a2', switchTarget: B, busy: false, t, onSelectTarget: () => {}, onConfirm: () => {}, onClose: () => {} })) === '');
check('WorkStatusSheet closed → empty', html(createElement(WorkStatusSheet, { open: false, workerName: 'M', todayLabel: 'Mon', currentHelsinki: '12:00', isClockedIn: false, openedAt: null, durationMs: 0, activeSiteName: null, activeWorkAreaName: null, isOnline: true, syncSummary: 'Synced', pendingCount: 0, gpsSummary: 'Ready', showZoneStatus: false, zoneSummary: '', syncing: false, setupNotReady: false, t, onManualSync: () => {}, onClose: () => {} })) === '');
check('OutsideZoneModal no prompt → empty', html(createElement(OutsideZoneModal, { prompt: null, t, onAnswer: () => {} })) === '');

{
  const h = html(createElement(AssignmentSheet, { open: true, assignments: [A, B], selectedAssignmentId: 'a1', busy: false, t, onSelect: () => {}, onClose: () => {} }));
  check('AssignmentSheet open: dialog + both sites + primary suffix', h.includes('role="dialog"') && h.includes('Site One') && h.includes('Site Two') && h.includes(t.primarySuffix.trim() || t.primarySuffix), h);
  check('AssignmentSheet open: selected radio is checked', /value="a1"[^>]*checked/.test(h) || /checked[^>]*value="a1"/.test(h), h);
  check('AssignmentSheet open: work-area detail shown for B', h.includes('Deck'), h);
}
{
  const h = html(createElement(SwitchSitePanel, { open: true, projectedSiteName: 'Site One', alternateAssignments: [B], switchTargetId: 'a2', switchTarget: B, busy: false, t, onSelectTarget: () => {}, onConfirm: () => {}, onClose: () => {} }));
  check('SwitchSitePanel open: shows current workplace + confirm/cancel', h.includes('Site One') && h.includes(t.confirmSwitch) && h.includes(t.cancel), h);
  check('SwitchSitePanel confirm disabled when no target', html(createElement(SwitchSitePanel, { open: true, projectedSiteName: 'Site One', alternateAssignments: [B], switchTargetId: null, switchTarget: undefined, busy: false, t, onSelectTarget: () => {}, onConfirm: () => {}, onClose: () => {} })).includes('disabled'), '');
}
{
  const h = html(createElement(WorkStatusSheet, { open: true, workerName: 'Matti', todayLabel: 'Mon', currentHelsinki: '12:00', isClockedIn: true, openedAt: '2026-06-15T09:00:00Z', durationMs: 3_661_000, activeSiteName: 'Site One', activeWorkAreaName: 'Deck', isOnline: true, syncSummary: 'Synced', pendingCount: 3, gpsSummary: 'Ready', showZoneStatus: true, zoneSummary: 'Inside', syncing: false, setupNotReady: false, t, onManualSync: () => {}, onClose: () => {} }));
  check('WorkStatusSheet open: started-at + elapsed + sync-now button', h.includes(formatHelsinkiTime('2026-06-15T09:00:00Z')) && h.includes('01:01:01') && h.includes(t.syncNow), h);
  check('WorkStatusSheet open: pending count line', h.includes(`${t.statusPendingActions}: 3`), h);
}
{
  const h = html(createElement(OutsideZoneModal, { prompt: { siteName: 'Harbour Site' }, t, onAnswer: () => {} }));
  check('OutsideZoneModal: alertdialog, names the site, both choices, non-dismissible backdrop', h.includes('role="alertdialog"') && h.includes('Harbour Site') && h.includes(t.outsideZoneProceed) && h.includes(t.outsideZoneCancel), h);
  check('OutsideZoneModal backdrop has no onClick handler wired (SSR: bare div)', h.includes('<div class="wk-overlay-backdrop" aria-hidden="true"></div>'), h);
}

console.log(`\nPASS: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
