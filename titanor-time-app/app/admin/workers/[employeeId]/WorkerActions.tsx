'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { WorkerDetail } from '@/lib/workers';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { localeText } from '@/lib/i18n/locale';

const CSRF_HEADER_VALUE = 'titanor-time';

export function WorkerActions({ worker }: { worker: WorkerDetail }) {
  const router = useRouter();
  const locale = useAppLocale();
  const s = adminDailyStrings(locale);

  const [firstName, setFirstName] = useState(worker.firstName);
  const [lastName, setLastName] = useState(worker.lastName);
  const [phone, setPhone] = useState(worker.phone ?? '');
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [showDeactivate, setShowDeactivate] = useState(false);
  const [reason, setReason] = useState('');
  const [endDate, setEndDate] = useState('');
  const [deactivateLoading, setDeactivateLoading] = useState(false);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  const [reactivateLoading, setReactivateLoading] = useState(false);
  const [reactivateError, setReactivateError] = useState<string | null>(null);

  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const [regenerateLoading, setRegenerateLoading] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [regenerateResult, setRegenerateResult] = useState<{ username: string; changed: boolean } | null>(null);
  const [usernameCopied, setUsernameCopied] = useState(false);

  const currentUsername = regenerateResult?.username ?? worker.username;
  // Covers both a still-numeric username and a stale base from a since-renamed Employee
  // (lib/workers.ts's WorkerDetail.recommendedUsernameBase) — hidden once a regenerate just
  // succeeded so the button doesn't reappear before router.refresh() lands the new username.
  const needsFriendlyLogin = !regenerateResult && !worker.username.startsWith(worker.recommendedUsernameBase);

  const [activationLoading, setActivationLoading] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  function formatCodeForDisplay(code: string): string {
    return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 10)}`;
  }

  async function handleIssueActivation(): Promise<void> {
    if (activationLoading) {
      return;
    }
    setActivationError(null);
    setActivationLoading(true);

    try {
      const response = await fetch(`/api/admin/workers/${worker.id}/activation`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': CSRF_HEADER_VALUE,
          'Idempotency-Key': crypto.randomUUID()
        }
      });

      if (!response.ok) {
        const code = await parseErrorCode(response);
        switch (code) {
          case 'SETUP_INCOMPLETE':
            setActivationError(localeText(locale, 'This worker does not have an active employment eligible for activation.', 'У работника нет активного трудоустройства, подходящего для активации.'));
            break;
          case 'WORKER_ALREADY_ACTIVE':
            setActivationError(localeText(locale, 'This worker has already activated their account.', 'Работник уже активировал учётную запись.'));
            break;
          case 'FORBIDDEN':
            setActivationError(localeText(locale, 'You no longer have permission to issue activation codes.', 'У вас больше нет права выдавать коды активации.'));
            break;
          default:
            setActivationError(localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
        }
        setActivationLoading(false);
        return;
      }

      const body = (await response.json()) as { activationCode: string; activationExpiresAt: string };
      setIssuedCode({ code: body.activationCode, expiresAt: body.activationExpiresAt });
      setCodeCopied(false);
      setLinkCopied(false);
      const activationUrl = `${window.location.origin}/activate/${body.activationCode}`;
      try {
        const QRCode = (await import('qrcode')).default;
        setQrDataUrl(await QRCode.toDataURL(activationUrl, { errorCorrectionLevel: 'M', margin: 2, width: 256 }));
      } catch {
        setQrDataUrl(null);
      }
      setActivationLoading(false);
    } catch {
      setActivationError(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setActivationLoading(false);
    }
  }

  async function copyActivationLink(): Promise<void> {
    if (!issuedCode) {
      return;
    }
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/activate/${issuedCode.code}`);
      setLinkCopied(true);
    } catch {
      // QR and the visible code remain available when Clipboard API is unavailable.
    }
  }

  async function copyIssuedCode(): Promise<void> {
    if (!issuedCode) {
      return;
    }
    try {
      await navigator.clipboard.writeText(formatCodeForDisplay(issuedCode.code));
      setCodeCopied(true);
    } catch {
      // Clipboard API unavailable — the code is still shown as plain text below.
    }
  }

  async function copyUsername(): Promise<void> {
    try {
      await navigator.clipboard.writeText(currentUsername);
      setUsernameCopied(true);
    } catch {
      // Clipboard API unavailable — the username is still shown as plain text.
    }
  }

  async function handleRegenerateUsername(): Promise<void> {
    if (regenerateLoading) {
      return;
    }
    setRegenerateError(null);
    setRegenerateLoading(true);

    try {
      const response = await fetch(`/api/admin/workers/${worker.id}/regenerate-username`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE }
      });

      if (!response.ok) {
        const code = await parseErrorCode(response);
        switch (code) {
          case 'WORKER_NOT_FOUND':
            setRegenerateError(localeText(locale, 'This worker no longer exists.', 'Этого работника больше нет.'));
            break;
          case 'FORBIDDEN':
            setRegenerateError(localeText(locale, 'You no longer have permission to change worker logins.', 'У вас больше нет права менять логины работников.'));
            break;
          default:
            setRegenerateError(localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
        }
        setRegenerateLoading(false);
        return;
      }

      const body = (await response.json()) as { username: string; changed: boolean };
      setRegenerateResult({ username: body.username, changed: body.changed });
      setUsernameCopied(false);
      setShowRegenerateConfirm(false);
      setRegenerateLoading(false);
      router.refresh();
    } catch {
      setRegenerateError(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setRegenerateLoading(false);
    }
  }

  async function parseErrorCode(response: Response): Promise<string | undefined> {
    try {
      const body = (await response.json()) as { error?: { code?: string } };
      return body.error?.code;
    } catch {
      return undefined;
    }
  }

  async function handleEdit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (editLoading) {
      return;
    }
    setEditError(null);
    setEditLoading(true);

    try {
      const response = await fetch(`/api/admin/workers/${worker.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ version: worker.version, firstName, lastName, phone: phone || null })
      });

      if (!response.ok) {
        const code = await parseErrorCode(response);
        switch (code) {
          case 'VALIDATION_ERROR':
            setEditError(localeText(locale, 'Please check the fields above.', 'Проверьте заполненные поля.'));
            break;
          case 'VERSION_CONFLICT':
            setEditError(localeText(locale, 'This worker was changed elsewhere — reloading.', 'Работник изменён в другом окне — обновляем страницу.'));
            router.refresh();
            break;
          case 'FORBIDDEN':
            setEditError(localeText(locale, 'You no longer have permission to edit workers.', 'У вас больше нет права изменять работников.'));
            break;
          default:
            setEditError(localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
        }
        setEditLoading(false);
        return;
      }

      router.refresh();
      setEditLoading(false);
    } catch {
      setEditError(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setEditLoading(false);
    }
  }

  async function handleReactivate(): Promise<void> {
    if (reactivateLoading) {
      return;
    }
    setReactivateError(null);
    setReactivateLoading(true);

    try {
      const response = await fetch(`/api/admin/workers/${worker.id}/reactivate`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE }
      });

      if (!response.ok) {
        const code = await parseErrorCode(response);
        switch (code) {
          case 'ALREADY_ACTIVE':
            setReactivateError(localeText(locale, 'This worker is already active.', 'Работник уже активен.'));
            break;
          case 'WORKER_NOT_FOUND':
            setReactivateError(localeText(locale, 'This worker no longer exists.', 'Этого работника больше нет.'));
            break;
          case 'FORBIDDEN':
            setReactivateError(localeText(locale, 'You no longer have permission to change workers.', 'У вас больше нет права изменять работников.'));
            break;
          default:
            setReactivateError(localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
        }
        setReactivateLoading(false);
        return;
      }

      router.refresh();
      setReactivateLoading(false);
    } catch {
      setReactivateError(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setReactivateLoading(false);
    }
  }

  async function handleDeactivate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (deactivateLoading) {
      return;
    }
    setDeactivateError(null);
    setDeactivateLoading(true);

    try {
      const response = await fetch(`/api/admin/workers/${worker.id}/deactivate`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ reason, endDate: endDate || undefined })
      });

      if (!response.ok) {
        const code = await parseErrorCode(response);
        switch (code) {
          case 'VALIDATION_ERROR':
            setDeactivateError(localeText(locale, 'A reason is required.', 'Необходимо указать причину.'));
            break;
          case 'ALREADY_DEACTIVATED':
            setDeactivateError(localeText(locale, 'This worker is already deactivated.', 'Работник уже деактивирован.'));
            break;
          case 'FORBIDDEN':
            setDeactivateError(localeText(locale, 'You no longer have permission to deactivate workers.', 'У вас больше нет права деактивировать работников.'));
            break;
          default:
            setDeactivateError(localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
        }
        setDeactivateLoading(false);
        return;
      }

      router.refresh();
      setDeactivateLoading(false);
      setShowDeactivate(false);
    } catch {
      setDeactivateError(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setDeactivateLoading(false);
    }
  }

  return (
    <>
      <h2 id="worker-profile">{localeText(locale, 'Edit', 'Редактирование')}</h2>
      <form onSubmit={handleEdit} aria-busy={editLoading}>
        <div className="login-field">
          <label htmlFor="edit-first-name">{s.workers.firstName}</label>
          <input
            id="edit-first-name"
            type="text"
            required
            disabled={editLoading}
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
          />
        </div>
        <div className="login-field">
          <label htmlFor="edit-last-name">{s.workers.lastName}</label>
          <input
            id="edit-last-name"
            type="text"
            required
            disabled={editLoading}
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
          />
        </div>
        <div className="login-field">
          <label htmlFor="edit-phone">{localeText(locale, 'Phone', 'Телефон')}</label>
          <input
            id="edit-phone"
            type="tel"
            disabled={editLoading}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>
        {editError ? (
          <p className="login-error" role="alert">
            {editError}
          </p>
        ) : null}
        <button className="login-submit" type="submit" disabled={editLoading}>
          {editLoading ? s.common.saving : localeText(locale, 'Save changes', 'Сохранить изменения')}
        </button>
      </form>

      <h2>{localeText(locale, 'Login', 'Вход')}</h2>
      <p>
        {s.workers.login}: <strong>{currentUsername}</strong>{' '}
        <button type="button" className="login-submit" onClick={copyUsername}>
          {usernameCopied ? localeText(locale, 'Copied', 'Скопировано') : localeText(locale, 'Copy', 'Копировать')}
        </button>
      </p>
      {regenerateResult ? (
        <p role="status">
          {regenerateResult.changed
            ? localeText(locale, "The login username was updated. The worker's password and current sessions remain valid.", 'Логин обновлён. Пароль работника и текущие сеансы продолжают действовать.')
            : localeText(locale, 'This worker already has the current friendly login — nothing changed.', 'У работника уже удобный логин — ничего не изменилось.')}
        </p>
      ) : null}
      {needsFriendlyLogin ? (
        !showRegenerateConfirm ? (
          <button type="button" className="login-submit" onClick={() => setShowRegenerateConfirm(true)}>
            {localeText(locale, 'Generate friendly login', 'Создать удобный логин')}
          </button>
        ) : (
          <div>
            <p role="alert">
              {localeText(locale, 'The worker must use the new username for future logins. Their password and current sessions remain valid.', 'Для следующих входов работник должен использовать новый логин. Пароль и текущие сеансы продолжат действовать.')}
            </p>
            <button type="button" className="login-submit" disabled={regenerateLoading} onClick={handleRegenerateUsername}>
              {regenerateLoading ? localeText(locale, 'Generating…', 'Создание…') : localeText(locale, 'Confirm', 'Подтвердить')}
            </button>
            <button
              type="button"
              className="login-submit"
              disabled={regenerateLoading}
              onClick={() => setShowRegenerateConfirm(false)}
            >
              {localeText(locale, 'Cancel', 'Отмена')}
            </button>
          </div>
        )
      ) : null}
      {regenerateError ? (
        <p className="login-error" role="alert">
          {regenerateError}
        </p>
      ) : null}

      <h2>{localeText(locale, 'Activation', 'Активация')}</h2>
      {worker.activationStatus === 'READY_FOR_ACTIVATION' ? (
        <section className={issuedCode ? 'activation-print-card' : undefined}>
          {issuedCode ? (
            <div>
              <p className="login-error" role="alert">
                {localeText(locale, 'This code is shown only once — save or copy it now. It will not be shown again.', 'Этот код показывается только один раз — сохраните или скопируйте его сейчас. Повторно он не появится.')}
              </p>
              <p>
                {s.workers.login}: <strong>{worker.username}</strong>
              </p>
              <p>
                <strong>{formatCodeForDisplay(issuedCode.code)}</strong>{' '}
                <button type="button" className="login-submit" onClick={copyIssuedCode}>
                  {codeCopied ? localeText(locale, 'Copied', 'Скопировано') : localeText(locale, 'Copy', 'Копировать')}
                </button>
              </p>
              <p>{localeText(locale, 'Expires', 'Действует до')}: {new Date(issuedCode.expiresAt).toLocaleString(locale === 'RU' ? 'ru-RU' : 'en-GB')}</p>
              {qrDataUrl ? (
                // The QR is generated locally in this browser; the raw activation code is never
                // sent to a third-party image service.
                // eslint-disable-next-line @next/next/no-img-element
                <img className="activation-qr" src={qrDataUrl} alt={localeText(locale, 'Worker activation QR code', 'QR-код активации работника')} />
              ) : null}
              <div className="activation-actions">
                <button type="button" className="login-submit" onClick={copyActivationLink}>
                  {linkCopied ? localeText(locale, 'Link copied', 'Ссылка скопирована') : localeText(locale, 'Copy activation link', 'Копировать ссылку активации')}
                </button>
                <button type="button" className="login-submit" onClick={() => window.print()}>
                  {localeText(locale, 'Print code and QR', 'Печать кода и QR')}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="login-submit" disabled={activationLoading} onClick={handleIssueActivation}>
              {activationLoading ? localeText(locale, 'Issuing…', 'Выдача…') : localeText(locale, 'Issue activation code', 'Выдать код активации')}
            </button>
          )}
          {activationError ? (
            <p className="login-error" role="alert">
              {activationError}
            </p>
          ) : null}
        </section>
      ) : worker.activationStatus === 'SETUP_INCOMPLETE' ? (
        <div className="worker-setup-callout">
          <p>{localeText(locale, 'This account cannot be activated because its employment is not active. Use “Reactivate worker” below first.', 'Учётную запись нельзя активировать, потому что трудоустройство неактивно. Сначала нажмите «Восстановить работника» ниже.')}</p>
        </div>
      ) : (
        <p>{localeText(locale, 'This worker has already activated their account.', 'Работник уже активировал учётную запись.')}</p>
      )}

      {worker.employment?.active ? (
        <>
          <h2>{localeText(locale, 'Deactivate', 'Деактивация')}</h2>
          <p className="setup-subtitle">
            {localeText(
              locale,
              'Ends the employment and moves the worker to the archive. Nothing is deleted — their timesheets, history and assignments stay, and “Reactivate worker” brings them back. The worker list hides archived workers by default.',
              'Завершает трудоустройство и убирает работника в архив. Ничего не удаляется — табели, история и назначения сохраняются, а «Восстановить работника» возвращает его. В списке работников архивные по умолчанию скрыты.'
            )}
          </p>
          {!showDeactivate ? (
            <button type="button" className="login-submit" onClick={() => setShowDeactivate(true)}>
              {localeText(locale, 'Deactivate worker', 'Деактивировать работника')}
            </button>
          ) : (
            <form onSubmit={handleDeactivate} aria-busy={deactivateLoading}>
              <div className="login-field">
                <label htmlFor="deactivate-reason">{localeText(locale, 'Reason', 'Причина')}</label>
                <textarea
                  id="deactivate-reason"
                  required
                  rows={3}
                  disabled={deactivateLoading}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <div className="login-field">
                <label htmlFor="deactivate-end-date">{localeText(locale, 'End date (optional — defaults to today)', 'Дата окончания (необязательно — по умолчанию сегодня)')}</label>
                <input
                  id="deactivate-end-date"
                  type="date"
                  disabled={deactivateLoading}
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                />
              </div>
              {deactivateError ? (
                <p className="login-error" role="alert">
                  {deactivateError}
                </p>
              ) : null}
              <button className="login-submit" type="submit" disabled={deactivateLoading}>
                {deactivateLoading ? localeText(locale, 'Deactivating…', 'Деактивация…') : localeText(locale, 'Confirm deactivation', 'Подтвердить деактивацию')}
              </button>
            </form>
          )}
        </>
      ) : (
        <>
          <h2>{localeText(locale, 'Reactivate', 'Восстановление')}</h2>
          <p className="setup-subtitle">
            {localeText(
              locale,
              'Bring this worker back to an active state — undoes the deactivation. Their site assignments and timesheets are kept.',
              'Вернуть работника в активное состояние — отменяет деактивацию. Назначения на объекты и табели сохраняются.'
            )}
          </p>
          {reactivateError ? (
            <p className="login-error" role="alert">
              {reactivateError}
            </p>
          ) : null}
          <button
            type="button"
            className="login-submit"
            disabled={reactivateLoading}
            onClick={handleReactivate}
          >
            {reactivateLoading
              ? localeText(locale, 'Reactivating…', 'Восстановление…')
              : localeText(locale, 'Reactivate worker', 'Восстановить работника')}
          </button>
        </>
      )}
    </>
  );
}
