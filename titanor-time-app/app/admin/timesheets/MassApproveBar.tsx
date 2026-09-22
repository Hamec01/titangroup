'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import {
  massSelectedCountLabel,
  massClearSelectionLabel,
  massConfirmSelectedLabel,
  massPreviewLoadingLabel,
  massCommittingLabel,
  massErrorLabel,
  approveRetryButtonLabel,
  massStaleLabel,
  approveRefreshButtonLabel,
  massSuccessLabel
} from '@/lib/reporting/ledger-ui-text';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { MassApprovePreviewPanel, type MassPreviewResponseDto } from './MassApprovePreviewPanel';

export interface MassSelectedItem {
  itemKey: { timesheetId: string; siteId: string; workAreaId: string | null; weekStart: string };
  expectedFingerprint: string;
  employeeName: string;
  weekEnd: string;
  workedMinutes: number;
  customerKey: string;
  siteName: string;
  workAreaName: string | null;
}

interface ApiErrorEnvelope {
  error: { code: string; message: string };
}
interface MassCommitResponse {
  batchId: string | null;
  itemCount: number;
  alreadyApprovedCount: number;
}

type Phase = 'idle' | 'previewing' | 'previewReady' | 'committing' | 'stale' | 'error' | 'success';

function selectionSignatureOf(items: MassSelectedItem[]): string {
  return items
    .map((it) => `${it.itemKey.timesheetId}:${it.itemKey.siteId}:${it.itemKey.workAreaId ?? ''}:${it.itemKey.weekStart}:${it.expectedFingerprint}`)
    .sort()
    .join('|');
}

// UT6-B — the sticky mass-approval action bar (UT6-A-R1 §7/§8/§9/§18). Explicit selection only, one
// customer at a time (enforced upstream by TimesheetsLedgerView/CustomerGroupSection — this
// component just renders whatever selection it is given), always preview -> one explicit confirm
// click -> commit -> real refetch, never an optimistic row update. Idempotency-Key handling mirrors
// ApproveWeekAction's single-item design exactly, generalized to the whole selection: kept only
// across a retry after an ambiguous NETWORK_ERROR, cleared for every deterministic HTTP outcome or a
// genuinely new preview/selection.
//
// UT6-B-fixup #1 — a preview binds a confirmationToken to the EXACT selection it was computed from
// (server-checked via selectionHash). Once a preview exists, TimesheetsLedgerView locks every
// checkbox/select-visible/confirm-all-matching control via onActiveChange(true) below, so the
// selection cannot change out from under a live token through the normal UI path. As a second,
// independent line of defense (filter changes clear the selection through a totally separate code
// path in TimesheetsLedgerView, not mediated by this lock), selectionSignatureOf is compared against
// what the current preview/attempt was actually based on: any mismatch immediately invalidates the
// stale preview/token/key rather than ever letting a commit fire against a different selection.
export function MassApproveBar({
  locale,
  selectedItems,
  onClearSelection,
  onApproved,
  onActiveChange
}: {
  locale: AppLocale;
  selectedItems: Map<string, MassSelectedItem>;
  onClearSelection: () => void;
  onApproved: () => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [preview, setPreview] = useState<MassPreviewResponseDto | null>(null);
  const [successText, setSuccessText] = useState('');
  const busyRef = useRef(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const errorSourceRef = useRef<'preview' | 'commit' | null>(null);
  // Bumped on every new attempt AND whenever a stale attempt is invalidated — an async response
  // whose seq no longer matches attemptSeqRef.current is silently discarded (never applied to state),
  // the same pattern TimesheetsLedgerView's own fetch effect already uses.
  const attemptSeqRef = useRef(0);
  // The selection signature the CURRENT preview/token/attempt was actually computed from — null
  // whenever there is no live preview to protect. Compared against the live selection every render.
  const lastPreviewedSignatureRef = useRef<string | null>(null);

  const items = useMemo(() => [...selectedItems.values()], [selectedItems]);
  const first = items[0];
  const selectionSignature = useMemo(() => selectionSignatureOf(items), [items]);

  useEffect(() => {
    onActiveChange?.(phase !== 'idle');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // A fresh non-empty selection after a previous success run starts a clean slate — the user picked
  // new rows, so the success message from the LAST attempt must not linger.
  useEffect(() => {
    if (items.length > 0 && phase === 'success') {
      setPhase('idle');
      setPreview(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  // UT6-B-fixup #1 — the selection changed out from under a live preview/attempt (filter change,
  // or defensively anything else) -> immediately invalidate. Never let a stale token be sent against
  // a selection it was not computed for. Deliberately excludes 'success' (already handled above) and
  // 'idle' (nothing to invalidate).
  useEffect(() => {
    if (lastPreviewedSignatureRef.current !== null && lastPreviewedSignatureRef.current !== selectionSignature && phase !== 'success' && phase !== 'idle') {
      attemptSeqRef.current++; // discard any in-flight preview/commit response for the old selection
      lastPreviewedSignatureRef.current = null;
      idempotencyKeyRef.current = null;
      errorSourceRef.current = null;
      busyRef.current = false;
      setPreview(null);
      setPhase('idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionSignature]);

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

  function selectionBody() {
    return items.map((it) => ({ itemKey: it.itemKey, expectedFingerprint: it.expectedFingerprint }));
  }

  async function runPreview() {
    if (busyRef.current || items.length === 0) return;
    busyRef.current = true;
    const seq = ++attemptSeqRef.current;
    lastPreviewedSignatureRef.current = selectionSignature;
    setPhase('previewing');
    // A NEW preview is a genuinely new intent — any leftover key from a previous, now-abandoned
    // attempt must never leak into whatever commit follows this one.
    idempotencyKeyRef.current = null;
    errorSourceRef.current = null;

    const result = await fetchJson<MassPreviewResponseDto>('/api/admin/time-ledger/mass-approval-preview', null, { selection: selectionBody() });
    busyRef.current = false;
    if (seq !== attemptSeqRef.current) return; // superseded (selection changed / cancelled meanwhile)
    if (!result.ok) {
      errorSourceRef.current = 'preview';
      setPhase('error');
      return;
    }
    setPreview(result.body);
    setPhase('previewReady');
  }

  async function runCommit() {
    if (busyRef.current || !preview?.confirmationToken) return;
    // Defensive (UT6-B-fixup #1): never send a commit whose live selection no longer matches what
    // this token was issued for. The locking above should make this unreachable through normal UI
    // use, but a commit must never fire against a mismatched selection regardless.
    if (selectionSignature !== lastPreviewedSignatureRef.current) {
      cancelPreview();
      return;
    }
    busyRef.current = true;
    const seq = ++attemptSeqRef.current;
    setPhase('committing');
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = crypto.randomUUID();

    const result = await fetchJson<MassCommitResponse>('/api/admin/time-ledger/mass-approvals', idempotencyKeyRef.current, {
      selection: selectionBody(),
      confirmationToken: preview.confirmationToken
    });
    busyRef.current = false;
    if (seq !== attemptSeqRef.current) return; // superseded meanwhile
    if (!result.ok) {
      if (result.code === 'APPROVAL_SELECTION_STALE' || result.code === 'CONFIRMATION_TOKEN_EXPIRED') {
        idempotencyKeyRef.current = null;
        lastPreviewedSignatureRef.current = null;
        setPhase('stale');
        return;
      }
      if (result.code === 'NETWORK_ERROR') {
        // The only genuinely ambiguous case: fetch() itself threw, so whether the server actually
        // processed this commit is unknown. Keep the SAME key (and preview state, which still holds
        // the same selection/token) so "Try again" replays this exact same commit — a cached replay
        // if it already landed, a real retry if it never arrived.
        errorSourceRef.current = 'commit';
        setPhase('error');
        return;
      }
      // Every other code is a real, deterministic HTTP response the server already ran to
      // completion — retrying with the same key/body would only ever replay it. Start fresh.
      idempotencyKeyRef.current = null;
      errorSourceRef.current = 'preview';
      setPhase('error');
      return;
    }
    idempotencyKeyRef.current = null;
    lastPreviewedSignatureRef.current = null;
    setSuccessText(massSuccessLabel(result.body.itemCount, result.body.alreadyApprovedCount, locale));
    setPhase('success');
    onClearSelection();
    onApproved();
  }

  function retryAfterError() {
    if (busyRef.current) return;
    if (errorSourceRef.current === 'commit') {
      void runCommit();
    } else {
      void runPreview();
    }
  }

  // "Изменить выбор" (UT6-B-fixup #1) — discards the current preview/token/key WITHOUT touching the
  // actual selection (checkboxes stay checked), returns to 'idle' so selection editing unlocks again
  // via onActiveChange(false). A genuinely new preview is required before any commit can fire.
  function cancelPreview() {
    if (phase === 'previewing' || phase === 'committing') return; // let the in-flight request land first
    attemptSeqRef.current++;
    lastPreviewedSignatureRef.current = null;
    idempotencyKeyRef.current = null;
    errorSourceRef.current = null;
    setPreview(null);
    setPhase('idle');
  }

  function handleClearSelection() {
    cancelPreview();
    onClearSelection();
  }

  function refreshAfterStale() {
    onApproved();
    handleClearSelection();
  }

  if (items.length === 0 && phase === 'idle') return null;

  const customerLabel = first ? (first.workAreaName ?? first.siteName) : '';
  const totalMinutes = items.reduce((sum, it) => sum + it.workedMinutes, 0);
  const busy = phase === 'previewing' || phase === 'committing';

  return (
    <div className="ledger-mass-bar" role="region" aria-label={massSelectedCountLabel(items.length, locale)}>
      <div className="ledger-mass-bar-summary">
        <strong>{massSelectedCountLabel(items.length, locale)}</strong>
        {customerLabel && <span>{customerLabel}</span>}
        <span>{formatWorkedDuration(totalMinutes, locale)}</span>
        {!busy && phase !== 'success' && (
          <button type="button" className="ledger-link-button" onClick={handleClearSelection}>
            {massClearSelectionLabel(locale)}
          </button>
        )}
      </div>

      {phase === 'idle' && (
        <div className="ledger-mass-bar-actions">
          <button type="button" className="ledger-approve-button" onClick={runPreview}>
            {massConfirmSelectedLabel(locale)}
          </button>
        </div>
      )}

      {busy && (
        <p className="ledger-approve-loading" role="status" aria-live="polite">
          {phase === 'previewing' ? massPreviewLoadingLabel(locale) : massCommittingLabel(locale)}
        </p>
      )}

      {phase === 'previewReady' && preview && <MassApprovePreviewPanel locale={locale} preview={preview} onConfirm={runCommit} onCancel={cancelPreview} confirmDisabled={busyRef.current} />}

      {phase === 'stale' && (
        <div className="ledger-approve-stale" role="alert">
          <p>{massStaleLabel(locale)}</p>
          <button type="button" className="ledger-retry-button" onClick={refreshAfterStale}>
            {approveRefreshButtonLabel(locale)}
          </button>
        </div>
      )}

      {phase === 'error' && (
        <div className="ledger-approve-error" role="alert">
          <p>{massErrorLabel(locale)}</p>
          <div className="ledger-approve-actions">
            <button type="button" className="ledger-retry-button" onClick={retryAfterError}>
              {approveRetryButtonLabel(locale)}
            </button>
            <button type="button" className="ledger-link-button" onClick={cancelPreview}>
              {localeText(locale, 'Change selection', 'Изменить выбор')}
            </button>
          </div>
        </div>
      )}

      {phase === 'success' && (
        <p className="ledger-approve-success" role="status">
          {successText}
        </p>
      )}
    </div>
  );
}
