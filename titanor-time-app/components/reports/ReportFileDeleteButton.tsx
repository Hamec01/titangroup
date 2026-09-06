'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

export function ReportFileDeleteButton({ fileId }: { fileId: string }) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (!window.confirm(ru ? 'Удалить сохранённый файл из истории?' : 'Remove this saved file from history?')) return;
    setBusy(true);
    try { await fetch(`/api/admin/report-files/${fileId}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-Requested-With': 'titanor-time' } }); router.refresh(); }
    finally { setBusy(false); }
  }
  return <button type="button" onClick={remove} disabled={busy}>{busy ? '…' : (ru ? 'Удалить' : 'Delete')}</button>;
}
