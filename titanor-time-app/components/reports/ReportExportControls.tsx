'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

export function ReportExportControls({ periodId }: { periodId: string }) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [busy, setBusy] = useState<'CSV' | 'PDF' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<{ id: string; downloadUrl: string; fileName: string } | null>(null);

  async function create(format: 'CSV' | 'PDF') {
    setBusy(format); setError(null); setFile(null);
    try {
      const response = await fetch('/api/admin/reports/export', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time' }, body: JSON.stringify({ periodId, format }) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.file) throw new Error(data?.error?.message ?? (ru ? 'Не удалось создать файл.' : 'Could not create the file.'));
      setFile(data.file); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : (ru ? 'Не удалось создать файл.' : 'Could not create the file.')); }
    finally { setBusy(null); }
  }

  return (
    <div className="report-header-actions">
      <button type="button" className="report-button" onClick={() => create('CSV')} disabled={busy !== null}>{busy === 'CSV' ? '…' : '⇩'} CSV</button>
      <button type="button" className="report-button report-button-primary" onClick={() => create('PDF')} disabled={busy !== null}>{busy === 'PDF' ? '…' : '⇩'} PDF</button>
      {file && <Link className="report-button" href={file.downloadUrl}>{ru ? 'Скачать файл' : 'Download file'}</Link>}
      {error && <span className="report-alert" role="alert">{error}</span>}
    </div>
  );
}
