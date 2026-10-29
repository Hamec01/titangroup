'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { CustomerCard } from '@/lib/reporting/monthly-matrix';
import { formatMatrixHours } from '@/lib/timesheet-v2-cell-input';

const CSRF_HEADERS = { 'X-Requested-With': 'titanor-time', 'Content-Type': 'application/json' };

type Dialog =
  | { kind: 'trash'; card: CustomerCard }
  | { kind: 'rename'; card: CustomerCard }
  | { kind: 'permanent-delete'; card: CustomerCard }
  | { kind: 'trash-list' }
  | null;

function PencilIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m10.9 2.1 3 3-8.8 8.8-3.5.7.7-3.5 8.6-9Zm-1.1 1.1 3 3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" /></svg>;
}

function TrashIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.5 4.2h11M6 4.2V2.5h4v1.7m2.5 0-.6 9.3H4.1l-.6-9.3m3.3 2.1v4.8m3.4-4.8v4.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" /></svg>;
}

function RestoreIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 5.3A5.5 5.5 0 1 1 2.5 9M3 2.5v3.2h3.2" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" /></svg>;
}

function defaultCardName(locale: AppLocale, card: CustomerCard): string {
  return card.displayName ?? card.workAreaName ?? localeText(locale, 'No customer', 'Без заказчика');
}

function hours(minutes: number, locale: AppLocale): string {
  return `${formatMatrixHours(minutes) || '0'} ${localeText(locale, 'h', 'ч')}`;
}

export function TimesheetV2Cards({ locale, month, cards, trashedCards }: { locale: AppLocale; month: string; cards: CustomerCard[]; trashedCards: CustomerCard[] }) {
  const router = useRouter();
  const ru = locale === 'RU';
  const [dialog, setDialog] = useState<Dialog>(null);
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openDialog(next: Dialog) {
    setError(null);
    if (next?.kind === 'rename') setDisplayName(defaultCardName(locale, next.card));
    setDialog(next);
  }

  async function perform(action: 'TRASH' | 'RESTORE' | 'DELETE' | 'RENAME', card: CustomerCard, keepTrashOpen = false) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/timesheets-v2/cards', {
        method: 'POST',
        headers: CSRF_HEADERS,
        body: JSON.stringify({
          action,
          month,
          siteId: card.siteId,
          workArea: card.workAreaId ?? 'none',
          ...(action === 'RENAME' ? { displayName: displayName.trim() } : {})
        })
      });
      if (!response.ok) {
        setError(ru ? 'Не удалось изменить карточку. Обновите страницу и попробуйте снова.' : 'Could not update the card. Reload and try again.');
        return;
      }
      if (keepTrashOpen) openDialog({ kind: 'trash-list' });
      else setDialog(null);
      router.refresh();
    } catch {
      setError(ru ? 'Ошибка сети. Проверьте соединение и попробуйте снова.' : 'Network error. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  function closeDialog() {
    if (!busy) {
      setDialog(null);
      setError(null);
    }
  }

  return (
    <div className="tv2-card-manager">
      <div className="tv2-card-toolbar">
        <button
          type="button"
          className="tv2-trash-button"
          aria-label={ru ? `Корзина табелей: ${trashedCards.length}` : `Timesheet trash: ${trashedCards.length}`}
          title={ru ? 'Корзина' : 'Trash'}
          onClick={() => openDialog({ kind: 'trash-list' })}
        >
          <TrashIcon />
          <span>{ru ? 'Корзина' : 'Trash'}</span>
          <b>{trashedCards.length}</b>
        </button>
      </div>

      {cards.length > 0 ? (
        <ul className="tv2-cards">
          {cards.map((card) => {
            const name = defaultCardName(locale, card);
            const href = `/admin/timesheets-v2/${card.siteId}/${card.workAreaId ?? 'none'}?month=${month}`;
            return (
              <li key={card.key} className="tv2-card-item">
                <Link href={href} className={card.peopleCount === 0 && card.workedMinutes === 0 ? 'tv2-card is-idle' : 'tv2-card'}>
                  <strong className="tv2-card-name">{name}</strong>
                  <span className="tv2-card-site">{card.siteName}</span>
                  <span className="tv2-card-stats">
                    <span><b>{card.peopleCount}</b> {localeText(locale, card.peopleCount === 1 ? 'worker' : 'workers', 'чел.')}</span>
                    <span><b>{formatMatrixHours(card.workedMinutes) || '0'}</b> {localeText(locale, 'h this month', 'ч за месяц')}</span>
                  </span>
                </Link>
                <div className="tv2-card-actions">
                  <button type="button" aria-label={ru ? `Переименовать: ${name}` : `Rename: ${name}`} title={ru ? 'Переименовать' : 'Rename'} onClick={() => openDialog({ kind: 'rename', card })}>
                    <PencilIcon />
                  </button>
                  <button type="button" aria-label={ru ? `В корзину: ${name}` : `Move to trash: ${name}`} title={ru ? 'В корзину' : 'Move to trash'} onClick={() => openDialog({ kind: 'trash', card })}>
                    <TrashIcon />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="month-matrix-empty">
          {trashedCards.length === 0
            ? localeText(locale, 'No customers yet. Create them under Setup → Customers.', 'Заказчиков пока нет. Их создают в разделе «Настройка → Заказчики».')
            : localeText(locale, 'No visible cards for this month. Check the trash.', 'В этом месяце нет видимых карточек. Проверьте корзину.')}
        </p>
      )}

      {dialog && (
        <div className="documents-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) closeDialog(); }}>
          <div className="documents-modal tv2-card-modal" role="dialog" aria-modal="true" aria-labelledby="tv2-card-dialog-title">
            {dialog.kind === 'trash-list' ? (
              <>
                <h2 id="tv2-card-dialog-title">{ru ? 'Корзина табелей' : 'Timesheet trash'}</h2>
                {trashedCards.length === 0 ? (
                  <p className="tv2-trash-empty">{ru ? 'Корзина пуста.' : 'The trash is empty.'}</p>
                ) : (
                  <ul className="tv2-trash-list">
                    {trashedCards.map((card) => (
                      <li key={card.key}>
                        <div>
                          <strong>{defaultCardName(locale, card)}</strong>
                          <small>{card.siteName}</small>
                          <small>{card.peopleCount} {localeText(locale, 'workers', 'чел.')} · {hours(card.workedMinutes, locale)}</small>
                        </div>
                        <div className="tv2-trash-actions">
                          <button type="button" disabled={busy} aria-label={ru ? 'Восстановить карточку' : 'Restore card'} title={ru ? 'Восстановить' : 'Restore'} onClick={() => void perform('RESTORE', card, true)}>
                            <RestoreIcon />
                          </button>
                          <button type="button" disabled={busy} className="is-danger" aria-label={ru ? 'Удалить карточку из корзины' : 'Permanently remove card from trash'} title={ru ? 'Удалить окончательно' : 'Delete permanently'} onClick={() => openDialog({ kind: 'permanent-delete', card })}>
                            <TrashIcon />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {error && <p className="login-error" role="alert">{error}</p>}
                <div><button type="button" disabled={busy} onClick={closeDialog}>{ru ? 'Закрыть' : 'Close'}</button></div>
              </>
            ) : dialog.kind === 'rename' ? (
              <>
                <h2 id="tv2-card-dialog-title">{ru ? 'Переименовать карточку' : 'Rename card'}</h2>
                <p>{ru ? 'Новое название будет использоваться в табеле за этот месяц. Название заказчика в других разделах не изменится.' : 'The new name will be used in this month’s timesheet only. The customer name in other areas will not change.'}</p>
                <label htmlFor="tv2-card-name">{ru ? 'Название карточки' : 'Card name'}
                  <input id="tv2-card-name" autoFocus maxLength={128} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
                </label>
                {error && <p className="login-error" role="alert">{error}</p>}
                <div>
                  <button type="button" disabled={busy} onClick={closeDialog}>{ru ? 'Отмена' : 'Cancel'}</button>
                  <button type="button" className="documents-primary" disabled={busy || !displayName.trim()} onClick={() => void perform('RENAME', dialog.card)}>{ru ? 'Сохранить' : 'Save'}</button>
                </div>
              </>
            ) : (
              <>
                <h2 id="tv2-card-dialog-title">{dialog.kind === 'trash' ? (ru ? 'Переместить в корзину?' : 'Move to trash?') : (ru ? 'Удалить карточку окончательно?' : 'Permanently remove card?')}</h2>
                <p><strong>{defaultCardName(locale, dialog.card)}</strong> · {dialog.card.siteName}</p>
                <p>
                  {dialog.kind === 'trash'
                    ? (ru ? 'Карточка исчезнет из табеля за этот месяц. Исходные смены и часы сохранятся.' : 'The card will be hidden from this month’s timesheet. Source shifts and hours will be kept.')
                    : (ru ? 'Карточка исчезнет из списка и корзины. Исходные смены, часы и расчётные данные сохранятся. Это действие нельзя отменить.' : 'The card will disappear from the list and trash. Source shifts, hours, and payroll data will be kept. This cannot be undone.')}
                </p>
                {error && <p className="login-error" role="alert">{error}</p>}
                <div>
                  <button type="button" disabled={busy} onClick={closeDialog}>{ru ? 'Отмена' : 'Cancel'}</button>
                  <button
                    type="button"
                    className={dialog.kind === 'permanent-delete' ? 'documents-primary tv2-danger-button' : 'documents-primary'}
                    disabled={busy}
                    onClick={() => void perform(dialog.kind === 'trash' ? 'TRASH' : 'DELETE', dialog.card, dialog.kind === 'permanent-delete')}
                  >
                    {busy ? (ru ? 'Подождите…' : 'Working…') : dialog.kind === 'trash' ? (ru ? 'В корзину' : 'Move to trash') : (ru ? 'Удалить окончательно' : 'Delete permanently')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
