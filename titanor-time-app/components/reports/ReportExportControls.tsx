'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

type Format = 'CSV' | 'PDF';
type ReportType = 'PERIOD_SUMMARY' | 'SITE_DETAIL' | 'WORKER_DETAIL';

interface Props {
  periodId: string;
  reportType: ReportType;
  siteId?: string;
  employeeId?: string;
}

interface CreatedFile {
  id: string;
  downloadUrl: string;
  fileName: string;
}

// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §8 + §9. Buttons lock while a
// request is in flight. Each format keeps ONE Idempotency-Key until it succeeds — a network retry
// of the same click reuses it (server returns the already-created file); a fresh click after
// success mints a new key (a new, deliberate snapshot). Errors are shown verbatim from the
// normalized envelope and stay retryable; a failed request never looks like a success.
export function ReportExportControls({ periodId, reportType, siteId, employeeId }: Props) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<{ format: Format; message: string } | null>(null);
  const [file, setFile] = useState<CreatedFile | null>(null);
  const keyRef = useRef<Partial<Record<Format, string>>>({});

  async function create(format: Format) {
    if (busy) return;
    setBusy(format);
    setError(null);
    if (!keyRef.current[format]) keyRef.current[format] = crypto.randomUUID();
    try {
      const response = await fetch('/api/admin/reports/export', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'titanor-time',
          'Idempotency-Key': keyRef.current[format] as string
        },
        body: JSON.stringify({ periodId, format, reportType, siteId, employeeId })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.file) {
        throw new Error(data?.error?.message ?? (ru ? 'Не удалось создать файл.' : 'Could not create the file.'));
      }
      delete keyRef.current[format];
      setFile(data.file as CreatedFile);
      router.refresh();
    } catch (cause) {
      setError({ format, message: cause instanceof Error ? cause.message : ru ? 'Не удалось создать файл.' : 'Could not create the file.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="report-header-actions">
      <button type="button" className="report-button" onClick={() => create('CSV')} disabled={busy !== null}>
        {busy === 'CSV' ? (ru ? 'Создаётся…' : 'Creating…') : ru ? 'Создать CSV' : 'Create CSV'}
      </button>
      <button type="button" className="report-button report-button-primary" onClick={() => create('PDF')} disabled={busy !== null}>
        {busy === 'PDF' ? (ru ? 'Создаётся…' : 'Creating…') : ru ? 'Создать PDF' : 'Create PDF'}
      </button>
      {file && (
        <Link className="report-button" href={file.downloadUrl}>
          {ru ? 'Скачать' : 'Download'}: {file.fileName}
        </Link>
      )}
      {error && (
        <span className="report-alert" role="alert">
          {error.message}{' '}
          <button type="button" className="report-inline-retry" onClick={() => create(error.format)} disabled={busy !== null}>
            {ru ? 'Повторить' : 'Retry'}
          </button>
        </span>
      )}
    </div>
  );
}
