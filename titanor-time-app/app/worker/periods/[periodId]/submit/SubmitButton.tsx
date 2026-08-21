'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { COMMON_STRINGS } from '@/lib/i18n/common';
import { WORKER_STRINGS, type WorkerStrings } from '@/lib/i18n/worker';

const CSRF_HEADER_VALUE = 'titanor-time';

function describeError(code: string | undefined, t: WorkerStrings): string {
  switch (code) {
    case 'INVALID_STATE_TRANSITION':
      return t.errSubmitAlreadySubmitted;
    case 'UNRESOLVED_PROPOSALS':
      return t.errUnresolvedProposals;
    default:
      return t.errCouldNotSubmit;
  }
}

export default function SubmitButton({ periodId, timesheetId }: { periodId: string; timesheetId: string }) {
  const locale = useAppLocale();
  const t = WORKER_STRINGS[locale];
  const common = COMMON_STRINGS[locale];
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/worker/timesheets/${timesheetId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(describeError(data?.error?.code, t));
        setSubmitting(false);
        return;
      }
      router.push(`/worker/periods/${periodId}`);
    } catch {
      setError(common.networkError);
      setSubmitting(false);
    }
  }

  return (
    <>
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="wk-action-button" onClick={handleSubmit} disabled={submitting}>
        {submitting ? t.submitting : t.submitTimesheet}
      </button>
    </>
  );
}
