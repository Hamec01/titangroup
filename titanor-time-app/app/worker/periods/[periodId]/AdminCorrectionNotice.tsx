'use client';

import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

export interface AdminCorrectionView {
  byUsername: string | null;
  reason: string | null;
  at: string;
}

// Task A — shown when the current timesheet version was frozen by an admin's in-review edit
// (source=CORRECTION). React escapes the reason text automatically (plain JSX child).
export function AdminCorrectionNotice({ correction }: { correction: AdminCorrectionView | null }) {
  const ru = useAppLocale() === 'RU';
  if (!correction) {
    return null;
  }
  const who = correction.byUsername ? ` · ${correction.byUsername}` : '';
  const when = new Date(correction.at).toLocaleString(ru ? 'ru-RU' : 'en-GB');

  return (
    <div className="wk-return-notice" role="status">
      <h2 className="wk-return-notice-title">{ru ? 'Часы исправил администратор' : 'Hours edited by an administrator'}</h2>
      <p className="wk-return-reason-text">{correction.reason ?? (ru ? 'Без комментария.' : 'No note given.')}</p>
      <span className="wk-return-reason-time">
        {(ru ? 'Администратор' : 'Administrator')}
        {who} · {when}
      </span>
    </div>
  );
}
