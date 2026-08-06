import type { ReturnReasonView } from '@/lib/worker-timesheets';

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.7 — a version can carry more than one RETURNED scope
// (two sites returned almost simultaneously); this always renders every reason, never just one.
// Plain Server Component — reasons are rendered as ordinary JSX text children (React escapes
// them automatically), never via dangerouslySetInnerHTML.
function scopeLabel(reason: ReturnReasonView): string {
  if (reason.scopeType === 'SITE') {
    return reason.siteName ?? 'Unknown site';
  }
  return reason.contextSiteName ? `General / non-site (${reason.contextSiteName})` : 'General / non-site';
}

function formatReturnedAt(returnedAt: string | null): string | null {
  if (!returnedAt) {
    return null;
  }
  return new Date(returnedAt).toLocaleString();
}

export function ReturnReasonsNotice({ status, reasons }: { status: string; reasons: ReturnReasonView[] }) {
  if (status !== 'RETURNED') {
    return null;
  }

  return (
    <div className="wk-return-notice" role="alert">
      <h2 className="wk-return-notice-title">Returned for correction</h2>
      {reasons.length === 0 ? (
        <p className="wk-empty">
          This timesheet was returned, but the reason could not be loaded. Contact your admin if this persists.
        </p>
      ) : (
        <ul className="wk-return-reason-list">
          {reasons.map((reason, index) => (
            <li key={index} className="wk-return-reason-item">
              <span className="wk-return-reason-scope">{scopeLabel(reason)}</span>
              <p className="wk-return-reason-text">{reason.reason}</p>
              {formatReturnedAt(reason.returnedAt) ? (
                <span className="wk-return-reason-time">Returned {formatReturnedAt(reason.returnedAt)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
