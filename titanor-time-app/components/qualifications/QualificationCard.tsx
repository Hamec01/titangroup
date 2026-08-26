'use client';

import { useState, type FormEvent } from 'react';
import { QualificationBadge, VerificationBadge } from '@/components/qualifications/QualificationBadge';
import type { EmployeeQualificationView } from '@/lib/employee-profile';

// Worker Dossier feature (2026-08-26, task spec §21) — a real credential card (thumbnail +
// metadata edit + independent photo lifecycle), replacing the plain <li> text rows both
// AdminWorkerProfileForm and WorkerProfileForm used to render inline. Self-contained: does its
// own fetch() calls against `apiBase` (which already has the qualification id baked in — the
// two callers differ only in that base path, admin vs worker-own) rather than threading a large
// callback prop bag through the parent forms.

const CSRF_HEADER_VALUE = 'titanor-time';

function tt(locale: 'EN' | 'RU', en: string, ru: string): string {
  return locale === 'RU' ? ru : en;
}

export interface QualificationCardProps {
  qualification: EmployeeQualificationView;
  locale: 'EN' | 'RU';
  isAdmin: boolean;
  /** Base URL for this one qualification, id already included — e.g.
   * `/api/admin/workers/{employeeId}/profile/qualifications/{id}` or
   * `/api/worker/profile/qualifications/{id}`. This component appends `/photo` itself. */
  apiBase: string;
  onChanged: () => void | Promise<void>;
  onDeleted: () => void;
}

export function QualificationCard({ qualification: q, locale, isAdmin, apiBase, onChanged, onDeleted }: QualificationCardProps) {
  const [hasPhoto, setHasPhoto] = useState(q.hasPhoto);
  const [photoVersion, setPhotoVersion] = useState(0);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [certificateNumber, setCertificateNumber] = useState(q.certificateNumber ?? '');
  const [issuer, setIssuer] = useState(q.issuer ?? '');
  const [issuedOn, setIssuedOn] = useState(q.issuedOn ?? '');
  const [expiresOn, setExpiresOn] = useState(q.expiresOn ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const displayName = locale === 'RU' && q.nameRu ? q.nameRu : q.name;

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch(apiBase, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({
          certificateNumber: certificateNumber.trim() || null,
          issuer: issuer.trim() || null,
          issuedOn: issuedOn || null,
          expiresOn: expiresOn || null
        })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setSaveError(body?.error?.fieldErrors ? Object.values(body.error.fieldErrors).flat().join(', ') : tt(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
        return;
      }
      setEditing(false);
      await onChanged();
    } catch {
      setSaveError(tt(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
    } finally {
      setSaving(false);
    }
  }

  async function handlePhotoChange(file: File | undefined): Promise<void> {
    if (!file || photoBusy) return;
    setPhotoBusy(true);
    try {
      const formData = new FormData();
      formData.set('photo', file);
      const response = await fetch(`${apiBase}/photo`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': CSRF_HEADER_VALUE },
        body: formData
      });
      if (response.ok) {
        setHasPhoto(true);
        setPhotoVersion((v) => v + 1);
      }
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleRemovePhoto(): Promise<void> {
    if (photoBusy) return;
    setPhotoBusy(true);
    try {
      await fetch(`${apiBase}/photo`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-Requested-With': CSRF_HEADER_VALUE } });
      setHasPhoto(false);
      setPhotoVersion((v) => v + 1);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleToggleVerification(verify: boolean): Promise<void> {
    if (verifyBusy) return;
    setVerifyBusy(true);
    try {
      const response = await fetch(apiBase, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ verify })
      });
      if (response.ok) await onChanged();
    } finally {
      setVerifyBusy(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (deleteBusy) return;
    setDeleteBusy(true);
    onDeleted();
    await fetch(apiBase, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-Requested-With': CSRF_HEADER_VALUE } });
  }

  return (
    <li className="setup-item setup-item-column qual-card">
      <div className="qual-card-head">
        <span className="setup-label">{displayName}</span>
        <QualificationBadge status={q.expiryStatus} color={q.expiryColor} locale={locale} />
        <VerificationBadge verified={q.verificationState === 'VERIFIED'} locale={locale} />
      </div>

      {hasPhoto ? (
        <img src={`${apiBase}/photo?v=${photoVersion}`} alt="" width={96} height={96} style={{ borderRadius: 8, objectFit: 'cover', marginTop: 6 }} />
      ) : null}

      {!editing ? (
        <>
          <span className="setup-subtitle">
            {q.certificateNumber ? `${tt(locale, 'Certificate number', 'Номер сертификата')}: ${q.certificateNumber}` : null}
            {q.issuer ? ` · ${tt(locale, 'Issuer', 'Кем выдано')}: ${q.issuer}` : null}
            {q.expiresOn ? ` · ${tt(locale, 'Valid until', 'Действует до')}: ${q.expiresOn}` : null}
          </span>
          <div className="qual-card-actions">
            <button type="button" className="setup-action" onClick={() => setEditing(true)}>
              {tt(locale, 'Edit', 'Изменить')}
            </button>
            <label className="setup-action" style={{ cursor: 'pointer' }}>
              {photoBusy ? tt(locale, 'Uploading…', 'Загрузка…') : hasPhoto ? tt(locale, 'Replace image', 'Заменить изображение') : tt(locale, 'Upload image', 'Загрузить изображение')}
              <input type="file" accept="image/jpeg,image/png" style={{ display: 'none' }} disabled={photoBusy} onChange={(e) => handlePhotoChange(e.target.files?.[0])} />
            </label>
            {hasPhoto ? (
              <button type="button" className="wk-clock-cancel-button" onClick={handleRemovePhoto} disabled={photoBusy}>
                {tt(locale, 'Remove image', 'Удалить изображение')}
              </button>
            ) : null}
            {isAdmin ? (
              q.verificationState === 'VERIFIED' ? (
                <button type="button" className="wk-clock-cancel-button" onClick={() => handleToggleVerification(false)} disabled={verifyBusy}>
                  {tt(locale, 'Remove verification', 'Снять подтверждение')}
                </button>
              ) : (
                <button type="button" className="setup-action" onClick={() => handleToggleVerification(true)} disabled={verifyBusy}>
                  {tt(locale, 'Verify', 'Подтвердить')}
                </button>
              )
            ) : null}
            <button type="button" className="wk-clock-cancel-button" onClick={handleDelete} disabled={deleteBusy}>
              {tt(locale, 'Delete', 'Удалить')}
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={handleSave} aria-busy={saving} style={{ marginTop: 8 }}>
          <div className="login-field">
            <label>{tt(locale, 'Certificate number', 'Номер сертификата')}</label>
            <input type="text" maxLength={80} value={certificateNumber} onChange={(e) => setCertificateNumber(e.target.value)} disabled={saving} />
          </div>
          <div className="login-field">
            <label>{tt(locale, 'Issuer', 'Кем выдано')}</label>
            <input type="text" maxLength={160} value={issuer} onChange={(e) => setIssuer(e.target.value)} disabled={saving} />
          </div>
          <div className="login-field">
            <label>{tt(locale, 'Issued on', 'Дата выдачи')}</label>
            <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} disabled={saving} />
          </div>
          <div className="login-field">
            <label>{tt(locale, 'Valid until', 'Действует до')}</label>
            <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} disabled={saving} />
          </div>
          {saveError ? (
            <p className="login-error" role="alert">
              {saveError}
            </p>
          ) : null}
          <div className="wk-switch-actions">
            <button type="submit" className="login-submit" disabled={saving}>
              {saving ? tt(locale, 'Saving…', 'Сохранение…') : tt(locale, 'Save', 'Сохранить')}
            </button>
            <button type="button" className="wk-clock-cancel-button" onClick={() => setEditing(false)} disabled={saving}>
              {tt(locale, 'Cancel', 'Отмена')}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
