'use client';

// R09.7 — the tappable "who / where / connection / sync / GPS / zone" status card, extracted
// verbatim from WorkerClockPanel.tsx. Pure presentational — no hooks, no behaviour change.
import type { WorkerStrings } from '@/lib/i18n/worker';
import type { GpsUiState, ZoneStatus } from './format';

interface WorkerStatusCardProps {
  workerName: string | null;
  todayLabel: string;
  currentHelsinki: string;
  activeSiteName: string | null;
  activeWorkAreaName: string | null;
  isOnline: boolean;
  pendingCount: number;
  syncSummary: string;
  gpsStatus: GpsUiState;
  gpsSummary: string;
  showZoneStatus: boolean;
  zoneStatus: ZoneStatus;
  zoneSummary: string;
  t: WorkerStrings;
  onOpen: () => void;
}

export function WorkerStatusCard({
  workerName,
  todayLabel,
  currentHelsinki,
  activeSiteName,
  activeWorkAreaName,
  isOnline,
  pendingCount,
  syncSummary,
  gpsStatus,
  gpsSummary,
  showZoneStatus,
  zoneStatus,
  zoneSummary,
  t,
  onOpen
}: WorkerStatusCardProps) {
  return (
    <button type="button" className="wk-status-card" onClick={onOpen}>
      <div className="wk-status-card-head">
        <div>
          <p className="wk-status-card-name">{workerName ?? t.worker}</p>
          <p className="wk-status-card-date">{todayLabel}</p>
        </div>
        <div className="wk-status-card-time">{currentHelsinki}</div>
      </div>

      <div className="wk-status-workplace">
        <span className="wk-status-label">{t.workplaceLabel}</span>
        {activeSiteName ? <p className="wk-status-site">{activeSiteName}</p> : <p className="wk-status-site">{t.noWorkplaceAssigned}</p>}
        {activeWorkAreaName ? <p className="wk-status-workarea">{activeWorkAreaName}</p> : null}
      </div>

      <div className="wk-status-grid" role="status" aria-live="polite">
        <p>
          <span className={`wk-status-dot ${isOnline ? 'online' : 'offline'}`} aria-hidden="true" />
          <span>{t.statusInternet}</span>
          <strong>{isOnline ? t.online : t.offline}</strong>
        </p>
        <p>
          <span className={`wk-status-dot ${pendingCount > 0 ? 'amber' : 'online'}`} aria-hidden="true" />
          <span>{t.statusSync}</span>
          <strong>{syncSummary}</strong>
        </p>
        <p>
          <span className={`wk-status-dot ${gpsStatus === 'READY' ? 'online' : gpsStatus === 'CHECKING' ? 'amber' : gpsStatus === 'IDLE' ? 'offline' : 'warn'}`} aria-hidden="true" />
          <span>{t.statusGps}</span>
          <strong>{gpsSummary}</strong>
        </p>
        {showZoneStatus && (
          <p>
            <span className={`wk-status-dot ${zoneStatus === 'INSIDE' ? 'online' : zoneStatus === 'OUTSIDE' ? 'warn' : zoneStatus === 'CHECKING' ? 'amber' : 'offline'}`} aria-hidden="true" />
            <span>{t.statusZone}</span>
            <strong>{zoneSummary}</strong>
          </p>
        )}
      </div>
    </button>
  );
}
