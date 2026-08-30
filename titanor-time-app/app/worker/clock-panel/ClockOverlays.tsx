'use client';

// R09.7 — the four bottom-sheet / modal overlays of the clock screen, extracted verbatim from
// WorkerClockPanel.tsx: the "change workplace" assignment picker, the "switch workplace" panel, the
// work-status detail sheet, and the non-dismissible T17 "outside the zone" confirm. All pure
// presentational — the parent still owns every piece of state and every handler.
import type { WorkerStrings } from '@/lib/i18n/worker';
import { formatDuration, formatHelsinkiTime, type ClockPanelAssignment } from './format';

interface AssignmentSheetProps {
  open: boolean;
  assignments: ClockPanelAssignment[];
  selectedAssignmentId: string | null;
  busy: boolean;
  t: WorkerStrings;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function AssignmentSheet({ open, assignments, selectedAssignmentId, busy, t, onSelect, onClose }: AssignmentSheetProps) {
  if (!open) {
    return null;
  }
  return (
    <>
      <button type="button" className="wk-overlay-backdrop" aria-hidden="true" tabIndex={-1} onClick={onClose} />
      <div className="wk-overlay-sheet" role="dialog" aria-modal="true" aria-label={t.changeWorkplace}>
        <p className="wk-overlay-title">{t.changeWorkplace}</p>
        <div role="radiogroup" aria-label="Select site to check in" className="wk-assignment-options">
          {assignments.map((a) => (
            <label key={a.id} className={`wk-assignment-option${selectedAssignmentId === a.id ? ' selected' : ''}`}>
              <input type="radio" name="checkin-assignment" value={a.id} checked={selectedAssignmentId === a.id} onChange={() => onSelect(a.id)} disabled={busy} />
              <span className="wk-assignment-option-body">
                <span className="wk-assignment-site">
                  {a.siteName}
                  {a.isPrimary ? t.primarySuffix : ''}
                </span>
                {a.workAreaName && <span className="wk-assignment-detail">{a.workAreaName}</span>}
              </span>
            </label>
          ))}
        </div>
        <button type="button" className="wk-clock-cancel-button" onClick={onClose}>
          {t.close}
        </button>
      </div>
    </>
  );
}

interface SwitchSitePanelProps {
  open: boolean;
  projectedSiteName: string | null;
  alternateAssignments: ClockPanelAssignment[];
  switchTargetId: string | null;
  switchTarget: ClockPanelAssignment | undefined;
  busy: boolean;
  t: WorkerStrings;
  onSelectTarget: (id: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}

export function SwitchSitePanel({ open, projectedSiteName, alternateAssignments, switchTargetId, switchTarget, busy, t, onSelectTarget, onConfirm, onClose }: SwitchSitePanelProps) {
  if (!open) {
    return null;
  }
  return (
    <>
      <button type="button" className="wk-overlay-backdrop" aria-hidden="true" tabIndex={-1} onClick={onClose} />
      <div className="wk-overlay-sheet" role="dialog" aria-modal="true" aria-label={t.switchWorkplace}>
        <p className="wk-overlay-title">{t.switchWorkplace}</p>
        {projectedSiteName ? (
          <p className="wk-switch-summary">
            {t.currentWorkplacePrefix} {projectedSiteName}
          </p>
        ) : null}
        <div role="radiogroup" aria-label="Select new site" className="wk-assignment-options">
          {alternateAssignments.map((a) => (
            <label key={a.id} className={`wk-assignment-option${switchTargetId === a.id ? ' selected' : ''}`}>
              <input type="radio" name="switch-assignment" checked={switchTargetId === a.id} onChange={() => onSelectTarget(a.id)} disabled={busy} />
              <span className="wk-assignment-option-body">
                <span className="wk-assignment-site">{a.siteName}</span>
                {a.workAreaName && <span className="wk-assignment-detail">{a.workAreaName}</span>}
              </span>
            </label>
          ))}
        </div>
        {switchTarget ? <p className="wk-switch-summary">{t.switchFromTo(projectedSiteName ?? '', switchTarget.siteName)}</p> : null}
        <div className="wk-switch-actions">
          <button type="button" className="wk-clock-secondary-button" onClick={onConfirm} disabled={busy || !switchTargetId}>
            {t.confirmSwitch}
          </button>
          <button type="button" className="wk-clock-cancel-button" onClick={onClose} disabled={busy}>
            {t.cancel}
          </button>
        </div>
      </div>
    </>
  );
}

interface WorkStatusSheetProps {
  open: boolean;
  workerName: string | null;
  todayLabel: string;
  currentHelsinki: string;
  isClockedIn: boolean;
  openedAt: string | null;
  durationMs: number;
  activeSiteName: string | null;
  activeWorkAreaName: string | null;
  isOnline: boolean;
  syncSummary: string;
  pendingCount: number;
  gpsSummary: string;
  showZoneStatus: boolean;
  zoneSummary: string;
  syncing: boolean;
  setupNotReady: boolean;
  t: WorkerStrings;
  onManualSync: () => void;
  onClose: () => void;
}

export function WorkStatusSheet({
  open,
  workerName,
  todayLabel,
  currentHelsinki,
  isClockedIn,
  openedAt,
  durationMs,
  activeSiteName,
  activeWorkAreaName,
  isOnline,
  syncSummary,
  pendingCount,
  gpsSummary,
  showZoneStatus,
  zoneSummary,
  syncing,
  setupNotReady,
  t,
  onManualSync,
  onClose
}: WorkStatusSheetProps) {
  if (!open) {
    return null;
  }
  return (
    <>
      <button type="button" className="wk-overlay-backdrop" aria-hidden="true" tabIndex={-1} onClick={onClose} />
      <div className="wk-overlay-sheet wk-status-sheet" role="dialog" aria-modal="true" aria-label={t.workStatus}>
        <p className="wk-overlay-title">{t.workStatus}</p>
        <p className="wk-status-sheet-name">{workerName ?? t.worker}</p>
        <p className="wk-status-sheet-line">{todayLabel}</p>
        <p className="wk-status-sheet-line">{currentHelsinki} · Europe/Helsinki</p>
        <p className="wk-status-sheet-line">{t.clockStateLabel}: {isClockedIn ? t.clockedIn : t.clockedOut}</p>
        {openedAt ? <p className="wk-status-sheet-line">{t.startedAtLabel}: {formatHelsinkiTime(openedAt)}</p> : null}
        {isClockedIn && openedAt ? <p className="wk-status-sheet-line">{t.elapsedLabel}: {formatDuration(durationMs)}</p> : null}
        <p className="wk-status-sheet-line">{t.workplaceLabel}: {activeSiteName ?? t.noWorkplaceAssigned}</p>
        {activeWorkAreaName ? <p className="wk-status-sheet-line">{t.workAreaLabel}: {activeWorkAreaName}</p> : null}
        <p className="wk-status-sheet-line">{t.statusInternet}: {isOnline ? t.online : t.offline}</p>
        <p className="wk-status-sheet-line">{t.statusSync}: {syncSummary}</p>
        <p className="wk-status-sheet-line">{t.statusPendingActions}: {pendingCount}</p>
        <p className="wk-status-sheet-line">{t.statusGps}: {gpsSummary}</p>
        {showZoneStatus && <p className="wk-status-sheet-line">{t.statusZone}: {zoneSummary}</p>}
        <button type="button" className="wk-clock-secondary-button" onClick={onManualSync} disabled={syncing || setupNotReady}>
          {syncing ? t.syncing : t.syncNow}
        </button>
        <button type="button" className="wk-clock-cancel-button" onClick={onClose}>
          {t.close}
        </button>
      </div>
    </>
  );
}

interface OutsideZoneModalProps {
  prompt: { siteName: string } | null;
  t: WorkerStrings;
  onAnswer: (proceed: boolean) => void;
}

export function OutsideZoneModal({ prompt, t, onAnswer }: OutsideZoneModalProps) {
  if (!prompt) {
    return null;
  }
  return (
    <>
      {/* T17 — deliberately NOT dismissible: no backdrop onClick, no Escape, no ✕. One of the
          two buttons must be pressed. */}
      <div className="wk-overlay-backdrop" aria-hidden="true" />
      <div className="wk-overlay-sheet" role="alertdialog" aria-modal="true" aria-label={t.outsideZoneTitle}>
        <p className="wk-overlay-title">{t.outsideZoneTitle}</p>
        <p className="wk-return-reason-text">{t.outsideZoneBody(prompt.siteName)}</p>
        <div className="wk-switch-actions">
          <button type="button" className="wk-action-button" onClick={() => onAnswer(true)}>
            {t.outsideZoneProceed}
          </button>
          <button type="button" className="wk-clock-cancel-button" onClick={() => onAnswer(false)}>
            {t.outsideZoneCancel}
          </button>
        </div>
      </div>
    </>
  );
}
