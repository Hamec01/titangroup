'use client';

import { useState, type FormEvent } from 'react';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';
import type { EmployeeProfessionView, ProfessionCatalogGroup } from '@/lib/professions';

const CSRF_HEADER_VALUE = 'titanor-time';
// Sentinel value for the "type your own" entry at the bottom of the profession <select>.
const OTHER_OPTION = '__other__';

const CATEGORY_LABEL: Record<'SHIPBUILDING' | 'CONSTRUCTION', { en: string; ru: string }> = {
  SHIPBUILDING: { en: 'Shipbuilding', ru: 'Судостроение' },
  CONSTRUCTION: { en: 'Construction', ru: 'Строительство' }
};

// T13.3 — profession block on the admin worker profile page. A profession is a trade / speciality;
// it is not a certificate and grants no access. Catalog pick or a free "Other" entry, one worker
// many professions, no duplicates (server enforces; a duplicate shows a plain message).
// T15.2 — the same component is reused on the worker's own /worker/profile: pass `apiBase`
// (`/api/worker/professions`) and `ownProfile` so the wording is "your professions".
export function EmployeeProfessionsEditor({
  employeeId,
  initialProfessions,
  catalog,
  apiBase,
  ownProfile = false
}: {
  employeeId: string;
  initialProfessions: EmployeeProfessionView[];
  catalog: ProfessionCatalogGroup[];
  apiBase?: string;
  ownProfile?: boolean;
}) {
  const locale = useAppLocale();
  const ru = locale === 'RU';
  const listUrl = apiBase ?? `/api/admin/workers/${employeeId}/professions`;
  const removeUrl = (id: string) => `${listUrl}/${id}`;

  const [items, setItems] = useState(initialProfessions);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<'CATALOG' | 'OTHER'>('CATALOG');
  const [definitionId, setDefinitionId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customCategory, setCustomCategory] = useState<'SHIPBUILDING' | 'CONSTRUCTION'>('SHIPBUILDING');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetForm() {
    setDefinitionId('');
    setCustomName('');
    setCustomCategory('SHIPBUILDING');
    setMode('CATALOG');
    setError(null);
  }

  async function reload() {
    const r = await fetch(listUrl, { credentials: 'same-origin' });
    if (r.ok) {
      const body = await r.json();
      setItems(body.items ?? []);
    }
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (mode === 'CATALOG' && !definitionId) {
      setError(localeText(locale, 'Choose a profession.', 'Выберите профессию.'));
      return;
    }
    if (mode === 'OTHER' && customName.trim().length === 0) {
      setError(localeText(locale, 'Enter a profession name.', 'Введите название профессии.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'CATALOG' ? { definitionId } : { customName: customName.trim(), customCategory };
      const r = await fetch(listUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body)
      });
      const resBody = await r.json().catch(() => null);
      if (!r.ok) {
        if (resBody?.error?.code === 'PROFESSION_ALREADY_ADDED') {
          setError(
            ownProfile
              ? localeText(locale, 'You already have that profession.', 'У вас уже есть эта профессия.')
              : localeText(locale, 'This worker already has that profession.', 'У работника уже есть эта профессия.')
          );
        } else {
          setError(localeText(locale, 'Could not add the profession. Try again.', 'Не удалось добавить профессию. Попробуйте ещё раз.'));
        }
        return;
      }
      await reload();
      resetForm();
      setAdding(false);
    } catch {
      setError(localeText(locale, 'Network error. Try again.', 'Ошибка сети. Попробуйте ещё раз.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(id: string) {
    setItems((prev) => prev.filter((p) => p.id !== id));
    await fetch(removeUrl(id), {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': CSRF_HEADER_VALUE }
    });
  }

  return (
    <section id="professions" className="worker-work-setup">
      <h2>{localeText(locale, 'Professions', 'Профессии')}</h2>
      <p className="setup-subtitle">
        {localeText(
          locale,
          'A trade / work speciality (Welder, Pipe fitter). Not a certificate — it grants no access.',
          'Рабочая специальность (Сварщик, Трубопроводчик). Это не сертификат и не даёт доступа.'
        )}
      </p>

      {items.length === 0 ? (
        <p className="wk-empty">{localeText(locale, 'No professions yet.', 'Профессий пока нет.')}</p>
      ) : (
        <ul className="setup-list">
          {items.map((p) => (
            <li key={p.id} className="setup-item">
              <span>
                {ru ? p.nameRu ?? p.nameEn : p.nameEn}
                <span className="setup-subtitle">
                  {' · '}
                  {ru ? CATEGORY_LABEL[p.category].ru : CATEGORY_LABEL[p.category].en}
                  {p.isCustom ? ` · ${localeText(locale, 'custom', 'своё')}` : ''}
                </span>
              </span>
              <button type="button" className="wk-clock-cancel-button" onClick={() => handleRemove(p.id)}>
                {localeText(locale, 'Remove', 'Убрать')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <form onSubmit={handleAdd} aria-busy={busy}>
          <div className="login-field">
            <label htmlFor="prof-catalog">{localeText(locale, 'Profession', 'Профессия')}</label>
            <select
              id="prof-catalog"
              value={mode === 'OTHER' ? OTHER_OPTION : definitionId}
              onChange={(e) => {
                if (e.target.value === OTHER_OPTION) {
                  setMode('OTHER');
                  setDefinitionId('');
                } else {
                  setMode('CATALOG');
                  setDefinitionId(e.target.value);
                }
              }}
              disabled={busy}
            >
              <option value="">{localeText(locale, '— choose —', '— выберите —')}</option>
              {catalog.map((group) => (
                <optgroup key={group.category} label={ru ? CATEGORY_LABEL[group.category].ru : CATEGORY_LABEL[group.category].en}>
                  {group.professions.map((prof) => (
                    <option key={prof.id} value={prof.id}>
                      {ru ? prof.nameRu : prof.nameEn}
                    </option>
                  ))}
                </optgroup>
              ))}
              <option value={OTHER_OPTION}>{localeText(locale, '✎ Other — type your own', '✎ Другая — вписать свою')}</option>
            </select>
          </div>

          {mode === 'OTHER' ? (
            <>
              <div className="login-field">
                <label htmlFor="prof-custom-name">{localeText(locale, 'Profession name', 'Название профессии')}</label>
                <input id="prof-custom-name" type="text" maxLength={120} autoFocus placeholder={localeText(locale, 'e.g. Rope access technician', 'например, Промышленный альпинист')} value={customName} onChange={(e) => setCustomName(e.target.value)} disabled={busy} />
              </div>
              <div className="login-field">
                <label htmlFor="prof-custom-category">{localeText(locale, 'Category', 'Категория')}</label>
                <select id="prof-custom-category" value={customCategory} onChange={(e) => setCustomCategory(e.target.value as 'SHIPBUILDING' | 'CONSTRUCTION')} disabled={busy}>
                  <option value="SHIPBUILDING">{localeText(locale, 'Shipbuilding', 'Судостроение')}</option>
                  <option value="CONSTRUCTION">{localeText(locale, 'Construction', 'Строительство')}</option>
                </select>
              </div>
            </>
          ) : null}

          {error ? (
            <p className="login-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="wk-switch-actions">
            <button type="submit" className="login-submit" disabled={busy}>
              {busy ? localeText(locale, 'Adding…', 'Добавление…') : localeText(locale, 'Add profession', 'Добавить профессию')}
            </button>
            <button
              type="button"
              className="wk-clock-cancel-button"
              onClick={() => {
                setAdding(false);
                resetForm();
              }}
              disabled={busy}
            >
              {localeText(locale, 'Cancel', 'Отмена')}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="wk-inline-secondary" onClick={() => setAdding(true)}>
          + {localeText(locale, 'Add profession', 'Добавить профессию')}
        </button>
      )}
    </section>
  );
}
