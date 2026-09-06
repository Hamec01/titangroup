'use client';

import { useEffect, useState } from 'react';

export type AdminDesignMode = 'modern' | 'classic';

const STORAGE_KEY = 'titanor-admin-design';

export function AdminDesignToggle() {
  const [mode, setMode] = useState<AdminDesignMode>('modern');

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'classic' || saved === 'modern') setMode(saved);
  }, []);

  function toggle() {
    const next: AdminDesignMode = mode === 'modern' ? 'classic' : 'modern';
    setMode(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new CustomEvent('titanor-admin-design', { detail: next }));
  }

  return (
    <button type="button" className="admin-design-toggle" onClick={toggle} aria-label="Switch admin design">
      <span aria-hidden="true">{mode === 'modern' ? '◐' : '◑'}</span>
      <span>{mode === 'modern' ? 'Старый вид' : 'Новый вид'}</span>
    </button>
  );
}
