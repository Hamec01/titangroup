'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { QualificationBadge, VerificationBadge } from '@/components/qualifications/QualificationBadge';
import type { QualificationMatrixRow } from '@/lib/qualification-matrix';

// T13.5 — the workforce matrix row. One row per worker: name + number, an active/inactive marker,
// profession chips, current site(s), then the qualification chips (safety card + hot work always
// shown; a missing one -> a red "Missing" chip). Chip click/focus opens a popover, one at a time.
// The qualification-chip code is the same shape as the old QualificationMatrixTable.

function ChipButton({
  chip,
  fallbackLabel,
  locale,
  isOpen,
  onToggle
}: {
  chip: QualificationMatrixRow['safetyCard'];
  fallbackLabel: string;
  locale: 'EN' | 'RU';
  isOpen: boolean;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onToggle();
    }
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onToggle();
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [isOpen, onToggle]);

  if (!chip) {
    return (
      <span className="qual-chip qual-chip-missing">
        <QualificationBadge status="MISSING_EXPIRY" color="RED" locale={locale} missingCard compact={false} />
        <span className="qual-chip-label">{fallbackLabel}</span>
      </span>
    );
  }

  const label = locale === 'RU' && chip.nameRu ? chip.nameRu : chip.name;
  return (
    <div className="qual-chip-wrap" ref={ref}>
      <button
        type="button"
        className={`qual-chip qual-chip-button qual-chip-${chip.color.toLowerCase()}`}
        onClick={onToggle}
        onFocus={(e) => {
          if (!isOpen && e.target.matches(':focus-visible')) onToggle();
        }}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <span className="qual-chip-label">{label}</span>
      </button>
      {isOpen ? (
        <div className="qual-chip-popover" role="dialog" aria-label={label}>
          <p className="qual-chip-popover-title">{label}</p>
          {chip.definitionCode ? <p className="qual-chip-popover-code">{chip.definitionCode}</p> : null}
          {chip.certificateNumber ? (
            <p>
              <strong>{locale === 'RU' ? 'Номер:' : 'Certificate:'}</strong> {chip.certificateNumber}
            </p>
          ) : null}
          {chip.issuer ? (
            <p>
              <strong>{locale === 'RU' ? 'Кем выдано:' : 'Issuer:'}</strong> {chip.issuer}
            </p>
          ) : null}
          {chip.expiresOn ? (
            <p>
              <strong>{locale === 'RU' ? 'Истекает:' : 'Expires:'}</strong> {chip.expiresOn}
            </p>
          ) : null}
          <p>
            <QualificationBadge status={chip.status} color={chip.color} locale={locale} />
          </p>
          <p>
            <VerificationBadge verified={chip.verificationState === 'VERIFIED'} locale={locale} />
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function WorkforceMatrixTable({ rows, locale }: { rows: QualificationMatrixRow[]; locale: 'EN' | 'RU' }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const ru = locale === 'RU';

  return (
    <ul className="qual-matrix-list">
      {rows.map((row) => (
        <li key={row.employeeId} className="qual-matrix-row">
          <div className="qual-matrix-identity">
            <Link href={`/admin/workers/${row.employeeId}`} className="qual-matrix-name">
              {row.lastName} {row.firstName}
            </Link>
            <span className="qual-matrix-meta">
              #{row.employeeNumber}
              {' · '}
              {row.active ? (ru ? 'активен' : 'active') : ru ? 'неактивен' : 'inactive'}
              {row.currentSites.length > 0 ? ` · ${row.currentSites.map((s) => s.name).join(', ')}` : ''}
            </span>
            {row.professions.length > 0 ? (
              <span className="qual-matrix-meta">
                {row.professions.map((p) => (ru ? p.nameRu ?? p.nameEn : p.nameEn)).join(' · ')}
              </span>
            ) : null}
          </div>
          <div className="qual-matrix-chips">
            <ChipButton
              chip={row.safetyCard}
              fallbackLabel={ru ? 'Техника безопасности' : 'Safety'}
              locale={locale}
              isOpen={openKey === `${row.employeeId}:safety`}
              onToggle={() => setOpenKey((k) => (k === `${row.employeeId}:safety` ? null : `${row.employeeId}:safety`))}
            />
            <ChipButton
              chip={row.hotWorkCard}
              fallbackLabel={ru ? 'Огневые работы' : 'Hot Work'}
              locale={locale}
              isOpen={openKey === `${row.employeeId}:hotwork`}
              onToggle={() => setOpenKey((k) => (k === `${row.employeeId}:hotwork` ? null : `${row.employeeId}:hotwork`))}
            />
            {row.otherChips.map((chip) => (
              <ChipButton
                key={chip.employeeQualificationId}
                chip={chip}
                fallbackLabel=""
                locale={locale}
                isOpen={openKey === `${row.employeeId}:${chip.employeeQualificationId}`}
                onToggle={() => setOpenKey((k) => (k === `${row.employeeId}:${chip.employeeQualificationId}` ? null : `${row.employeeId}:${chip.employeeQualificationId}`))}
              />
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}
