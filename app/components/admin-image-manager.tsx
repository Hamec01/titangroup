'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { serviceSections, type ServiceSection } from '../../lib/service-sections';
import type { Locale } from '../i18n';

type StoredServiceImage = {
  url: string;
  publicId: string | null;
};

type StoredServiceImages = Record<ServiceSection, StoredServiceImage[]>;

type SelectedFiles = Partial<Record<ServiceSection, File>>;
type ContentByLocale = Record<Locale, Record<ServiceSection, string>>;

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

  const uploadForSection = async (section: ServiceSection) => {
    const file = selectedFiles[section];

    if (!file) {
      setError('Choose a file first.');
      return;
    }

    setBusySection(section);
    setError('');
    setStatus('');

    const formData = new FormData();
    formData.append('section', section);
    formData.append('file', file);

    try {
      const response = await fetch('/api/admin/images', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error || 'Upload failed. Verify Cloudinary settings.');
        setBusySection(null);
        return;
      }

      const payload = (await response.json()) as StoredServiceImages;
      setImages(payload);
      setSelectedFiles((prev) => ({ ...prev, [section]: undefined }));
      setStatus('Image uploaded. Public cards updated immediately.');
    } catch {
      setError('Upload failed. Please retry.');
    }

    setBusySection(null);
  };

  const deleteImage = async (section: ServiceSection, image: StoredServiceImage) => {
    setBusySection(section);
    setError('');
    setStatus('');

    try {
      const response = await fetch('/api/admin/images', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          section,
          publicId: image.publicId,
          url: image.url
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error || 'Delete failed.');
        setBusySection(null);
        return;
      }

      const payload = (await response.json()) as StoredServiceImages;
      setImages(payload);
      setStatus('Image removed.');
    } catch {
      setError('Delete failed. Please retry.');
    }

    setBusySection(null);
  };

  const logout = async () => {
    setIsLoggingOut(true);

    try {
      await fetch('/api/admin/logout', { method: 'POST' });
      router.refresh();
    } finally {
      setIsLoggingOut(false);
    }
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
      setStatus('Descriptions saved and published.');
    } catch {
      setError('Failed to save descriptions. Please retry.');
    }

    setIsSavingContent(false);
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
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(event) => onSelectFile(section, event.target.files?.[0])}
                  />
                  <button
                    className="button-primary"
                    type="button"
                    onClick={() => uploadForSection(section)}
                    disabled={busySection === section}
                  >
                    Upload image
                  </button>
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
                  <article className="admin-image-card" key={`${section}-${image.url}`}>
                    <img alt={`${section} image`} src={image.url} />
                    <button
                      className="button-secondary"
                      type="button"
                      onClick={() => deleteImage(section, image)}
                      disabled={busySection === section}
                    >
                      Delete
                    </button>
                  </article>
                ))}
              </div>
            </section>
          ))
        : null}

      <div className="admin-save-row">
        <button className="button-primary" type="button" onClick={saveDescriptions} disabled={isSavingContent}>
          {isSavingContent ? 'Saving...' : 'Save descriptions'}
        </button>
      </div>
    </div>
  );
}
