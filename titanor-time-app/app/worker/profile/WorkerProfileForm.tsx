'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { WORKER_STRINGS } from '@/lib/i18n/worker';
import type { EmployeeProfileView } from '@/lib/employee-profile';
import { QualificationCard } from '@/components/qualifications/QualificationCard';

const CSRF_HEADER_VALUE = 'titanor-time';

interface CatalogEntry {
  id: string;
  code: string;
  nameEn: string;
  nameRu: string;
  expiryMode: 'REQUIRED' | 'OPTIONAL' | 'NONE';
}

export interface WorkerProfileFormProps {
  initialProfile: EmployeeProfileView;
}

export function WorkerProfileForm({ initialProfile }: WorkerProfileFormProps) {
  const router = useRouter();
  const locale = useAppLocale();
  const t = WORKER_STRINGS[locale];

  const [version, setVersion] = useState(initialProfile.version);
  const [dateOfBirth, setDateOfBirth] = useState(initialProfile.dateOfBirth ?? '');
  const [skills, setSkills] = useState(initialProfile.skills ?? '');
  const [contactEmail, setContactEmail] = useState(initialProfile.contactEmail ?? '');
  const [addressStreet, setAddressStreet] = useState(initialProfile.addressStreet ?? '');
  const [addressPostalCode, setAddressPostalCode] = useState(initialProfile.addressPostalCode ?? '');
  const [addressCity, setAddressCity] = useState(initialProfile.addressCity ?? '');
  const [addressCountry, setAddressCountry] = useState(initialProfile.addressCountry ?? '');
  const [hasPersonalIdentityCode, setHasPersonalIdentityCode] = useState(initialProfile.hasPersonalIdentityCode);
  const [personalIdentityCodeLast4] = useState(initialProfile.personalIdentityCodeLast4);
  const [personalIdentityCodeInput, setPersonalIdentityCodeInput] = useState('');
  const [personalIdentityCodeEditing, setPersonalIdentityCodeEditing] = useState(false);
  const [personalIdentityCodeRevealed, setPersonalIdentityCodeRevealed] = useState<string | null>(null);
  const [personalIdentityCodeRevealBusy, setPersonalIdentityCodeRevealBusy] = useState(false);
  const [hasPhoto, setHasPhoto] = useState(initialProfile.hasPhoto);
  const [photoVersion, setPhotoVersion] = useState(0);
  const [qualifications, setQualifications] = useState(initialProfile.qualifications);

  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [photoBusy, setPhotoBusy] = useState(false);

  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [addingQualification, setAddingQualification] = useState(false);
  const [qDefinitionId, setQDefinitionId] = useState('');
  const [qName, setQName] = useState('');
  const [qCertificateNumber, setQCertificateNumber] = useState('');
  const [qIssuer, setQIssuer] = useState('');
  const [qIssuedOn, setQIssuedOn] = useState('');
  const [qExpiresOn, setQExpiresOn] = useState('');
  const [qPhoto, setQPhoto] = useState<File | null>(null);
  const [qBusy, setQBusy] = useState(false);
  const [qError, setQError] = useState<string | null>(null);

  useEffect(() => {
    if (!addingQualification || catalog !== null) return;
    fetch('/api/qualification-definitions', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((body) => setCatalog(body.items ?? []))
      .catch(() => setCatalog([]));
  }, [addingQualification, catalog]);

  const selectedDefinition = catalog?.find((c) => c.id === qDefinitionId) ?? null;
  const expiresOnRequired = selectedDefinition ? selectedDefinition.expiryMode === 'REQUIRED' : false;

  async function refetchQualifications(): Promise<void> {
    const response = await fetch('/api/worker/profile', { credentials: 'same-origin' });
    if (!response.ok) return;
    const body = await response.json();
    setQualifications(body.qualifications ?? []);
  }

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
          // T16 — the legacy free-text `specialty` field is no longer editable in the worker app
          // (replaced by the multi-select "Профессии" block); a partial PATCH just omits it, so
          // any admin-set legacy value is preserved.
          skills: skills.trim() === '' ? null : skills.trim(),
          contactEmail: contactEmail.trim() === '' ? null : contactEmail.trim(),
          addressStreet: addressStreet.trim() === '' ? null : addressStreet.trim(),
          addressPostalCode: addressPostalCode.trim() === '' ? null : addressPostalCode.trim(),
          addressCity: addressCity.trim() === '' ? null : addressCity.trim(),
          addressCountry: addressCountry.trim() === '' ? null : addressCountry.trim(),
          ...(personalIdentityCodeEditing ? { personalIdentityCode: personalIdentityCodeInput.trim() === '' ? null : personalIdentityCodeInput.trim() } : {})
        })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (body?.error?.code === 'VERSION_CONFLICT') {
          setErrorMessage(t.profileSaveErrorConflict);
        } else if (body?.error?.code === 'PERSONAL_DATA_ENCRYPTION_UNAVAILABLE') {
          setErrorMessage(t.profileSaveErrorEncryptionUnavailable);
        } else if (body?.error?.fieldErrors) {
          setFieldErrors(body.error.fieldErrors);
        } else {
          setErrorMessage(t.errActionNeedsAttention);
        }
        return;
      }
      setVersion(body.version);
      if (personalIdentityCodeEditing) {
        setHasPersonalIdentityCode(personalIdentityCodeInput.trim() !== '');
        setPersonalIdentityCodeEditing(false);
        setPersonalIdentityCodeInput('');
        setPersonalIdentityCodeRevealed(null);
      }
      setSavedMessage(t.profileSaved);
      router.refresh();
    } catch {
      setErrorMessage(t.errCouldNotReachServer);
    } finally {
      setSaving(false);
    }
  }

  async function handleRevealPersonalIdentityCode(): Promise<void> {
    if (personalIdentityCodeRevealBusy) return;
    if (personalIdentityCodeRevealed !== null) {
      setPersonalIdentityCodeRevealed(null);
      return;
    }
    setPersonalIdentityCodeRevealBusy(true);
    try {
      const response = await fetch('/api/worker/profile/personal-identity-code', { credentials: 'same-origin' });
      if (response.ok) {
        const body = await response.json();
        setPersonalIdentityCodeRevealed(body.value);
      }
    } finally {
      setPersonalIdentityCodeRevealBusy(false);
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
    const isOther = qDefinitionId === '';
    if (qBusy || (isOther && qName.trim().length === 0)) return;
    if (expiresOnRequired && !qExpiresOn) {
      setQError(t.qualificationExpiresOnRequired);
      return;
    }
    setQBusy(true);
    setQError(null);
    try {
      const formData = new FormData();
      if (!isOther) formData.set('definitionId', qDefinitionId);
      if (isOther) formData.set('name', qName.trim());
      if (qCertificateNumber.trim()) formData.set('certificateNumber', qCertificateNumber.trim());
      if (qIssuer.trim()) formData.set('issuer', qIssuer.trim());
      if (qIssuedOn) formData.set('issuedOn', qIssuedOn);
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
      await refetchQualifications();
      setQDefinitionId('');
      setQName('');
      setQCertificateNumber('');
      setQIssuer('');
      setQIssuedOn('');
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
          <label htmlFor="profile-skills">{t.profileSkillsLabel}</label>
          <textarea id="profile-skills" maxLength={2000} placeholder={t.profileSkillsPlaceholder} value={skills} onChange={(e) => setSkills(e.target.value)} disabled={saving} />
          {fieldErrors.skills ? <p className="field-error">{fieldErrors.skills.join(', ')}</p> : null}
        </div>
        <div className="login-field">
          <label htmlFor="profile-date-of-birth">{t.profileDateOfBirthLabel}</label>
          <input id="profile-date-of-birth" type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} disabled={saving} />
          {fieldErrors.dateOfBirth ? <p className="field-error">{fieldErrors.dateOfBirth.join(', ')}</p> : null}
        </div>
        <div className="login-field" id="profile-personal-identity-code-field">
          <label htmlFor="profile-personal-identity-code">{t.profilePersonalIdentityCodeLabel}</label>
          {personalIdentityCodeEditing ? (
            <input
              id="profile-personal-identity-code"
              type="text"
              placeholder={hasPersonalIdentityCode ? `••••••-••••${personalIdentityCodeLast4 ?? ''}` : ''}
              value={personalIdentityCodeInput}
              onChange={(e) => setPersonalIdentityCodeInput(e.target.value)}
              disabled={saving}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{hasPersonalIdentityCode ? (personalIdentityCodeRevealed ?? `••••••-••••${personalIdentityCodeLast4 ?? ''}`) : t.profilePersonalIdentityCodeNotSet}</span>
              {hasPersonalIdentityCode ? (
                <button type="button" className="wk-inline-secondary" onClick={handleRevealPersonalIdentityCode} disabled={personalIdentityCodeRevealBusy}>
                  {personalIdentityCodeRevealed !== null ? t.profilePersonalIdentityCodeHide : t.profilePersonalIdentityCodeShow}
                </button>
              ) : null}
              <button type="button" className="wk-inline-secondary" onClick={() => setPersonalIdentityCodeEditing(true)}>
                {t.qualificationEditButton}
              </button>
            </div>
          )}
          {fieldErrors.personalIdentityCode ? <p className="field-error">{t.profilePersonalIdentityCodeInvalid}</p> : null}
        </div>
        <div className="login-field">
          <label htmlFor="profile-contact-email">{t.profileContactEmailLabel}</label>
          <input id="profile-contact-email" type="email" maxLength={255} value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} disabled={saving} />
          {fieldErrors.contactEmail ? <p className="field-error">{fieldErrors.contactEmail.join(', ')}</p> : null}
        </div>
        <div className="login-field">
          <label htmlFor="profile-address-street">{t.profileAddressStreetLabel}</label>
          <input id="profile-address-street" type="text" maxLength={255} value={addressStreet} onChange={(e) => setAddressStreet(e.target.value)} disabled={saving} />
        </div>
        <div className="login-field">
          <label htmlFor="profile-address-postal-code">{t.profileAddressPostalCodeLabel}</label>
          <input id="profile-address-postal-code" type="text" maxLength={32} value={addressPostalCode} onChange={(e) => setAddressPostalCode(e.target.value)} disabled={saving} />
        </div>
        <div className="login-field">
          <label htmlFor="profile-address-city">{t.profileAddressCityLabel}</label>
          <input id="profile-address-city" type="text" maxLength={120} value={addressCity} onChange={(e) => setAddressCity(e.target.value)} disabled={saving} />
        </div>
        <div className="login-field">
          <label htmlFor="profile-address-country">{t.profileAddressCountryLabel}</label>
          <input id="profile-address-country" type="text" maxLength={120} value={addressCountry} onChange={(e) => setAddressCountry(e.target.value)} disabled={saving} />
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
            {qualifications.map((q) => (
              <QualificationCard
                key={q.id}
                qualification={q}
                locale={locale}
                isAdmin={false}
                apiBase={`/api/worker/profile/qualifications/${q.id}`}
                onChanged={refetchQualifications}
                onDeleted={() => handleDeleteQualification(q.id)}
              />
            ))}
          </ul>
        )}

        {addingQualification ? (
          <form onSubmit={handleAddQualification} aria-busy={qBusy}>
            <div className="login-field">
              <label htmlFor="qualification-catalog">{t.qualificationCatalogLabel}</label>
              <select id="qualification-catalog" value={qDefinitionId} onChange={(e) => setQDefinitionId(e.target.value)} disabled={qBusy || catalog === null}>
                <option value="">{catalog === null ? t.qualificationCatalogLoading : t.qualificationCatalogOther}</option>
                {catalog?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {locale === 'RU' ? c.nameRu : c.nameEn}
                  </option>
                ))}
              </select>
            </div>
            {qDefinitionId === '' ? (
              <div className="login-field">
                <label htmlFor="qualification-name">{t.qualificationNameLabel}</label>
                <input id="qualification-name" type="text" maxLength={120} placeholder={t.qualificationNamePlaceholder} value={qName} onChange={(e) => setQName(e.target.value)} disabled={qBusy} />
              </div>
            ) : null}
            <div className="login-field">
              <label htmlFor="qualification-certificate-number">{t.qualificationCertificateNumberLabel}</label>
              <input id="qualification-certificate-number" type="text" maxLength={80} value={qCertificateNumber} onChange={(e) => setQCertificateNumber(e.target.value)} disabled={qBusy} />
            </div>
            <div className="login-field">
              <label htmlFor="qualification-issuer">{t.qualificationIssuerLabel}</label>
              <input id="qualification-issuer" type="text" maxLength={160} value={qIssuer} onChange={(e) => setQIssuer(e.target.value)} disabled={qBusy} />
            </div>
            <div className="login-field">
              <label htmlFor="qualification-issued-on">{t.qualificationIssuedOnLabel}</label>
              <input id="qualification-issued-on" type="date" value={qIssuedOn} onChange={(e) => setQIssuedOn(e.target.value)} disabled={qBusy} />
            </div>
            <div className="login-field">
              <label htmlFor="qualification-expiry">
                {t.qualificationExpiryLabel}
                {expiresOnRequired ? ' *' : ''}
              </label>
              <input id="qualification-expiry" type="date" value={qExpiresOn} onChange={(e) => setQExpiresOn(e.target.value)} disabled={qBusy} required={expiresOnRequired} />
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
              <button type="submit" className="login-submit" disabled={qBusy || (qDefinitionId === '' && qName.trim().length === 0)}>
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
