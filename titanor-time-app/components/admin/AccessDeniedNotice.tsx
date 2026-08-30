import { accessDeniedText, type AccessDeniedArea } from '@/lib/i18n/access-denied';
import type { AppLocale } from '@/lib/i18n/locale';

// R09.2 — the one place an admin page renders "you can't see this". Body text is human and keyed
// by `area`; the permission code (if any) is support-only metadata on `title` / `data-permission`,
// never in the visible text. Presentation only — no permission logic here.
export function AccessDeniedNotice({
  area,
  locale,
  permission
}: {
  area: AccessDeniedArea;
  locale: AppLocale;
  permission?: string;
}) {
  return (
    <main className="setup-page">
      <p
        className="login-error"
        role="alert"
        title={permission || undefined}
        data-permission={permission || undefined}
      >
        {accessDeniedText(area, locale)}
      </p>
    </main>
  );
}
