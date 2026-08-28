'use client';

import { useEffect, useState, type FormEvent, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';
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

export interface AdminWorkerProfileFormProps {
  employeeId: string;
  initialProfile: EmployeeProfileView;
}

export function AdminWorkerProfileForm({ employeeId, initialProfile }: AdminWorkerProfileFormProps) {
  const router = useRouter();
  const locale = useAppLocale();

  const [version, setVersion] = useState(initialProfile.version);
  const [dateOfBirth, setDateOfBirth] = useState(initialProfile.dateOfBirth ?? '');
  const [specialty, setSpecialty] = useState(initialProfile.specialty ?? '');
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
  const [photoBusy, setPhotoBusy] = useState(false);
  const [qualifications, setQualifications] = useState(initialProfile.qualifications);
  const [contract, setContract] = useState(initialProfile.contract);
  const [contractBusy, setContractBusy] = useState(false);

  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

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
    const response = await fetch(`/api/admin/workers/${employeeId}/profile`, { credentials: 'same-origin' });
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
      const response = await fetch(`/api/admin/workers/${employeeId}/profile`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({
          version,
          dateOfBirth: dateOfBirth === '' ? null : dateOfBirth,
          specialty: specialty.trim() === '' ? null : specialty.trim(),
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
          setErrorMessage(localeText(locale, 'This profile changed elsewhere — reload the page and try again.', 'Профиль изменён в другом месте — обновите страницу и попробуйте снова.'));
        } else if (body?.error?.code === 'PERSONAL_DATA_ENCRYPTION_UNAVAILABLE') {
          setErrorMessage(
            localeText(
              locale,
              "The personal identity code can't be saved — secure storage (PERSONAL_DATA_ENCRYPTION_KEY) isn't configured on the server. Contact the system administrator.",
              'Личный идентификационный код нельзя сохранить — на сервере не настроено защищённое хранилище (PERSONAL_DATA_ENCRYPTION_KEY). Сообщите системному администратору.'
            )
          );
        } else if (body?.error?.fieldErrors) {
          setFieldErrors(body.error.fieldErrors);
        } else {
          setErrorMessage(localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
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
      setSavedMessage(localeText(locale, 'Saved.', 'Сохранено.'));
      router.refresh();
    } catch {
      setErrorMessage(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
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
      const response = await fetch(`/api/admin/workers/${employeeId}/profile/personal-identity-code`, { credentials: 'same-origin' });
      if (response.ok) {
        const body = await response.json();
        setPersonalIdentityCodeRevealed(body.value);
      }
    } finally {
      setPersonalIdentityCodeRevealBusy(false);
    }
  }

  async function handlePhotoChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || photoBusy) return;
    setPhotoBusy(true);
    setErrorMessage(null);
    try {
      const formData = new FormData();
      formData.set('photo', file);
      const response = await fetch(`/api/admin/workers/${employeeId}/profile/photo`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': CSRF_HEADER_VALUE },
        body: formData
      });
      if (!response.ok) {
        setErrorMessage(localeText(locale, 'Unsupported or too large photo.', 'Неподдерживаемое или слишком большое фото.'));
        return;
      }
      setHasPhoto(true);
      setPhotoVersion((v) => v + 1);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleRemovePhoto(): Promise<void> {
    if (photoBusy) return;
    setPhotoBusy(true);
    try {
      await fetch(`/api/admin/workers/${employeeId}/profile/photo`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-Requested-With': CSRF_HEADER_VALUE } });
      setHasPhoto(false);
      setPhotoVersion((v) => v + 1);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleContractChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || contractBusy) return;
    setContractBusy(true);
    setErrorMessage(null);
    try {
      const formData = new FormData();
      formData.set('contract', file);
      const response = await fetch(`/api/admin/workers/${employeeId}/profile/contract`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': CSRF_HEADER_VALUE, 'Idempotency-Key': crypto.randomUUID() },
        body: formData
      });
      if (!response.ok) {
        setErrorMessage(localeText(locale, 'Unsupported or too large file.', 'Неподдерживаемый или слишком большой файл.'));
        return;
      }
      setContract({ uploadedAt: new Date().toISOString(), uploadedByUsername: null });
    } finally {
      setContractBusy(false);
    }
  }

  async function handleRemoveContract(): Promise<void> {
    if (contractBusy) return;
    setContractBusy(true);
    try {
      await fetch(`/api/admin/workers/${employeeId}/profile/contract`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-Requested-With': CSRF_HEADER_VALUE } });
      setContract(null);
    } finally {
      setContractBusy(false);
    }
  }

  async function handleAddQualification(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const isOther = qDefinitionId === '';
    if (qBusy || (isOther && qName.trim().length === 0)) return;
    if (expiresOnRequired && !qExpiresOn) {
      setQError(localeText(locale, 'This qualification requires an expiry date.', 'Для этой квалификации нужно указать срок действия.'));
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
      const response = await fetch(`/api/admin/workers/${employeeId}/profile/qualifications`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': CSRF_HEADER_VALUE, 'Idempotency-Key': crypto.randomUUID() },
        body: formData
      });
      if (!response.ok) {
        setQError(localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
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
      setQError(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
    } finally {
      setQBusy(false);
    }
  }

  async function handleDeleteQualification(id: string): Promise<void> {
    setQualifications((prev) => prev.filter((q) => q.id !== id));
    await fetch(`/api/admin/workers/${employeeId}/profile/qualifications/${id}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-Requested-With': CSRF_HEADER_VALUE } });
  }

  return (
    <div>
      <section className="worker-work-setup">
        <h2>{localeText(locale, 'Photo', 'Фото')}</h2>
        {hasPhoto ? (
          <img src={`/api/admin/workers/${employeeId}/profile/photo?v=${photoVersion}`} alt="" width={120} height={120} style={{ borderRadius: 12, objectFit: 'cover' }} />
        ) : (
          <p className="wk-empty">{localeText(locale, 'No photo uploaded.', 'Фото не загружено.')}</p>
        )}
        <div className="wk-menu-language" style={{ marginTop: 8 }}>
          <label className="setup-action" style={{ cursor: 'pointer' }}>
            {photoBusy ? localeText(locale, 'Uploading…', 'Загрузка…') : localeText(locale, 'Upload photo', 'Загрузить фото')}
            <input type="file" accept="image/jpeg,image/png" onChange={handlePhotoChange} disabled={photoBusy} style={{ display: 'none' }} />
          </label>
          {hasPhoto ? (
            <button type="button" className="wk-clock-cancel-button" onClick={handleRemovePhoto} disabled={photoBusy}>
              {localeText(locale, 'Remove photo', 'Удалить фото')}
            </button>
          ) : null}
        </div>
      </section>

      <form onSubmit={handleSave} className="worker-work-setup" aria-busy={saving}>
        <div className="login-field">
          <label htmlFor="admin-profile-specialty">{localeText(locale, 'Specialty (free text, legacy)', 'Специальность (свободный текст, устар.)')}</label>
          <input id="admin-profile-specialty" type="text" maxLength={120} value={specialty} onChange={(e) => setSpecialty(e.target.value)} disabled={saving} />
          <p className="setup-subtitle">{localeText(locale, 'Use the Professions block above instead — this stays only for old records.', 'Используйте блок «Профессии» выше — это поле осталось только для старых записей.')}</p>
          {fieldErrors.specialty ? <p className="field-error">{fieldErrors.specialty.join(', ')}</p> : null}
        </div>
        <div className="login-field">
          <label htmlFor="admin-profile-skills">{localeText(locale, 'Skills', 'Навыки')}</label>
          <textarea id="admin-profile-skills" maxLength={2000} value={skills} onChange={(e) => setSkills(e.target.value)} disabled={saving} />
          {fieldErrors.skills ? <p className="field-error">{fieldErrors.skills.join(', ')}</p> : null}
        </div>
        <div className="login-field">
          <label htmlFor="admin-profile-date-of-birth">{localeText(locale, 'Date of birth', 'Дата рождения')}</label>
          <input id="admin-profile-date-of-birth" type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} disabled={saving} />
          {fieldErrors.dateOfBirth ? <p className="field-error">{fieldErrors.dateOfBirth.join(', ')}</p> : null}
        </div>
        <div className="login-field" id="admin-profile-personal-identity-code-field">
          <label htmlFor="admin-profile-personal-identity-code">{localeText(locale, 'Personal identity code', 'Личный идентификационный код')}</label>
          {personalIdentityCodeEditing ? (
            <input
              id="admin-profile-personal-identity-code"
              type="text"
              placeholder={hasPersonalIdentityCode ? `••••••-••••${personalIdentityCodeLast4 ?? ''}` : ''}
              value={personalIdentityCodeInput}
              onChange={(e) => setPersonalIdentityCodeInput(e.target.value)}
              disabled={saving}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{hasPersonalIdentityCode ? (personalIdentityCodeRevealed ?? `••••••-••••${personalIdentityCodeLast4 ?? ''}`) : localeText(locale, 'Not set', 'Не указан')}</span>
              {hasPersonalIdentityCode ? (
                <button type="button" className="wk-inline-secondary" onClick={handleRevealPersonalIdentityCode} disabled={personalIdentityCodeRevealBusy}>
                  {personalIdentityCodeRevealed !== null ? localeText(locale, 'Hide', 'Скрыть') : localeText(locale, 'Show', 'Показать')}
                </button>
              ) : null}
              <button type="button" className="wk-inline-secondary" onClick={() => setPersonalIdentityCodeEditing(true)}>
                {hasPersonalIdentityCode ? localeText(locale, 'Change', 'Изменить') : localeText(locale, 'Set', 'Указать')}
              </button>
            </div>
          )}
          {fieldErrors.personalIdentityCode ? <p className="field-error">{localeText(locale, 'Invalid personal identity code', 'Некорректный личный идентификационный код')}</p> : null}
        </div>
        <div className="login-field">
          <label htmlFor="admin-profile-contact-email">{localeText(locale, 'Contact email', 'Контактный email')}</label>
          <input id="admin-profile-contact-email" type="email" maxLength={255} value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} disabled={saving} />
          {fieldErrors.contactEmail ? <p className="field-error">{localeText(locale, 'Invalid email', 'Некорректный email')}</p> : null}
        </div>
        <div className="login-field">
          <label htmlFor="admin-profile-address-street">{localeText(locale, 'Street address', 'Улица, дом')}</label>
          <input id="admin-profile-address-street" type="text" maxLength={255} value={addressStreet} onChange={(e) => setAddressStreet(e.target.value)} disabled={saving} />
        </div>
        <div className="login-field">
          <label htmlFor="admin-profile-address-postal-code">{localeText(locale, 'Postal code', 'Почтовый индекс')}</label>
          <input id="admin-profile-address-postal-code" type="text" maxLength={32} value={addressPostalCode} onChange={(e) => setAddressPostalCode(e.target.value)} disabled={saving} />
        </div>
        <div className="login-field">
          <label htmlFor="admin-profile-address-city">{localeText(locale, 'City', 'Город')}</label>
          <input id="admin-profile-address-city" type="text" maxLength={120} value={addressCity} onChange={(e) => setAddressCity(e.target.value)} disabled={saving} />
        </div>
        <div className="login-field">
          <label htmlFor="admin-profile-address-country">{localeText(locale, 'Country', 'Страна')}</label>
          <input id="admin-profile-address-country" type="text" maxLength={120} value={addressCountry} onChange={(e) => setAddressCountry(e.target.value)} disabled={saving} />
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
          {saving ? localeText(locale, 'Saving…', 'Сохранение…') : localeText(locale, 'Save', 'Сохранить')}
        </button>
      </form>

      <section className="worker-work-setup">
        <h2>{localeText(locale, 'Contract', 'Договор')}</h2>
        {contract ? (
          <div className="setup-item setup-item-column">
            <a href={`/api/admin/workers/${employeeId}/profile/contract`} target="_blank" rel="noreferrer">
              {localeText(locale, 'Download contract', 'Скачать договор')}
            </a>
            <span className="setup-subtitle">
              {localeText(locale, 'Uploaded', 'Загружено')} {new Date(contract.uploadedAt).toLocaleDateString(locale === 'RU' ? 'ru-RU' : 'en-GB')}
              {contract.uploadedByUsername ? ` · ${contract.uploadedByUsername}` : ''}
            </span>
            <button type="button" className="wk-clock-cancel-button" onClick={handleRemoveContract} disabled={contractBusy}>
              {localeText(locale, 'Remove contract', 'Удалить договор')}
            </button>
          </div>
        ) : (
          <p className="wk-empty">{localeText(locale, 'No contract attached yet.', 'Договор ещё не прикреплён.')}</p>
        )}
        <label className="setup-action" style={{ cursor: 'pointer', display: 'inline-block', marginTop: 8 }}>
          {contractBusy ? localeText(locale, 'Uploading…', 'Загрузка…') : localeText(locale, 'Attach / replace contract', 'Прикрепить / заменить договор')}
          <input type="file" accept="image/jpeg,image/png,application/pdf" onChange={handleContractChange} disabled={contractBusy} style={{ display: 'none' }} />
        </label>
      </section>

      <section id="qualifications" className="worker-work-setup">
        <h2>{localeText(locale, 'Qualification cards', 'Карточки квалификации')}</h2>
        {qualifications.length === 0 ? (
          <p className="wk-empty">{localeText(locale, 'No cards yet.', 'Карточек пока нет.')}</p>
        ) : (
          <ul className="setup-list">
            {qualifications.map((q) => (
              <QualificationCard
                key={q.id}
                qualification={q}
                locale={locale}
                isAdmin
                apiBase={`/api/admin/workers/${employeeId}/profile/qualifications/${q.id}`}
                onChanged={refetchQualifications}
                onDeleted={() => handleDeleteQualification(q.id)}
              />
            ))}
          </ul>
        )}

        {addingQualification ? (
          <form onSubmit={handleAddQualification} aria-busy={qBusy}>
            <div className="login-field">
              <label htmlFor="admin-qualification-catalog">{localeText(locale, 'Qualification', 'Квалификация')}</label>
              <select id="admin-qualification-catalog" value={qDefinitionId} onChange={(e) => setQDefinitionId(e.target.value)} disabled={qBusy || catalog === null}>
                <option value="">{catalog === null ? localeText(locale, 'Loading…', 'Загрузка…') : localeText(locale, 'Other (custom)', 'Другое (свой вариант)')}</option>
                {catalog?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {locale === 'RU' ? c.nameRu : c.nameEn}
                  </option>
                ))}
              </select>
            </div>
            {qDefinitionId === '' ? (
              <div className="login-field">
                <label htmlFor="admin-qualification-name">{localeText(locale, 'Name', 'Название')}</label>
                <input id="admin-qualification-name" type="text" maxLength={120} value={qName} onChange={(e) => setQName(e.target.value)} disabled={qBusy} />
              </div>
            ) : null}
            <div className="login-field">
              <label htmlFor="admin-qualification-certificate-number">{localeText(locale, 'Certificate number', 'Номер сертификата')}</label>
              <input id="admin-qualification-certificate-number" type="text" maxLength={80} value={qCertificateNumber} onChange={(e) => setQCertificateNumber(e.target.value)} disabled={qBusy} />
            </div>
            <div className="login-field">
              <label htmlFor="admin-qualification-issuer">{localeText(locale, 'Issuer', 'Кем выдано')}</label>
              <input id="admin-qualification-issuer" type="text" maxLength={160} value={qIssuer} onChange={(e) => setQIssuer(e.target.value)} disabled={qBusy} />
            </div>
            <div className="login-field">
              <label htmlFor="admin-qualification-issued-on">{localeText(locale, 'Issued on', 'Дата выдачи')}</label>
              <input id="admin-qualification-issued-on" type="date" value={qIssuedOn} onChange={(e) => setQIssuedOn(e.target.value)} disabled={qBusy} />
            </div>
            <div className="login-field">
              <label htmlFor="admin-qualification-expiry">
                {localeText(locale, 'Valid until', 'Действует до')}
                {expiresOnRequired ? ' *' : ''}
              </label>
              <input id="admin-qualification-expiry" type="date" value={qExpiresOn} onChange={(e) => setQExpiresOn(e.target.value)} disabled={qBusy} required={expiresOnRequired} />
            </div>
            <div className="login-field">
              <label htmlFor="admin-qualification-photo">{localeText(locale, 'Photo (optional)', 'Фото (необязательно)')}</label>
              <input id="admin-qualification-photo" type="file" accept="image/jpeg,image/png" onChange={(e) => setQPhoto(e.target.files?.[0] ?? null)} disabled={qBusy} />
            </div>
            {qError ? (
              <p className="login-error" role="alert">
                {qError}
              </p>
            ) : null}
            <div className="wk-switch-actions">
              <button type="submit" className="login-submit" disabled={qBusy || (qDefinitionId === '' && qName.trim().length === 0)}>
                {qBusy ? localeText(locale, 'Adding…', 'Добавление…') : localeText(locale, 'Add card', 'Добавить карточку')}
              </button>
              <button type="button" className="wk-clock-cancel-button" onClick={() => setAddingQualification(false)} disabled={qBusy}>
                {localeText(locale, 'Cancel', 'Отмена')}
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="wk-inline-secondary" onClick={() => setAddingQualification(true)}>
            + {localeText(locale, 'Add card', 'Добавить карточку')}
          </button>
        )}
      </section>

      <section className="worker-work-setup">
        <h2>{localeText(locale, 'Dossier export', 'Экспорт досье')}</h2>
        <a className="login-submit" style={{ display: 'inline-block', textAlign: 'center', textDecoration: 'none' }} href={`/api/admin/workers/${employeeId}/dossier`} target="_blank" rel="noreferrer">
          {localeText(locale, 'Download dossier', 'Скачать досье')}
        </a>
      </section>
    </div>
  );
}
