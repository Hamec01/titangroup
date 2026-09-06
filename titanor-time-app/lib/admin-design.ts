// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §4. The admin design choice
// (modern sidebar shell vs the classic header shell) is stored in a plain cookie — NOT the
// session cookie — so it is rendered server-side (no flash of the wrong shell, §4.5) and survives
// reload, logout/login and navigation (§4.4). AdminDesignToggle also mirrors it to localStorage,
// but the cookie is the single source of truth for what gets rendered.
//
// This module is import-safe from both Client and Server Components: it must NOT import
// `next/headers`. The layout (a Server Component) reads the cookie itself.

export const ADMIN_DESIGN_COOKIE = 'titanor-admin-design';
export type AdminDesignMode = 'modern' | 'classic';

export function normalizeAdminDesignMode(value: string | null | undefined): AdminDesignMode {
  return value === 'classic' ? 'classic' : 'modern';
}
