import { CSV_BOM, buildCsvRow } from '@/lib/csv-export';
import { qualificationStatusLabel } from '@/lib/qualification-expiry';
import type { QualificationMatrixRow } from '@/lib/qualification-matrix';
import type { AppLocale } from '@/lib/i18n/locale';

// T13.6 — workforce matrix CSV. Same BOM/CRLF/quote-every-cell/formula-injection primitive as
// CSV_V1 (lib/csv-export.ts's buildCsvRow). No UUIDs, no date of birth / address / phone /
// contract / certificate images. One row per worker; qualification chips are flattened into a
// single readable column.

const HUMAN_TEXT_INDICES = new Set([1, 2, 3, 5, 6]); // name, professions, sites, safety, hot work, quals

function chipText(chip: QualificationMatrixRow['safetyCard'], locale: AppLocale): string {
  if (!chip) return locale === 'RU' ? 'нет' : 'missing';
  const name = locale === 'RU' && chip.nameRu ? chip.nameRu : chip.name;
  const parts = [name, qualificationStatusLabel(chip.status, locale === 'RU' ? 'RU' : 'EN')];
  if (chip.expiresOn) parts.push(`${locale === 'RU' ? 'до' : 'until'} ${chip.expiresOn}`);
  parts.push(chip.verificationState === 'VERIFIED' ? (locale === 'RU' ? 'подтв.' : 'verified') : locale === 'RU' ? 'самост.' : 'self');
  return parts.join(' — ');
}

export function buildWorkforceCsv(rows: QualificationMatrixRow[], locale: AppLocale): Buffer {
  const ru = locale === 'RU';
  const header = ru
    ? ['Табельный номер', 'ФИО', 'Профессии', 'Текущий объект(ы)', 'Занятость', 'Карта ТБ', 'Карта огневых работ', 'Прочие допуски']
    : ['Employee number', 'Name', 'Professions', 'Current site(s)', 'Employment', 'Safety card', 'Hot work card', 'Other qualifications'];

  const lines: string[] = [buildCsvRow(header, new Set())];
  for (const r of rows) {
    const professions = r.professions.map((p) => (ru ? p.nameRu ?? p.nameEn : p.nameEn)).join('; ') || (ru ? 'нет' : 'none');
    const sites = r.currentSites.map((s) => s.name).join('; ') || (ru ? 'нет' : 'none');
    const others = r.otherChips.map((c) => chipText(c, locale)).join(' | ') || (ru ? 'нет' : 'none');
    lines.push(
      buildCsvRow(
        [
          r.employeeNumber,
          `${r.lastName} ${r.firstName}`,
          professions,
          sites,
          r.active ? (ru ? 'активен' : 'active') : ru ? 'неактивен' : 'inactive',
          chipText(r.safetyCard, locale),
          chipText(r.hotWorkCard, locale),
          others
        ],
        HUMAN_TEXT_INDICES
      )
    );
  }
  return Buffer.concat([CSV_BOM, Buffer.from(lines.join(''), 'utf8')]);
}

export function workforceCsvFileName(): string {
  return `titanor-workforce_${new Date().toISOString().slice(0, 10)}.csv`;
}
