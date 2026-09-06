'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §9. The old button ignored the HTTP
// status and always refreshed — a 403/404/500 looked like a successful delete. This one checks
// response.ok, surfaces the normalized error, keeps the button usable for a retry, and only
// refreshes the list on a real success.
export function ReportFileDeleteButton({ fileId }: { fileId: string }) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (busy) return;
    if (!window.confirm(ru ? 'Удалить сохранённый файл из истории?' : 'Remove this saved file from history?')) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/report-files/${fileId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'titanor-time' }
      });
      if (response.status === 204) {
        router.refresh();
        return;
      }
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.deleted) {
        throw new Error(data?.error?.message ?? (ru ? 'Не удалось удалить файл.' : 'Could not delete the file.'));
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ru ? 'Не удалось удалить файл.' : 'Could not delete the file.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="report-file-delete">
      <button type="button" onClick={remove} disabled={busy}>
        {busy ? (ru ? 'Удаление…' : 'Deleting…') : ru ? 'Удалить' : 'Delete'}
      </button>
      {error && (
        <span className="report-alert" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
