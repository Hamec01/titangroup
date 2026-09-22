import type { BadgeTone } from '@/lib/reporting/ledger-ui-text';

// UT4-B — follows components/qualifications/QualificationBadge.tsx's established convention: an
// icon (never color alone) plus text. Reused for approvalState throughout the page.
const TONE_ICON: Record<BadgeTone, string> = {
  neutral: '○',
  warning: '▲',
  success: '✓',
  danger: '✕'
};

export function StatusBadge({ label, tone }: { label: string; tone: BadgeTone }) {
  return (
    <span className={`ledger-badge ledger-badge-${tone}`}>
      <span aria-hidden="true">{TONE_ICON[tone]}</span> {label}
    </span>
  );
}
