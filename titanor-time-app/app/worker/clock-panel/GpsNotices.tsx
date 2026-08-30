'use client';

// R09.7 — the three GPS banners that sit above the status card, extracted verbatim from
// WorkerClockPanel.tsx. Pure presentational: every branch, class name and string is unchanged.
import type { GeolocationPermissionState } from '@/lib/worker-gps';
import type { WorkerStrings } from '@/lib/i18n/worker';

interface GpsNoticesProps {
  gpsPermission: GeolocationPermissionState | null;
  gpsWaitSecondsLeft: number | null;
  t: WorkerStrings;
  onGrant: () => void;
  onSkipWait: () => void;
}

export function GpsNotices({ gpsPermission, gpsWaitSecondsLeft, t, onGrant, onSkipWait }: GpsNoticesProps) {
  return (
    <>
      {gpsPermission === 'prompt' && (
        <div className="wk-return-notice" role="status">
          <h2 className="wk-return-notice-title">{t.gpsGrantTitle}</h2>
          <p className="wk-return-reason-text">{t.gpsGrantBody}</p>
          <button type="button" className="wk-action-button" onClick={onGrant}>
            {t.gpsGrantButton}
          </button>
        </div>
      )}
      {gpsPermission === 'denied' && (
        <div className="wk-return-notice" role="alert">
          <h2 className="wk-return-notice-title">{t.gpsDeniedTitle}</h2>
          <p className="wk-return-reason-text">{t.gpsDeniedBody}</p>
        </div>
      )}

      {gpsWaitSecondsLeft !== null && (
        <div className="wk-return-notice" role="status" aria-live="polite">
          <h2 className="wk-return-notice-title">{t.gpsWaitTitle}</h2>
          <p className="wk-return-reason-text">{t.gpsWaitBody(gpsWaitSecondsLeft)}</p>
          <button type="button" className="wk-clock-secondary-button" onClick={onSkipWait}>
            {t.gpsWaitProceed}
          </button>
        </div>
      )}
    </>
  );
}
