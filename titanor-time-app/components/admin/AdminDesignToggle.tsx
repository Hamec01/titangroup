'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ADMIN_DESIGN_COOKIE, type AdminDesignMode } from '@/lib/admin-design';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const LS_KEY = 'titanor-admin-design';
const ONE_YEAR = 60 * 60 * 24 * 365;

function writeMirror(mode: AdminDesignMode) {
  try {
    window.localStorage.setItem(LS_KEY, mode);
  } catch {
    // Storage disabled / full — the cookie already carries the choice, nothing breaks (§4.6).
  }
}

// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §4. Server renders the shell from
// the cookie; this button flips the cookie, mirrors to localStorage (guarded), and asks the
// router to re-render — so the switch is server-rendered too, with no flash.
export function AdminDesignToggle({ mode: serverMode }: { mode: AdminDesignMode }) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [mode, setMode] = useState<AdminDesignMode>(serverMode);

  useEffect(() => {
    setMode(serverMode);
    // Reconcile a stale / corrupted mirror against the authoritative cookie.
    try {
      const stored = window.localStorage.getItem(LS_KEY);
      if (stored !== 'modern' && stored !== 'classic') {
        window.localStorage.removeItem(LS_KEY);
      }
      if (stored !== serverMode) writeMirror(serverMode);
    } catch {
      /* ignore */
    }
  }, [serverMode]);

  function toggle() {
    const next: AdminDesignMode = mode === 'modern' ? 'classic' : 'modern';
    setMode(next);
    document.cookie = `${ADMIN_DESIGN_COOKIE}=${next}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
    writeMirror(next);
    router.refresh();
  }

  const label = mode === 'modern' ? (ru ? 'Старый вид' : 'Classic view') : ru ? 'Новый вид' : 'New view';

  return (
    <button type="button" className="admin-design-toggle" onClick={toggle} aria-label={label} title={label}>
      <span aria-hidden="true">{mode === 'modern' ? '◧' : '◨'}</span>
      <span>{label}</span>
    </button>
  );
}
