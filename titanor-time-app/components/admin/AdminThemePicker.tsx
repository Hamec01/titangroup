'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { ADMIN_THEME_COOKIE, type AdminTheme } from '@/lib/admin-theme';

const LS_KEY = 'titanor-admin-theme';
const ONE_YEAR = 60 * 60 * 24 * 365;

const THEMES: Array<{ value: AdminTheme; ru: string; en: string }> = [
  { value: 'light', ru: 'Светлая', en: 'Light' },
  { value: 'titan-dark', ru: 'Titan тёмная', en: 'Titan dark' },
  { value: 'graphite', ru: 'Графит', en: 'Graphite' },
  { value: 'ocean', ru: 'Океан', en: 'Ocean' }
];

function writeMirror(theme: AdminTheme) {
  try {
    window.localStorage.setItem(LS_KEY, theme);
  } catch {
    // The cookie remains authoritative when local storage is restricted.
  }
}

export function AdminThemePicker({ theme: serverTheme }: { theme: AdminTheme }) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [theme, setTheme] = useState(serverTheme);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    setTheme(serverTheme);
    writeMirror(serverTheme);
  }, [serverTheme]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePress(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  function choose(next: AdminTheme) {
    setTheme(next);
    setOpen(false);
    document.cookie = `${ADMIN_THEME_COOKIE}=${next}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
    writeMirror(next);
    document.querySelector<HTMLElement>('.admin-modern-shell')?.setAttribute('data-theme', next);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
    router.refresh();
  }

  const current = THEMES.find((item) => item.value === theme) ?? THEMES[0];
  const menuLabel = ru ? 'Цветовая тема' : 'Colour theme';

  return (
    <div className="admin-theme-picker" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="admin-theme-trigger"
        aria-label={`${menuLabel}: ${ru ? current.ru : current.en}`}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="admin-theme-trigger-icon" aria-hidden="true">◉</span>
        <span className="admin-theme-trigger-label">{ru ? current.ru : current.en}</span>
        <span className="admin-theme-trigger-caret" aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div id={panelId} className="admin-theme-menu" role="group" aria-label={menuLabel}>
          <p>{menuLabel}</p>
          {THEMES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={item.value === theme ? 'admin-theme-option is-selected' : 'admin-theme-option'}
              data-theme-option={item.value}
              aria-pressed={item.value === theme}
              onClick={() => choose(item.value)}
            >
              <span className={`admin-theme-swatches admin-theme-swatches-${item.value}`} aria-hidden="true">
                <i /><i /><i />
              </span>
              <span>{ru ? item.ru : item.en}</span>
              <span className="admin-theme-check" aria-hidden="true">{item.value === theme ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
