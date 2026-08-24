import { prisma } from '@/lib/prisma';
import type { QualificationExpiryMode, QualificationScope } from '@prisma/client';

// Qualifications Matrix (2026-08-24) — read access to the QualificationDefinition catalog
// seeded by prisma/migrations/20260824221000_seed_qualification_catalog_and_notification_permissions.
// FI has no translated catalog yet: callers must fall back to nameEn/descriptionEn for locale
// FI (see lib/i18n/locale.ts — FI already folds to RU for UI strings elsewhere in this app, but
// the catalog itself intentionally keeps only EN/RU columns per the task spec, so any FI reader
// must explicitly choose the EN fields, not invent a translation).

export interface QualificationDefinitionView {
  id: string;
  code: string;
  category: string;
  scope: QualificationScope;
  nameEn: string;
  nameRu: string;
  descriptionEn: string | null;
  descriptionRu: string | null;
  expiryMode: QualificationExpiryMode;
  sortOrder: number;
}

const CATALOG_SELECT = {
  id: true,
  code: true,
  category: true,
  scope: true,
  nameEn: true,
  nameRu: true,
  descriptionEn: true,
  descriptionRu: true,
  expiryMode: true,
  sortOrder: true
} as const;

/** All active catalog entries, optionally restricted to a scope. Ordered for stable display. */
export async function listQualificationDefinitions(options?: { scope?: QualificationScope }): Promise<QualificationDefinitionView[]> {
  return prisma.qualificationDefinition.findMany({
    where: { isActive: true, ...(options?.scope ? { scope: options.scope } : {}) },
    select: CATALOG_SELECT,
    orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }]
  });
}

/** Selectable in the worker/admin "add qualification" picker — EMPLOYEE scope only, never
 * COMPANY_REFERENCE standards (EN ISO 3834, EN 1090, EN 15085, PED 2014/68/EU). */
export async function listSelectableQualificationDefinitions(): Promise<QualificationDefinitionView[]> {
  return listQualificationDefinitions({ scope: 'EMPLOYEE' });
}

export async function getQualificationDefinitionById(id: string): Promise<QualificationDefinitionView | null> {
  return prisma.qualificationDefinition.findUnique({ where: { id }, select: CATALOG_SELECT });
}

export function qualificationDefinitionDisplayName(definition: Pick<QualificationDefinitionView, 'nameEn' | 'nameRu'>, locale: 'EN' | 'RU'): string {
  return locale === 'RU' ? definition.nameRu : definition.nameEn;
}

export function qualificationDefinitionDescription(definition: Pick<QualificationDefinitionView, 'descriptionEn' | 'descriptionRu'>, locale: 'EN' | 'RU'): string | null {
  return locale === 'RU' ? definition.descriptionRu ?? definition.descriptionEn : definition.descriptionEn;
}
