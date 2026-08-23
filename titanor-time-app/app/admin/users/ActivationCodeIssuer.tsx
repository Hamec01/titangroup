'use client';

import { useEffect, useRef, useState } from 'react';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §15 — POST
// /api/admin/users/:userId/activation. Shared by the /admin/users list (manual issue/reissue per
// row) and /admin/users/new's post-creation success view (auto-issue once). The API already
// returns activationCode pre-formatted as "XXXX-XXXX-XX" — never reformatted here. The raw code
// only ever lives in this component's own React state: never localStorage/sessionStorage, never
// console, gone the moment this component unmounts or the page refreshes.
const CSRF_HEADER_VALUE = 'titanor-time';

interface IssuedCode {
  code: string;
  expiresAt: string;
}

function ambiguousMessage(ru: boolean): string {
  return ru
    ? 'Результат не удалось подтвердить. Повторите попытку, чтобы получить тот же ответ активации. Не используйте ранее показанный код.'
    : 'The result could not be confirmed. Retry to recover the same activation response. Do not use the previously displayed code.';
}

function describeIssueError(code: string | undefined, ru: boolean): string {
  switch (code) {
    case 'USER_NOT_FOUND':
      return ru ? 'Этот пользователь больше не существует.' : 'This user no longer exists.';
    case 'USER_ALREADY_ACTIVE':
      return ru ? 'Эта учётная запись уже активирована.' : 'This account has already been activated.';
    case 'USER_USES_WORKER_ACTIVATION':
      return ru ? 'Этот пользователь связан с профилем работника и использует обычный процесс активации работника.' : 'This user is linked to a worker profile and uses the regular worker activation flow instead.';
    case 'ACCOUNT_NOT_ELIGIBLE':
      return ru ? 'Эта учётная запись сейчас не может быть активирована.' : 'This account is not eligible for activation right now.';
    case 'FORBIDDEN':
      return ru ? 'У вас больше нет права выдавать коды активации.' : 'You no longer have permission to issue activation codes.';
    default:
      return ru ? 'Что-то пошло не так. Попробуйте снова.' : 'Something went wrong. Please try again.';
  }
}

export function ActivationCodeIssuer({ userId, autoIssue = false }: { userId: string; autoIssue?: boolean }) {
  const ru = useAppLocale() === 'RU';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True only when the last attempt's HTTP outcome is unknown (fetch threw) — distinct from a
  // determinate server error, since it changes what "Retry" must do (reuse the same key) and
  // what it must never do (let the old code look valid again).
  const [ambiguous, setAmbiguous] = useState(false);
  const [autoIssueFailed, setAutoIssueFailed] = useState(false);
  const [issuedCode, setIssuedCode] = useState<IssuedCode | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const autoIssueAttempted = useRef(false);

  // Holds the Idempotency-Key of the current *unresolved* issue/reissue operation. Cleared the
  // moment the server gives a determinate answer (2xx or non-2xx) — at that point the outcome is
  // known and a later, separately-intentional reissue must get a fresh key. Left set only when a
  // fetch/network exception makes the outcome ambiguous, so Retry replays into the exact same
  // request (cached response if the server already committed it) instead of risking a second
  // issue/reissue.
  const idempotencyKeyRef = useRef<string | null>(null);
  const lastAttemptWasAutoRef = useRef(false);

  async function handleIssue(isAutoAttempt: boolean): Promise<void> {
    if (loading) {
      return;
    }
    lastAttemptWasAutoRef.current = isAutoAttempt;

    // Once any issue/reissue/retry attempt starts, the previously displayed code can no longer
    // be guaranteed valid — the server may already have revoked it even if this attempt's own
    // response ends up lost. Hide it immediately rather than waiting for a response.
    setIssuedCode(null);
    setQrDataUrl(null);
    setCodeCopied(false);
    setLinkCopied(false);
    setError(null);
    setAmbiguous(false);
    setAutoIssueFailed(false);
    setLoading(true);

    if (idempotencyKeyRef.current === null) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }
    const idempotencyKey = idempotencyKeyRef.current;

    try {
      const response = await fetch(`/api/admin/users/${userId}/activation`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': CSRF_HEADER_VALUE,
          'Idempotency-Key': idempotencyKey
        }
      });

      if (!response.ok) {
        // The server's answer is known — a future retry must not replay this (now resolved) key.
        idempotencyKeyRef.current = null;
        let code: string | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string } };
          code = body.error?.code;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }
        setError(describeIssueError(code, ru));
        setAutoIssueFailed(isAutoAttempt);
        setLoading(false);
        return;
      }

      // A 2xx status alone isn't a resolved outcome yet — the body still has to be read and
      // validated. If that throws (empty/truncated body despite a 2xx status), the outer catch
      // below must still treat this as ambiguous and keep the same key, so the key is only ever
      // cleared once the body has actually been parsed and checked.
      const body = (await response.json()) as { activationCode?: unknown; activationExpiresAt?: unknown };
      if (
        typeof body.activationCode !== 'string' ||
        body.activationCode.length === 0 ||
        typeof body.activationExpiresAt !== 'string' ||
        body.activationExpiresAt.length === 0
      ) {
        throw new Error('Malformed activation response body');
      }

      // Only now is the outcome actually known — the next *intentional* reissue (a fresh button
      // click, not a retry) gets a new key.
      idempotencyKeyRef.current = null;
      setIssuedCode({ code: body.activationCode, expiresAt: body.activationExpiresAt });
      const activationUrl = `${window.location.origin}/activate-account/${body.activationCode}`;
      try {
        const QRCode = (await import('qrcode')).default;
        setQrDataUrl(await QRCode.toDataURL(activationUrl, { errorCorrectionLevel: 'M', margin: 2, width: 256 }));
      } catch {
        setQrDataUrl(null);
      }
      setLoading(false);
    } catch {
      // fetch itself threw (network error, connection reset, etc.) — whether the server already
      // committed the issue/reissue is unknown. Keep the same Idempotency-Key so Retry replays
      // into the cached response instead of risking a second token, and never generate a new key
      // until a determinate HTTP response is actually received.
      setAmbiguous(true);
      setError(ambiguousMessage(ru));
      setLoading(false);
    }
  }

  useEffect(() => {
    if (autoIssue && !autoIssueAttempted.current) {
      autoIssueAttempted.current = true;
      void handleIssue(true);
    }
    // Fires once on mount only — this component is always mounted fresh per user, never reused
    // for a different userId in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copyIssuedCode(): Promise<void> {
    if (!issuedCode) {
      return;
    }
    try {
      await navigator.clipboard.writeText(issuedCode.code);
      setCodeCopied(true);
    } catch {
      // Clipboard API unavailable — the code is still shown as plain text below.
    }
  }

  async function copyActivationLink(): Promise<void> {
    if (!issuedCode) {
      return;
    }
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/activate-account/${issuedCode.code}`);
      setLinkCopied(true);
    } catch {
      // QR and the visible code remain available when Clipboard API is unavailable.
    }
  }

  if (issuedCode) {
    return (
      <div className="activation-print-card">
        <p className="login-error" role="alert">
          {ru
            ? 'Этот код показывается только один раз — запишите, скопируйте или распечатайте его сейчас. Он больше не будет показан после того, как вы покинете эту страницу или обновите её.'
            : 'This code is shown only once — write it down, copy it, or print it now. It will not be shown again after you leave or refresh this page.'}
        </p>
        <p>
          <strong>{issuedCode.code}</strong>{' '}
          <button type="button" className="login-submit" onClick={copyIssuedCode}>
            {codeCopied ? (ru ? 'Скопировано' : 'Copied') : (ru ? 'Скопировать код' : 'Copy code')}
          </button>
        </p>
        <p>{ru ? 'Истекает:' : 'Expires:'} {new Date(issuedCode.expiresAt).toLocaleString(ru ? 'ru-RU' : 'en-GB')}</p>
        {qrDataUrl ? (
          // Generated locally in this browser — the raw code is never sent to a third-party image service.
          // eslint-disable-next-line @next/next/no-img-element
          <img className="activation-qr" src={qrDataUrl} alt={ru ? 'QR-код активации учётной записи прораба' : 'Foreman account activation QR code'} />
        ) : null}
        <div className="activation-actions">
          <button type="button" className="login-submit" onClick={copyActivationLink}>
            {linkCopied ? (ru ? 'Ссылка скопирована' : 'Link copied') : (ru ? 'Скопировать ссылку активации' : 'Copy activation link')}
          </button>
          <button type="button" className="login-submit" onClick={() => window.print()}>
            {ru ? 'Печать кода и QR' : 'Print code and QR'}
          </button>
          <button type="button" className="login-submit" disabled={loading} onClick={() => handleIssue(false)}>
            {loading ? (ru ? 'Выдача…' : 'Issuing…') : (ru ? 'Выдать / перевыдать код активации' : 'Issue / reissue activation code')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {autoIssueFailed ? (
        <p className="login-error" role="alert">
          {ru ? 'Учётная запись создана, но код активации не удалось выдать автоматически.' : 'Account created, but the activation code could not be issued automatically.'}
        </p>
      ) : null}
      {ambiguous ? (
        <button
          type="button"
          className="login-submit"
          disabled={loading}
          onClick={() => handleIssue(lastAttemptWasAutoRef.current)}
        >
          {loading ? (ru ? 'Повтор…' : 'Retrying…') : (ru ? 'Повторить' : 'Retry')}
        </button>
      ) : (
        <button type="button" className="login-submit" disabled={loading} onClick={() => handleIssue(false)}>
          {loading ? (ru ? 'Выдача…' : 'Issuing…') : (ru ? 'Выдать / перевыдать код активации' : 'Issue / reissue activation code')}
        </button>
      )}
      <p className="setup-subtitle">{ru ? 'Перевыдача аннулирует любой ранее выданный код для этого пользователя.' : 'Reissuing revokes any previously issued code for this user.'}</p>
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
