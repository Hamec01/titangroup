'use client';

import { useRef, useState } from 'react';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { LedgerIssue, WeeklyCustomerSliceRow } from '@/lib/reporting/time-ledger';
import {
  confirmWeekButtonLabel,
  approveLoadingLabel,
  approveCommittingLabel,
  approveStaleLabel,
  approveRefreshButtonLabel,
  approveWarningIntroLabel,
  approveWarningConfirmButtonLabel,
  approveErrorLabel,
  approveRetryButtonLabel,
  approveBlockedIntroLabel,
  approveSuccessLabel,
  issueLabel
} from '@/lib/reporting/ledger-ui-text';

interface PreviewItemKey {
  timesheetId: string;
  siteId: string;
  workAreaId: string | null;
  weekStart: string;
  employeeId: string;
}

interface PreviewResponse {
  itemKey: PreviewItemKey;
  currentFingerprint: string;
  matchesExpectedFingerprint: boolean;
  warnings: LedgerIssue[];
  blockers: LedgerIssue[];
  eligibility: { canApprove: boolean };
  confirmationToken?: string;
}

interface CommitResponse {
  result: 'APPROVED' | 'ALREADY_APPROVED';
}

interface ApiErrorEnvelope {
  error: { code: string; message: string };
}

type Phase = 'idle' | 'loading' | 'confirmWarning' | 'committing' | 'stale' | 'blocked' | 'error' | 'success';

// UT5-B — the single-row "Подтвердить эту неделю" action. Clean case is genuinely one user click:
// preview fires, and if it comes back clean (no warnings/blockers, fingerprint still matches),
// commit fires automatically with the token preview just returned — two network round-trips, one
// user gesture. A warning case adds exactly one more explicit click ("Всё равно подтвердить"),
// never a full modal. The row is never updated optimistically — onApproved() triggers the SAME real
// ledger refetch the rest of the page already uses, and this component's own success/error text is
// only ever driven by what the server actually returned.
export function ApproveWeekAction({ locale, row, onApproved }: { locale: AppLocale; row: WeeklyCustomerSliceRow; onApproved: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [blockers, setBlockers] = useState<LedgerIssue[]>([]);
  const [warnings, setWarnings] = useState<LedgerIssue[]>([]);
  const [successResult, setSuccessResult] = useState<'APPROVED' | 'ALREADY_APPROVED' | null>(null);
  const busyRef = useRef(false);
  const pendingCommitRef = useRef<{ itemKey: PreviewItemKey; expectedFingerprint: string; confirmationToken: string } | null>(null);
  // UT5-B-fixup #3 — one Idempotency-Key per commit ATTEMPT, not per commit CALL. A network error is
  // ambiguous (the server may or may not have actually processed the write), so retrying with a
  // fresh key would start a genuinely NEW operation server-side — at best a pointless extra
  // CUSTOMER_HOURS_APPROVAL_RECONFIRMED audit fact if the first call actually landed, at worst a
  // real duplicate attempt. The key (and the exact params it was issued for) are kept here and
  // reused by a same-attempt retry; they are cleared only when a genuinely NEW preview/intent
  // starts (startApprove(), Cancel) or when this attempt's token/fingerprint is provably dead
  // (stale, expired) and cannot be retried as-is.
  const idempotencyKeyRef = useRef<string | null>(null);
  const lastCommitParamsRef = useRef<{ itemKey: PreviewItemKey; expectedFingerprint: string; confirmationToken: string } | null>(null);
  const [errorSource, setErrorSource] = useState<'preview' | 'commit' | null>(null);

  async function fetchJson<T>(url: string, idempotencyKey: string | null, body: unknown): Promise<{ ok: true; body: T } | { ok: false; code: string; message: string }> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time' };
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(body) });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const envelope = json as ApiErrorEnvelope | null;
        return { ok: false, code: envelope?.error?.code ?? 'UNKNOWN', message: envelope?.error?.message ?? '' };
      }
      return { ok: true, body: json as T };
    } catch {
      return { ok: false, code: 'NETWORK_ERROR', message: '' };
    }
  }

  async function runCommit(itemKey: PreviewItemKey, expectedFingerprint: string, confirmationToken: string) {
    setPhase('committing');
    lastCommitParamsRef.current = { itemKey, expectedFingerprint, confirmationToken };
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = crypto.randomUUID();
    const result = await fetchJson<CommitResponse>('/api/admin/time-ledger/approvals', idempotencyKeyRef.current, {
      itemKey: { timesheetId: itemKey.timesheetId, siteId: itemKey.siteId, workAreaId: itemKey.workAreaId, weekStart: itemKey.weekStart },
      expectedFingerprint,
      confirmationToken
    });
    busyRef.current = false;
    if (!result.ok) {
      if (result.code === 'APPROVAL_SELECTION_STALE' || result.code === 'CONFIRMATION_TOKEN_EXPIRED') {
        // This exact attempt is dead (the underlying data moved on, or the token's own TTL passed)
        // — retrying with the SAME key/token can only ever fail the same way, so the next action is
        // a genuinely new preview, not a retry of this one.
        idempotencyKeyRef.current = null;
        lastCommitParamsRef.current = null;
        setPhase('stale');
        return;
      }
      if (result.code === 'NETWORK_ERROR') {
        // The ONLY genuinely ambiguous case — fetch() itself threw, so we cannot tell whether the
        // server ever received/processed this request. Deliberately KEEP the key and params so
        // "Try again" replays this exact same commit: if the server already completed it, the
        // Idempotency-Key + matching request hash gets a CACHED replay of the real result (no new
        // write, no extra audit event); if it never arrived, this is a genuine, safe retry.
        setErrorSource('commit');
        setPhase('error');
        return;
      }
      // UT5-B-fixup-2 — every other code is a REAL, deterministic HTTP response: the server received
      // this exact request, ran it to completion, and gave a definitive answer (a blocker like
      // SELF_APPROVAL_FORBIDDEN/OPEN_SHIFT, a token/idempotency conflict, a validation error, ...).
      // Retrying with the SAME key+body would only ever replay that IDENTICAL cached response
      // forever — never resolving anything. Clear the attempt; the next action is a fresh preview.
      idempotencyKeyRef.current = null;
      lastCommitParamsRef.current = null;
      setErrorSource('preview');
      setPhase('error');
      return;
    }
    idempotencyKeyRef.current = null;
    lastCommitParamsRef.current = null;
    setSuccessResult(result.body.result);
    setPhase('success');
    onApproved();
  }

  async function startApprove() {
    if (busyRef.current) return; // double-click guard — client-side convenience; the server's own
    // Idempotency-Key + row locks are the real guarantee (UT5-A-R1 §5).
    busyRef.current = true;
    setPhase('loading');
    setBlockers([]);
    setWarnings([]);
    setErrorSource(null);
    // A NEW preview means a genuinely new user intent (UT5-B-fixup #3) — any leftover key/params
    // from a previous, now-abandoned attempt must not leak into whatever commit follows this one.
    idempotencyKeyRef.current = null;
    lastCommitParamsRef.current = null;

    const result = await fetchJson<PreviewResponse>('/api/admin/time-ledger/approval-preview', null, {
      itemKey: { timesheetId: row.logicalKey.timesheetId, siteId: row.logicalKey.siteId, workAreaId: row.logicalKey.workAreaId, weekStart: row.logicalKey.weekStart },
      expectedFingerprint: row.currentFingerprint
    });

    if (!result.ok) {
      busyRef.current = false;
      setErrorSource('preview');
      setPhase('error');
      return;
    }
    const preview = result.body;

    if (!preview.matchesExpectedFingerprint) {
      busyRef.current = false;
      setPhase('stale');
      return;
    }
    if (preview.blockers.length > 0) {
      busyRef.current = false;
      setBlockers(preview.blockers);
      setPhase('blocked');
      return;
    }
    if (!preview.confirmationToken) {
      // Should not happen given matches+no-blockers, but never proceed to commit without a token.
      busyRef.current = false;
      setErrorSource('preview');
      setPhase('error');
      return;
    }
    if (preview.warnings.length > 0) {
      setWarnings(preview.warnings);
      // Stash what commit needs; committing happens on the explicit "Confirm anyway" click below.
      pendingCommitRef.current = { itemKey: preview.itemKey, expectedFingerprint: preview.currentFingerprint, confirmationToken: preview.confirmationToken };
      busyRef.current = false;
      setPhase('confirmWarning');
      return;
    }

    // Clean case — commit automatically, no second click.
    await runCommit(preview.itemKey, preview.currentFingerprint, preview.confirmationToken);
  }

  async function confirmDespiteWarnings() {
    if (busyRef.current || !pendingCommitRef.current) return;
    busyRef.current = true;
    const pending = pendingCommitRef.current;
    await runCommit(pending.itemKey, pending.expectedFingerprint, pending.confirmationToken);
  }

  function reset() {
    busyRef.current = false;
    idempotencyKeyRef.current = null;
    lastCommitParamsRef.current = null;
    setErrorSource(null);
    setPhase('idle');
    setBlockers([]);
    setWarnings([]);
  }

  // UT5-B-fixup #3 — "Try again" after a commit-phase NETWORK_ERROR retries the SAME commit (same
  // key, same itemKey/fingerprint/token). Every other case (preview failure, or a deterministic
  // commit-time HTTP rejection per UT5-B-fixup-2) has nothing safe to retry as-is, so it starts a
  // fresh preview instead — idempotencyKeyRef/lastCommitParamsRef were already cleared for those
  // cases at the point the error was recorded, so startApprove() begins a genuinely new attempt.
  function retryAfterError() {
    if (busyRef.current) return;
    if (errorSource === 'commit' && lastCommitParamsRef.current) {
      busyRef.current = true;
      const p = lastCommitParamsRef.current;
      void runCommit(p.itemKey, p.expectedFingerprint, p.confirmationToken);
    } else {
      void startApprove();
    }
  }

  // UT5-B-fixup-2 — "Обновить" after a stale preview/commit refreshes the row's real data AND resets
  // this component back to idle, so it never stays stuck showing "stale" once fresh data has
  // arrived; the user's next click is then a genuinely new preview against up-to-date numbers.
  function refreshAfterStale() {
    onApproved();
    reset();
  }

  if (row.approvalState === 'APPROVED' && phase === 'idle') {
    return null; // status is already visible via the row's own StatusBadge — no redundant button.
  }

  if (phase === 'success') {
    return (
      <p className="ledger-approve-success" role="status">
        {successResult ? approveSuccessLabel(locale, successResult) : ''}
      </p>
    );
  }

  if (phase === 'loading' || phase === 'committing') {
    return (
      <p className="ledger-approve-loading" role="status" aria-live="polite">
        {phase === 'loading' ? approveLoadingLabel(locale) : approveCommittingLabel(locale)}
      </p>
    );
  }

  if (phase === 'stale') {
    return (
      <div className="ledger-approve-stale" role="alert">
        <p>{approveStaleLabel(locale)}</p>
        <button type="button" className="ledger-retry-button" onClick={refreshAfterStale}>
          {approveRefreshButtonLabel(locale)}
        </button>
      </div>
    );
  }

  if (phase === 'blocked') {
    return (
      <div className="ledger-approve-blocked" role="alert">
        <p>{approveBlockedIntroLabel(locale)}</p>
        <ul>
          {blockers.map((b, i) => (
            <li key={i}>{issueLabel(b, locale)}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (phase === 'confirmWarning') {
    return (
      <div className="ledger-approve-warning-confirm" role="alert">
        <p>{approveWarningIntroLabel(locale)}</p>
        <ul>
          {warnings.map((w, i) => (
            <li key={i}>{issueLabel(w, locale)}</li>
          ))}
        </ul>
        <div className="ledger-approve-actions">
          <button type="button" className="ledger-approve-button" onClick={confirmDespiteWarnings}>
            {approveWarningConfirmButtonLabel(locale)}
          </button>
          <button type="button" className="ledger-link-button" onClick={reset}>
            {localeText(locale, 'Cancel', 'Отмена')}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="ledger-approve-error" role="alert">
        <p>{approveErrorLabel(locale)}</p>
        <button type="button" className="ledger-retry-button" onClick={retryAfterError}>
          {approveRetryButtonLabel(locale)}
        </button>
      </div>
    );
  }

  const disabled = row.blockers.length > 0;
  return (
    <button type="button" className="ledger-approve-button" disabled={disabled} onClick={startApprove}>
      {confirmWeekButtonLabel(locale)}
    </button>
  );
}
