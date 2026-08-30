'use client';

import { useRef, useState } from 'react';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

// R03 — "Restore access" on a user/worker card. POST /api/admin/{users|workers}/:id/recovery.
// Shows the one-time XXXX-XXXX-XXXX code ONCE. The raw code lives only in this component's state:
// never storage, never console; gone on unmount or refresh. Reissuing revokes any prior code.
const CSRF_HEADER_VALUE = 'titanor-time';

interface IssuedCode {
  code: string;
  expiresAt: string;
}

function describeError(code: string | undefined, ru: boolean): string {
  switch (code) {
    case 'TARGET_NOT_ELIGIBLE':
      return ru
        ? 'Восстановление недоступно: учётная запись ещё не активирована (используйте активацию) или деактивирована.'
        : 'Recovery is not available: the account has not been activated yet (use activation) or is deactivated.';
    case 'WORKER_NOT_FOUND':
    case 'USER_NOT_FOUND':
      return ru ? 'Запись больше не существует.' : 'This record no longer exists.';
    case 'FORBIDDEN':
      return ru ? 'У вас нет права выдавать коды восстановления.' : 'You do not have permission to issue recovery codes.';
    case 'IDEMPOTENCY_KEY_IN_PROGRESS':
      return ru ? 'Предыдущий запрос ещё обрабатывается. Повторите через мгновение.' : 'A previous request is still processing. Try again in a moment.';
    default:
      return ru ? 'Что-то пошло не так. Попробуйте снова.' : 'Something went wrong. Please try again.';
  }
}

export function RecoveryCodeIssuer({ kind, id }: { kind: 'user' | 'worker'; id: string }) {
  const ru = useAppLocale() === 'RU';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [copied, setCopied] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);

  const endpoint = kind === 'user' ? `/api/admin/users/${id}/recovery` : `/api/admin/workers/${id}/recovery`;

  async function issue(): Promise<void> {
    if (loading) return;
    setIssued(null);
    setCopied(false);
    setError(null);
    setAmbiguous(false);
    setLoading(true);
    if (idempotencyKeyRef.current === null) idempotencyKeyRef.current = crypto.randomUUID();

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE, 'Idempotency-Key': idempotencyKeyRef.current }
      });
      if (!response.ok) {
        idempotencyKeyRef.current = null;
        let code: string | undefined;
        try {
          code = ((await response.json()) as { error?: { code?: string } }).error?.code;
        } catch {
          /* non-JSON body */
        }
        setError(describeError(code, ru));
        setLoading(false);
        return;
      }
      const body = (await response.json()) as { code?: unknown; expiresAt?: unknown };
      if (typeof body.code !== 'string' || !body.code || typeof body.expiresAt !== 'string' || !body.expiresAt) {
        throw new Error('Malformed recovery response');
      }
      idempotencyKeyRef.current = null;
      setIssued({ code: body.code, expiresAt: body.expiresAt });
      setLoading(false);
    } catch {
      // fetch threw — the server may already have committed. Keep the key so Retry replays into
      // the cached response rather than issuing (and revoking the just-shown) a second code.
      setAmbiguous(true);
      setError(
        ru
          ? 'Результат не удалось подтвердить. Нажмите «Повторить», чтобы получить тот же код. Не используйте ранее показанный.'
          : 'The result could not be confirmed. Press “Retry” to recover the same code. Do not use the previously shown one.'
      );
      setLoading(false);
    }
  }

  async function copyCode(): Promise<void> {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.code);
      setCopied(true);
    } catch {
      /* code is visible as text anyway */
    }
  }

  if (issued) {
    return (
      <div className="activation-print-card">
        <p className="login-error" role="alert">
          {ru
            ? 'Код показывается только один раз. Передайте его работнику согласованным способом. Работник вводит логин, этот код и новый пароль на странице «Сброс пароля».'
            : 'This code is shown only once. Pass it to the user by an agreed channel. They enter their login, this code and a new password on the “Reset password” page.'}
        </p>
        <p>
          <strong>{issued.code}</strong>{' '}
          <button type="button" className="login-submit" onClick={copyCode}>
            {copied ? (ru ? 'Скопировано' : 'Copied') : (ru ? 'Скопировать код' : 'Copy code')}
          </button>
        </p>
        <p>{ru ? 'Истекает:' : 'Expires:'} {new Date(issued.expiresAt).toLocaleString(ru ? 'ru-RU' : 'en-GB')}</p>
        <button type="button" className="login-submit" disabled={loading} onClick={issue}>
          {loading ? (ru ? 'Выдача…' : 'Issuing…') : (ru ? 'Перевыдать код' : 'Reissue code')}
        </button>
      </div>
    );
  }

  return (
    <div>
      <button type="button" className="login-submit" disabled={loading} onClick={issue}>
        {loading
          ? (ru ? 'Выдача…' : 'Issuing…')
          : ambiguous
            ? (ru ? 'Повторить' : 'Retry')
            : (ru ? 'Восстановить доступ' : 'Restore access')}
      </button>
      <p className="setup-subtitle">{ru ? 'Перевыдача аннулирует любой ранее выданный код.' : 'Reissuing revokes any previously issued code.'}</p>
      {error ? <p className="login-error" role="alert">{error}</p> : null}
    </div>
  );
}
