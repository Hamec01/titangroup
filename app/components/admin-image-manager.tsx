'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { serviceSections, type ServiceSection } from '../../lib/service-sections';
import type { Vacancy } from '../../lib/vacancy-types';
import type { Locale } from '../i18n';

type StoredServiceImage = {
  url: string;
  publicId: string | null;
};

type StoredServiceImages = Record<ServiceSection, StoredServiceImage[]>;

type SelectedFiles = Partial<Record<ServiceSection, File>>;
type ContentByLocale = Record<Locale, Record<ServiceSection, string>>;
type PendingDeleteItem = StoredServiceImage & { section: ServiceSection };
type VacancyFormState = {
  role: string;
  location: string;
  duration: string;
  description: string;
  postedAt: string;
};

const sectionTitles: Record<ServiceSection, string> = {
  shipbuilding: 'Shipbuilding',
  steelStructures: 'Steel Structures',
  welding: 'Welding & Assembly',
  repair: 'Ship Repair',
  interior: 'Interior'
};

export function AdminImageManager() {
  const router = useRouter();
  const [images, setImages] = useState<StoredServiceImages | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<SelectedFiles>({});
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busySection, setBusySection] = useState<ServiceSection | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [content, setContent] = useState<ContentByLocale | null>(null);
  const [isSavingContent, setIsSavingContent] = useState(false);
  const [pendingDeletes, setPendingDeletes] = useState<PendingDeleteItem[]>([]);
  const [vacancies, setVacancies] = useState<Vacancy[]>([]);
  const [isAddingVacancy, setIsAddingVacancy] = useState(false);
  const [deletingVacancyId, setDeletingVacancyId] = useState<string | null>(null);
  const [vacancyForm, setVacancyForm] = useState<VacancyFormState>({
    role: '',
    location: '',
    duration: '',
    description: '',
    postedAt: new Date().toISOString().slice(0, 10)
  });

  const hasData = useMemo(() => images !== null, [images]);

  const loadImages = async () => {
    setError('');

    const response = await fetch('/api/admin/images', { cache: 'no-store' });

    if (!response.ok) {
      setError('Failed to load images.');
      return;
    }

    const payload = (await response.json()) as StoredServiceImages;
    setImages(payload);

    const contentResponse = await fetch('/api/admin/service-content', { cache: 'no-store' });
    if (contentResponse.ok) {
      const contentPayload = (await contentResponse.json()) as ContentByLocale;
      setContent(contentPayload);
    }

    const vacanciesResponse = await fetch('/api/admin/vacancies', { cache: 'no-store' });
    if (vacanciesResponse.ok) {
      const vacanciesPayload = (await vacanciesResponse.json()) as Vacancy[];
      setVacancies(vacanciesPayload);
    }
  };

  useEffect(() => {
    void loadImages();
  }, []);

  const onSelectFile = (section: ServiceSection, file: File | undefined) => {
    setSelectedFiles((prev) => ({
      ...prev,
      [section]: file
    }));
  };

  const toggleDeleteImage = (section: ServiceSection, image: StoredServiceImage) => {
    setError('');
    setStatus('');

    setPendingDeletes((prev) => {
      const exists = prev.some((item) => item.section === section && item.url === image.url);

      if (exists) {
        return prev.filter((item) => !(item.section === section && item.url === image.url));
      }

      return [...prev, { ...image, section }];
    });

    setImages((prev) => {
      if (!prev) {
        return prev;
      }

      const exists = pendingDeletes.some((item) => item.section === section && item.url === image.url);

      if (exists) {
        return {
          ...prev,
          [section]: [...prev[section], image].sort((left, right) => left.url.localeCompare(right.url))
        };
      }

      return {
        ...prev,
        [section]: prev[section].filter((item) => item.url !== image.url)
      };
    });
  };

  const logout = async () => {
    setIsLoggingOut(true);

    try {
      await fetch('/api/admin/logout', { method: 'POST', headers: { 'X-Requested-With': 'titanor-admin' } });
      router.refresh();
    } finally {
      setIsLoggingOut(false);
    }
  };

  const uploadSelectedImages = async () => {
    const selectedEntries = (Object.entries(selectedFiles) as Array<[ServiceSection, File | undefined]>)
      .filter(([, file]) => file);

    if (selectedEntries.length === 0) {
      return;
    }

    for (const [section, file] of selectedEntries) {
      if (!file) {
        continue;
      }

      setBusySection(section);
      const formData = new FormData();
      formData.append('section', section);
      formData.append('file', file);

      const response = await fetch('/api/admin/images', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || 'Upload failed. Verify Cloudinary settings.');
      }

      const payload = (await response.json()) as StoredServiceImages;
      setImages(payload);
      setSelectedFiles((prev) => ({ ...prev, [section]: undefined }));
    }
  };

  const applyPendingDeletes = async () => {
    if (pendingDeletes.length === 0) {
      return;
    }

    for (const item of pendingDeletes) {
      setBusySection(item.section);

      const response = await fetch('/api/admin/images', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          section: item.section,
          publicId: item.publicId,
          url: item.url
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || 'Delete failed.');
      }

      const payload = (await response.json()) as StoredServiceImages;
      setImages(payload);
    }

    setPendingDeletes([]);
  };

  const updateDescription = (locale: Locale, section: ServiceSection, text: string) => {
    setContent((prev) => {
      if (!prev) {
        return prev;
      }

      return {
        ...prev,
        [locale]: {
          ...prev[locale],
          [section]: text
        }
      };
    });
  };

  const saveDescriptions = async () => {
    if (!content) {
      return;
    }

    setIsSavingContent(true);
    setError('');
    setStatus('');

    try {
      await applyPendingDeletes();
      await uploadSelectedImages();

      const response = await fetch('/api/admin/service-content', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(content)
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error || 'Failed to save descriptions.');
        setIsSavingContent(false);
        return;
      }

      const payload = (await response.json()) as ContentByLocale;
      setContent(payload);
      setStatus('Changes saved and published.');
    } catch {
      setError('Failed to save descriptions. Please retry.');
    }

    setIsSavingContent(false);
    setBusySection(null);
  };

  const onVacancyFieldChange = (field: keyof VacancyFormState, value: string) => {
    setVacancyForm((prev) => ({
      ...prev,
      [field]: value
    }));
  };

  const addVacancy = async () => {
    if (
      !vacancyForm.role.trim() ||
      !vacancyForm.location.trim() ||
      !vacancyForm.duration.trim() ||
      !vacancyForm.description.trim() ||
      !vacancyForm.postedAt.trim()
    ) {
      setError('Please fill in all vacancy fields before adding.');
      return;
    }

    setIsAddingVacancy(true);
    setError('');
    setStatus('');

    try {
      const response = await fetch('/api/admin/vacancies', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(vacancyForm)
      });

      const payload = (await response.json().catch(() => ({}))) as Vacancy[] | { error?: string };

      if (!response.ok || !Array.isArray(payload)) {
        const message = !Array.isArray(payload) && payload.error ? payload.error : 'Failed to add vacancy.';
        setError(message);
        setIsAddingVacancy(false);
        return;
      }

      setVacancies(payload);
      setVacancyForm({
        role: '',
        location: '',
        duration: '',
        description: '',
        postedAt: new Date().toISOString().slice(0, 10)
      });
      setStatus('Vacancy published.');
    } catch {
      setError('Failed to add vacancy.');
    }

    setIsAddingVacancy(false);
  };

  const deleteVacancy = async (id: string) => {
    setDeletingVacancyId(id);
    setError('');
    setStatus('');

    try {
      const response = await fetch('/api/admin/vacancies', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id })
      });

      const payload = (await response.json().catch(() => ({}))) as Vacancy[] | { error?: string };

      if (!response.ok || !Array.isArray(payload)) {
        const message = !Array.isArray(payload) && payload.error ? payload.error : 'Failed to delete vacancy.';
        setError(message);
        setDeletingVacancyId(null);
        return;
      }

      setVacancies(payload);
      setStatus('Vacancy removed.');
    } catch {
      setError('Failed to delete vacancy.');
    }

    setDeletingVacancyId(null);
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel-head">
        <div>
          <h1>Service images admin</h1>
          <p>This page is private and available only via direct URL + password.</p>
        </div>
        <button className="button-secondary" type="button" onClick={logout} disabled={isLoggingOut}>
          {isLoggingOut ? 'Signing out...' : 'Sign out'}
        </button>
      </div>

      {status ? <p className="admin-form-status">{status}</p> : null}
      {error ? <p className="admin-form-error">{error}</p> : null}

      {!hasData ? <p>Loading image sections...</p> : null}

      {images
        ? serviceSections.map((section) => (
            <section className="admin-section" key={section}>
              <div className="admin-section-head">
                <h2>{sectionTitles[section]}</h2>
                <div className="admin-upload-row">
                  <label className="admin-upload-button">
                    <span>{selectedFiles[section] ? 'Change image' : 'Choose image'}</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => onSelectFile(section, event.target.files?.[0])}
                    />
                  </label>
                  {selectedFiles[section] ? <span className="admin-upload-filename">{selectedFiles[section]?.name}</span> : null}
                </div>
              </div>

              {content ? (
                <div className="admin-description-grid">
                  <label className="admin-description-block">
                    <span>EN description</span>
                    <textarea
                      value={content.en[section]}
                      onChange={(event) => updateDescription('en', section, event.target.value)}
                    />
                  </label>
                  <label className="admin-description-block">
                    <span>FI description</span>
                    <textarea
                      value={content.fi[section]}
                      onChange={(event) => updateDescription('fi', section, event.target.value)}
                    />
                  </label>
                </div>
              ) : null}

              <div className="admin-image-grid">
                {images[section].map((image) => (
                  <article
                    className={`admin-image-card ${pendingDeletes.some((item) => item.section === section && item.url === image.url) ? 'is-pending-delete' : ''}`}
                    key={`${section}-${image.url}`}
                  >
                    <img alt={`${section} image`} src={image.url} />
                    <button
                      className="button-secondary admin-delete-button"
                      type="button"
                      onClick={() => toggleDeleteImage(section, image)}
                      disabled={busySection === section}
                    >
                      {pendingDeletes.some((item) => item.section === section && item.url === image.url)
                        ? 'Undo delete'
                        : 'Delete'}
                    </button>
                    {pendingDeletes.some((item) => item.section === section && item.url === image.url) ? (
                      <span className="admin-pending-delete-note">Will be removed on save</span>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          ))
        : null}

      <div className="admin-save-row">
        <button className="button-primary" type="button" onClick={saveDescriptions} disabled={isSavingContent}>
          {isSavingContent ? 'Saving...' : 'Save changes'}
        </button>
      </div>

      <section className="admin-section">
        <div className="admin-section-head">
          <h2>Open vacancies</h2>
        </div>

        <div className="admin-vacancy-form-grid">
          <label>
            <span>Who is needed (role)</span>
            <input
              type="text"
              value={vacancyForm.role}
              onChange={(event) => onVacancyFieldChange('role', event.target.value)}
            />
          </label>
          <label>
            <span>Place of work</span>
            <input
              type="text"
              value={vacancyForm.location}
              onChange={(event) => onVacancyFieldChange('location', event.target.value)}
            />
          </label>
          <label>
            <span>Duration</span>
            <input
              type="text"
              value={vacancyForm.duration}
              onChange={(event) => onVacancyFieldChange('duration', event.target.value)}
            />
          </label>
          <label>
            <span>Posted date</span>
            <input
              type="date"
              value={vacancyForm.postedAt}
              onChange={(event) => onVacancyFieldChange('postedAt', event.target.value)}
            />
          </label>
          <label className="admin-vacancy-description-field">
            <span>Description</span>
            <textarea
              value={vacancyForm.description}
              onChange={(event) => onVacancyFieldChange('description', event.target.value)}
            />
          </label>
        </div>

        <div className="admin-save-row">
          <button className="button-primary" type="button" onClick={addVacancy} disabled={isAddingVacancy}>
            {isAddingVacancy ? 'Adding vacancy...' : 'Add vacancy'}
          </button>
        </div>

        <div className="admin-vacancy-list">
          {vacancies.map((vacancy) => (
            <article className="admin-vacancy-card" key={vacancy.id}>
              <div>
                <h3>{vacancy.role}</h3>
                <p>{vacancy.description}</p>
                <p className="admin-vacancy-meta">
                  {vacancy.location} | {vacancy.duration} | {vacancy.postedAt}
                </p>
              </div>
              <button
                className="button-secondary"
                type="button"
                onClick={() => deleteVacancy(vacancy.id)}
                disabled={deletingVacancyId === vacancy.id}
              >
                {deletingVacancyId === vacancy.id ? 'Removing...' : 'Remove'}
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
