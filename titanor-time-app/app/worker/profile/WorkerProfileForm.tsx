'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { WORKER_STRINGS } from '@/lib/i18n/worker';
import type { EmployeeProfileView } from '@/lib/employee-profile';

const CSRF_HEADER_VALUE = 'titanor-time';

export interface WorkerProfileFormProps {
  initialProfile: EmployeeProfileView;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function WorkerProfileForm({ initialProfile }: WorkerProfileFormProps) {
  const router = useRouter();
  const locale = useAppLocale();
  const t = WORKER_STRINGS[locale];

  const [version, setVersion] = useState(initialProfile.version);
  const [dateOfBirth, setDateOfBirth] = useState(initialProfile.dateOfBirth ?? '');
  const [specialty, setSpecialty] = useState(initialProfile.specialty ?? '');
  const [skills, setSkills] = useState(initialProfile.skills ?? '');
  const [hasPhoto, setHasPhoto] = useState(initialProfile.hasPhoto);
  const [photoVersion, setPhotoVersion] = useState(0);
  const [qualifications, setQualifications] = useState(initialProfile.qualifications);

  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [photoBusy, setPhotoBusy] = useState(false);

  const [addingQualification, setAddingQualification] = useState(false);
  const [qName, setQName] = useState('');
  const [qExpiresOn, setQExpiresOn] = useState('');
  const [qPhoto, setQPhoto] = useState<File | null>(null);
  const [qBusy, setQBusy] = useState(false);
  const [qError, setQError] = useState<string | null>(null);

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSavedMessage(null);
    setErrorMessage(null);
    setFieldErrors({});
    try {
      const response = await fetch('/api/worker/profile', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({
          version,
          dateOfBirth: dateOfBirth === '' ? null : dateOfBirth,
          specialty: specialty.trim() === '' ? null : specialty.trim(),
          skills: skills.trim() === '' ? null : skills.trim()
        })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (body?.error?.code === 'VERSION_CONFLICT') {
          setErrorMessage(t.profileSaveErrorConflict);
        } else if (body?.error?.fieldErrors) {
          setFieldErrors(body.error.fieldErrors);
        } else {
          setErrorMessage(t.errActionNeedsAttention);
        }
        return;
      }
      setVersion(body.version);
      setSavedMessage(t.profileSaved);
      router.refresh();
    } catch {
      setErrorMessage(t.errCouldNotReachServer);
    } finally {
      setSaving(false);
    }
  }

  async function handlePhotoChange(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || photoBusy) return;
    setPhotoBusy(true);
    setErrorMessage(null);
    try {
      const formData = new FormData();
      formData.set('photo', file);
      const response = await fetch('/api/worker/profile/photo', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': CSRF_HEADER_VALUE },
        body: formData
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setErrorMessage(body?.error?.code === 'TOO_LARGE' ? t.profilePhotoTooLarge : t.profileUnsupportedPhotoType);
        return;
      }
      setHasPhoto(true);
      setPhotoVersion((v) => v + 1);
    } catch {
      setErrorMessage(t.errCouldNotReachServer);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleRemovePhoto(): Promise<void> {
    if (photoBusy) return;
    setPhotoBusy(true);
    try {
      await fetch('/api/worker/profile/photo', { method: 'DELETE', credentials: 'same-origin', headers: { 'X-Requested-With': CSRF_HEADER_VALUE } });
      setHasPhoto(false);
      setPhotoVersion((v) => v + 1);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleAddQualification(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (qBusy || qName.trim().length === 0) return;
    setQBusy(true);
    setQError(null);
    try {
      const formData = new FormData();
      formData.set('name', qName.trim());
      if (qExpiresOn) formData.set('expiresOn', qExpiresOn);
      if (qPhoto) formData.set('photo', qPhoto);
      const response = await fetch('/api/worker/profile/qualifications', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': CSRF_HEADER_VALUE, 'Idempotency-Key': crypto.randomUUID() },
        body: formData
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setQError(body?.error?.code === 'UNSUPPORTED_TYPE' ? t.profileUnsupportedPhotoType : body?.error?.code === 'TOO_LARGE' ? t.profilePhotoTooLarge : t.errActionNeedsAttention);
        return;
      }
      setQualifications((prev) => [{ id: body.id, name: qName.trim(), expiresOn: qExpiresOn || null, hasPhoto: Boolean(qPhoto), createdAt: new Date().toISOString() }, ...prev]);
      setQName('');
      setQExpiresOn('');
      setQPhoto(null);
      setAddingQualification(false);
    } catch {
      setQError(t.errCouldNotReachServer);
    } finally {
      setQBusy(false);
    }
  }

  async function handleDeleteQualification(id: string): Promise<void> {
    setQualifications((prev) => prev.filter((q) => q.id !== id));
    await fetch(`/api/worker/profile/qualifications/${id}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-Requested-With': CSRF_HEADER_VALUE } });
  }

  const today = todayKey();

  return (
    <div>
      <section className="worker-work-setup">
        <h2>{t.profilePhotoLabel}</h2>
        {hasPhoto ? (
          <img src={`/api/worker/profile/photo?v=${photoVersion}`} alt="" width={120} height={120} style={{ borderRadius: 12, objectFit: 'cover' }} />
        ) : (
          <p className="wk-empty">{t.profileNoPhoto}</p>
        )}
        <div className="wk-menu-language" style={{ marginTop: 8 }}>
          <label className="login-submit" style={{ display: 'inline-block', cursor: 'pointer', textAlign: 'center' }}>
            {photoBusy ? t.profileSaving : t.profileUploadPhoto}
            <input type="file" accept="image/jpeg,image/png" onChange={handlePhotoChange} disabled={photoBusy} style={{ display: 'none' }} />
          </label>
          {hasPhoto ? (
            <button type="button" className="wk-clock-cancel-button" onClick={handleRemovePhoto} disabled={photoBusy}>
              {t.profileRemovePhoto}
            </button>
          ) : null}
        </div>
      </section>

      <form onSubmit={handleSave} className="worker-work-setup" aria-busy={saving}>
        <div className="login-field">
          <label htmlFor="profile-specialty">{t.profileSpecialtyLabel}</label>
          <input id="profile-specialty" type="text" maxLength={120} placeholder={t.profileSpecialtyPlaceholder} value={specialty} onChange={(e) => setSpecialty(e.target.value)} disabled={saving} />
          {fieldErrors.specialty ? <p className="field-error">{fieldErrors.specialty.join(', ')}</p> : null}
        </div>
        <div className="login-field">
          <label htmlFor="profile-skills">{t.profileSkillsLabel}</label>
          <textarea id="profile-skills" maxLength={2000} placeholder={t.profileSkillsPlaceholder} value={skills} onChange={(e) => setSkills(e.target.value)} disabled={saving} />
          {fieldErrors.skills ? <p className="field-error">{fieldErrors.skills.join(', ')}</p> : null}
        </div>
        <div className="login-field">
          <label htmlFor="profile-date-of-birth">{t.profileDateOfBirthLabel}</label>
          <input id="profile-date-of-birth" type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} disabled={saving} />
          {fieldErrors.dateOfBirth ? <p className="field-error">{fieldErrors.dateOfBirth.join(', ')}</p> : null}
        </div>
        {errorMessage ? (
          <p className="login-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        {savedMessage ? (
          <p role="status" className="form-status">
            {savedMessage}
          </p>
        ) : null}
        <button type="submit" className="login-submit" disabled={saving}>
          {saving ? t.profileSaving : t.profileSaveButton}
        </button>
      </form>

      {initialProfile.contract ? (
        <section className="worker-work-setup">
          <h2>{t.contractTitle}</h2>
          <p>
            <a href="/api/worker/profile/contract" target="_blank" rel="noreferrer">
              {t.contractDownload}
            </a>
          </p>
        </section>
      ) : null}

      <section className="worker-work-setup">
        <h2>{t.qualificationsTitle}</h2>
        <p className="setup-subtitle">{t.qualificationsIntro}</p>

        {qualifications.length === 0 ? (
          <p className="wk-empty">{t.qualificationsEmpty}</p>
        ) : (
          <ul className="setup-list">
            {qualifications.map((q) => {
              const expired = q.expiresOn !== null && q.expiresOn < today;
              const expiringSoon = !expired && q.expiresOn !== null && q.expiresOn <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
              return (
                <li key={q.id} className="setup-item">
                  <span className="setup-label">
                    {q.name}
                    {q.expiresOn ? (
                      <span className={expired || expiringSoon ? 'field-error' : 'setup-subtitle'}> — {q.expiresOn}{expired ? ` (${t.qualificationExpired})` : expiringSoon ? ` (${t.qualificationExpiringSoon})` : ''}</span>
                    ) : null}
                  </span>
                  <button type="button" className="wk-clock-cancel-button" onClick={() => handleDeleteQualification(q.id)}>
                    {t.qualificationDeleteButton}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {addingQualification ? (
          <form onSubmit={handleAddQualification} aria-busy={qBusy}>
            <div className="login-field">
              <label htmlFor="qualification-name">{t.qualificationNameLabel}</label>
              <input id="qualification-name" type="text" maxLength={120} placeholder={t.qualificationNamePlaceholder} value={qName} onChange={(e) => setQName(e.target.value)} disabled={qBusy} />
            </div>
            <div className="login-field">
              <label htmlFor="qualification-expiry">{t.qualificationExpiryLabel}</label>
              <input id="qualification-expiry" type="date" value={qExpiresOn} onChange={(e) => setQExpiresOn(e.target.value)} disabled={qBusy} />
            </div>
            <div className="login-field">
              <label htmlFor="qualification-photo">{t.qualificationPhotoLabel}</label>
              <input id="qualification-photo" type="file" accept="image/jpeg,image/png" onChange={(e) => setQPhoto(e.target.files?.[0] ?? null)} disabled={qBusy} />
            </div>
            {qError ? (
              <p className="login-error" role="alert">
                {qError}
              </p>
            ) : null}
            <div className="wk-switch-actions">
              <button type="submit" className="login-submit" disabled={qBusy || qName.trim().length === 0}>
                {qBusy ? t.qualificationAdding : t.qualificationAddButton}
              </button>
              <button type="button" className="wk-clock-cancel-button" onClick={() => setAddingQualification(false)} disabled={qBusy}>
                {t.cancel}
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="wk-inline-secondary" onClick={() => setAddingQualification(true)}>
            + {t.qualificationAddButton}
          </button>
        )}
      </section>
    </div>
  );
}
