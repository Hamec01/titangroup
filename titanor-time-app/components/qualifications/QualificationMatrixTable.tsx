'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { QualificationBadge, VerificationBadge } from './QualificationBadge';
import type { QualificationExpiryStatus, QualificationStatusColor } from '@/lib/qualification-expiry';

// /admin/qualifications matrix — task spec §16-18. One row per worker; chips are only rendered
// for credentials that actually exist (§17 — never 20 red "missing" badges) except the two
// safety-card indicators, which always render (missing => a dedicated red "Missing" chip).
// Chip click/focus opens a keyboard-accessible popover (§18/§30) — one at a time.

export interface MatrixChip {
  employeeQualificationId: string;
  definitionCode: string | null;
  category: string | null;
  name: string;
  nameRu: string | null;
  description: { en: string | null; ru: string | null };
  certificateNumber: string | null;
  issuer: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  status: QualificationExpiryStatus;
  color: QualificationStatusColor;
  verificationState: 'SELF_REPORTED' | 'VERIFIED';
}

export interface MatrixRow {
  employeeId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  safetyCard: MatrixChip | null;
  hotWorkCard: MatrixChip | null;
  otherChips: MatrixChip[];
}

function ChipButton({
  chip,
  fallbackLabel,
  locale,
  isOpen,
  onToggle,
  missingCard
}: {
  chip: MatrixChip | null;
  fallbackLabel: string;
  locale: 'EN' | 'RU';
  isOpen: boolean;
  onToggle: () => void;
  missingCard?: boolean;
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
  const description = locale === 'RU' ? chip.description.ru ?? chip.description.en : chip.description.en;

  return (
    <div className="qual-chip-wrap" ref={ref}>
      <button
        type="button"
        className={`qual-chip qual-chip-button qual-chip-${chip.color.toLowerCase()}`}
        onClick={onToggle}
        onFocus={(e) => {
          // Keyboard Tab focus opens it (§18); a mouse/touch click already opens via onClick, and
          // a mouse click also fires a preceding focus event — without this check that would
          // open-then-immediately-close on every click. :focus-visible is true only for
          // keyboard-driven focus, which is exactly the distinction needed here.
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
          {description ? <p className="qual-chip-popover-desc">{description}</p> : null}
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
          {chip.issuedOn ? (
            <p>
              <strong>{locale === 'RU' ? 'Выдано:' : 'Issued:'}</strong> {chip.issuedOn}
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

export function QualificationMatrixTable({ rows, locale }: { rows: MatrixRow[]; locale: 'EN' | 'RU' }) {
  const [openKey, setOpenKey] = useState<string | null>(null);

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
              {row.dateOfBirth ? ` · ${row.dateOfBirth}` : ''}
            </span>
          </div>
          <div className="qual-matrix-chips">
            <ChipButton
              chip={row.safetyCard}
              fallbackLabel={locale === 'RU' ? 'Техника безопасности' : 'Safety'}
              locale={locale}
              isOpen={openKey === `${row.employeeId}:safety`}
              onToggle={() => setOpenKey((k) => (k === `${row.employeeId}:safety` ? null : `${row.employeeId}:safety`))}
              missingCard={!row.safetyCard}
            />
            <ChipButton
              chip={row.hotWorkCard}
              fallbackLabel={locale === 'RU' ? 'Огневые работы' : 'Hot Work'}
              locale={locale}
              isOpen={openKey === `${row.employeeId}:hotwork`}
              onToggle={() => setOpenKey((k) => (k === `${row.employeeId}:hotwork` ? null : `${row.employeeId}:hotwork`))}
              missingCard={!row.hotWorkCard}
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
