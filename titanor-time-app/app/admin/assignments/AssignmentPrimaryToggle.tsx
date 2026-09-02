'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AssignmentListItem } from '@/lib/assignments';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

const CSRF_HEADER_VALUE = 'titanor-time';

// Only isPrimary — endedReason editing needs a real assignment detail page
// (not built yet) to be a reasonable UX; this list row only exposes the one
// action that's genuinely a one-click toggle.
export function AssignmentPrimaryToggle({ assignment }: { assignment: AssignmentListItem }) {
  const router = useRouter();
  const locale = useAppLocale();
  const [loading, setLoading] = useState(false);

  async function handleClick(): Promise<void> {
    if (loading) {
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/assignments/${assignment.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ version: assignment.version, isPrimary: !assignment.isPrimary })
      });
      if (!response.ok) {
        let code: string | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string } };
          code = body.error?.code;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }
        const reloadCodes = new Set(['VERSION_CONFLICT', 'LIVE_PRIMARY_CONFLICT']);
        window.alert(
          reloadCodes.has(code ?? '')
            ? localeText(locale, 'This assignment was changed elsewhere — reloading.', 'Назначение изменено в другом окне — обновляем страницу.')
            : code === 'ASSIGNMENT_NOT_ACTIVE'
              ? localeText(locale, 'This assignment is not active — it cannot be made primary.', 'Назначение не действует — его нельзя сделать основным.')
              : code === 'FORBIDDEN'
                ? localeText(locale, 'You no longer have permission to edit assignments.', 'У вас больше нет права изменять назначения.')
                : localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.')
        );
        if (reloadCodes.has(code ?? '')) {
          router.refresh();
        }
        setLoading(false);
        return;
      }
      router.refresh();
    } catch {
      window.alert(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setLoading(false);
    }
  }

  return (
    <button type="button" className="setup-action" onClick={handleClick} disabled={loading}>
      {assignment.isPrimary ? localeText(locale, 'Unset primary', 'Снять статус основного') : localeText(locale, 'Set primary', 'Сделать основным')}
    </button>
  );
}
