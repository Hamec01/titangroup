'use client';

import type { ReturnReasonView } from '@/lib/worker-timesheets';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { COMMON_STRINGS } from '@/lib/i18n/common';

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.7 — a version can carry more than one RETURNED scope
// (two sites returned almost simultaneously); this always renders every reason, never just one.
// Plain Server Component — reasons are rendered as ordinary JSX text children (React escapes
// them automatically), never via dangerouslySetInnerHTML.
function scopeLabel(reason: ReturnReasonView, unknownSite: string, general: string): string {
  if (reason.scopeType === 'SITE') {
    return reason.siteName ?? unknownSite;
  }
  return reason.contextSiteName ? `${general} (${reason.contextSiteName})` : general;
}

function formatReturnedAt(returnedAt: string | null): string | null {
  if (!returnedAt) {
    return null;
  }
  return new Date(returnedAt).toLocaleString();
}

export function ReturnReasonsNotice({ status, reasons }: { status: string; reasons: ReturnReasonView[] }) {
  const t = COMMON_STRINGS[useAppLocale()];
  if (status !== 'RETURNED') {
    return null;
  }

  return (
    <div className="wk-return-notice" role="alert">
      <h2 className="wk-return-notice-title">{t.returnedForCorrectionTitle}</h2>
      {reasons.length === 0 ? (
        <p className="wk-empty">
          {t.returnedReasonUnavailable}
        </p>
      ) : (
        <ul className="wk-return-reason-list">
          {reasons.map((reason, index) => (
            <li key={index} className="wk-return-reason-item">
              <span className="wk-return-reason-scope">{scopeLabel(reason, t.unknownSite, t.generalNonSite)}</span>
              <p className="wk-return-reason-text">{reason.reason}</p>
              {formatReturnedAt(reason.returnedAt) ? (
                <span className="wk-return-reason-time">{t.returnedAtPrefix} {formatReturnedAt(reason.returnedAt)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
