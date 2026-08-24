import type { QualificationExpiryStatus, QualificationStatusColor } from '@/lib/qualification-expiry';
import { qualificationStatusLabel } from '@/lib/qualification-expiry';

// Single reusable status chip for qualification expiry — task spec §15/§34: color is never the
// only signal, always icon + text together. Every surface (worker profile, admin worker
// profile, /admin/qualifications matrix) renders this component instead of ad hoc badges, so
// the four colors mean the same thing everywhere. No emoji — plain inline SVG icons only.

const COLOR_CLASS: Record<QualificationStatusColor, string> = {
  GREEN: 'qual-badge-valid',
  YELLOW: 'qual-badge-expiring',
  ORANGE: 'qual-badge-critical',
  RED: 'qual-badge-expired'
};

function StatusIcon({ color }: { color: QualificationStatusColor }) {
  if (color === 'GREEN') {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (color === 'RED') {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  // YELLOW / ORANGE — warning triangle, distinguishes "attention" from "ok"/"blocked" at a glance.
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2L14.5 13.5H1.5L8 2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 6.5V9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function QualificationBadge({
  status,
  color,
  locale,
  isExpiringToday,
  compact,
  missingCard
}: {
  status: QualificationExpiryStatus;
  color: QualificationStatusColor;
  locale: 'EN' | 'RU';
  isExpiringToday?: boolean;
  compact?: boolean;
  /** The credential doesn't exist at all (§17 — the two safety indicators show "Missing" in
   * this case, distinct from MISSING_EXPIRY, which means the card exists but has no date). */
  missingCard?: boolean;
}) {
  const label = missingCard ? (locale === 'RU' ? 'Отсутствует' : 'Missing') : qualificationStatusLabel(status, locale, isExpiringToday);
  return (
    <span className={`qual-badge ${COLOR_CLASS[color]}`}>
      <StatusIcon color={color} />
      {!compact ? <span>{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}

export function VerificationBadge({ verified, locale }: { verified: boolean; locale: 'EN' | 'RU' }) {
  const label = verified ? (locale === 'RU' ? 'Подтверждено' : 'Verified') : locale === 'RU' ? 'Указано самостоятельно' : 'Self-reported';
  return <span className={`qual-verify-badge ${verified ? 'qual-verify-badge-verified' : 'qual-verify-badge-self'}`}>{label}</span>;
}
