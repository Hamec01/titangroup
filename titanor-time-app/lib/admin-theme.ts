// The modern admin colour preference is intentionally separate from the classic/modern layout
// preference. It is a plain, non-sensitive cookie so the Server Component can render the chosen
// palette before hydration and avoid a flash of the default theme.

export const ADMIN_THEME_COOKIE = 'titanor-admin-theme';

export const ADMIN_THEME_VALUES = ['light', 'titan-dark', 'graphite', 'ocean'] as const;
export type AdminTheme = (typeof ADMIN_THEME_VALUES)[number];

export function normalizeAdminTheme(value: string | null | undefined): AdminTheme {
  return ADMIN_THEME_VALUES.includes(value as AdminTheme) ? (value as AdminTheme) : 'light';
}
