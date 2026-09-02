import type { ProfessionCategory } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { liveAssignmentWhere } from '@/lib/assignment-lifecycle';
import { helsinkiCalendarDateAsUtcMidnight } from '@/lib/attendance-clock';
import { computeQualificationExpiryStatus, type QualificationExpiryStatus, type QualificationStatusColor } from '@/lib/qualification-expiry';

// /admin/workforce (was /admin/qualifications) — the workforce matrix. Filtering/sorting/pagination
// all happen here, on the server, over the full Employee set (this app's worker counts are
// company-scale, not millions — an in-memory pass after one bounded query is the same "don't ship
// rows to the browser and filter client-side" guarantee, without needing per-status SQL date
// arithmetic). Reuses lib/qualification-expiry.ts for every status computation. T13.5 added the
// profession filters, the active/current-site semantics, and the profession/number/site sorts.

export type MatrixStatusFilter = 'ALL' | QualificationExpiryStatus | 'MISSING';
export type MatrixVerificationFilter = 'ALL' | 'VERIFIED' | 'SELF_REPORTED';
export type MatrixSort = 'ATTENTION' | 'NAME' | 'NUMBER' | 'PROFESSION' | 'CURRENT_SITE' | 'EXPIRY';
export type MatrixProfessionCategory = 'ALL' | 'SHIPBUILDING' | 'CONSTRUCTION';
export type MatrixActiveFilter = 'ALL' | 'ACTIVE' | 'INACTIVE';

export interface QualificationMatrixQuery {
  search: string;
  qualificationCode: string | null;
  status: MatrixStatusFilter;
  siteId: string | null;
  verification: MatrixVerificationFilter;
  /** T13.5 — optional so pre-T13.5 callers (and the existing matrix test) keep compiling; default 'ALL'. */
  professionCategory?: MatrixProfessionCategory;
  /** ProfessionDefinition.code — catalog entries only (a custom profession has no code). */
  professionCode?: string | null;
  active?: MatrixActiveFilter;
  sort: MatrixSort;
  page: number;
  pageSize: number;
}

export interface MatrixProfession {
  id: string;
  code: string | null;
  category: ProfessionCategory;
  nameEn: string;
  nameRu: string | null;
  isCustom: boolean;
}

export interface QualificationChip {
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

export interface QualificationMatrixRow {
  employeeId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  active: boolean;
  professions: MatrixProfession[];
  currentSites: { id: string; name: string }[];
  safetyCard: QualificationChip | null;
  hotWorkCard: QualificationChip | null;
  otherChips: QualificationChip[];
  worstStatusRank: number;
  nearestExpiry: string | null;
}

export interface QualificationMatrixResult {
  items: QualificationMatrixRow[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

const STATUS_RANK: Record<QualificationExpiryStatus | 'MISSING', number> = {
  MISSING: 0,
  MISSING_EXPIRY: 0,
  EXPIRED: 0,
  CRITICAL: 1,
  EXPIRING_SOON: 2,
  VALID: 3
};

const SAFETY_CODE = 'OCCUPATIONAL_SAFETY_CARD';
const HOT_WORK_CODE = 'HOT_WORK_CARD';

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function currentAssignmentWhere(today: Date) {
  // R15-D7 — shared operationally-live filter (clockInDisabledAt-aware).
  return liveAssignmentWhere(new Date(), today);
}

// "Active" per docs/titanor-time/T13 §8 and the predicate lib/timesheet-submission-schedules.ts
// already uses: an Employment that is active AND whose [startDate, endDate] window covers today.
function isActiveEmployee(employments: { active: boolean; startDate: Date; endDate: Date | null }[], today: Date): boolean {
  return employments.some((e) => e.active && e.startDate <= today && (e.endDate === null || e.endDate >= today));
}

/** The full filtered + sorted row set, WITHOUT pagination. Shared by the web matrix
 *  (getQualificationMatrix, which slices it) and the export (resolveWorkforceScope, T13.6). */
async function buildWorkforceRows(rawQuery: Omit<QualificationMatrixQuery, 'page' | 'pageSize'>): Promise<QualificationMatrixRow[]> {
  const query = {
    ...rawQuery,
    professionCategory: rawQuery.professionCategory ?? ('ALL' as MatrixProfessionCategory),
    professionCode: rawQuery.professionCode ?? null,
    active: rawQuery.active ?? ('ALL' as MatrixActiveFilter)
  };
  const today = helsinkiCalendarDateAsUtcMidnight(new Date());

  // Pre-filter id sets that CAN be pushed to SQL. Each is intersected below.
  const idFilters: Set<string>[] = [];

  if (query.siteId) {
    const assignments = await prisma.siteAssignment.findMany({
      where: { siteId: query.siteId, ...currentAssignmentWhere(today) },
      select: { employeeId: true }
    });
    idFilters.push(new Set(assignments.map((a) => a.employeeId)));
  }

  if (query.professionCode || query.professionCategory !== 'ALL') {
    const category = query.professionCategory === 'ALL' ? undefined : (query.professionCategory as ProfessionCategory);
    const professions = await prisma.employeeProfession.findMany({
      where: {
        ...(query.professionCode ? { definition: { code: query.professionCode } } : {}),
        ...(category ? { OR: [{ definition: { category } }, { customCategory: category }] } : {})
      },
      select: { employeeId: true }
    });
    idFilters.push(new Set(professions.map((p) => p.employeeId)));
  }

  let restrictIds: string[] | null = null;
  if (idFilters.length > 0) {
    restrictIds = Array.from(idFilters[0]).filter((id) => idFilters.every((s) => s.has(id)));
  }

  const searchTerm = query.search.trim();
  const employees = await prisma.employee.findMany({
    where: {
      ...(restrictIds ? { id: { in: restrictIds } } : {}),
      ...(searchTerm
        ? {
            OR: [
              { firstName: { contains: searchTerm, mode: 'insensitive' } },
              { lastName: { contains: searchTerm, mode: 'insensitive' } },
              { employeeNumber: { contains: searchTerm, mode: 'insensitive' } }
            ]
          }
        : {})
    },
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      profile: { select: { dateOfBirth: true } },
      employments: { select: { active: true, startDate: true, endDate: true } },
      professions: {
        orderBy: { createdAt: 'desc' },
        select: { definitionId: true, customName: true, customCategory: true, definition: { select: { code: true, category: true, nameEn: true, nameRu: true } } }
      },
      siteAssignments: {
        where: currentAssignmentWhere(today),
        select: { site: { select: { id: true, name: true } } }
      },
      qualifications: {
        select: {
          id: true,
          name: true,
          certificateNumber: true,
          issuer: true,
          issuedOn: true,
          expiresOn: true,
          verificationState: true,
          definition: { select: { code: true, category: true, nameRu: true, descriptionEn: true, descriptionRu: true, expiryMode: true } }
        }
      }
    }
  });

  const rows: QualificationMatrixRow[] = employees.map((employee) => {
    const chips: (QualificationChip & { code: string | null })[] = employee.qualifications.map((q) => {
      const expiryMode = q.definition?.expiryMode ?? (q.expiresOn ? 'OPTIONAL' : 'NONE');
      const expiry = computeQualificationExpiryStatus(expiryMode, q.expiresOn, today);
      return {
        employeeQualificationId: q.id,
        definitionCode: q.definition?.code ?? null,
        code: q.definition?.code ?? null,
        category: q.definition?.category ?? null,
        name: q.name,
        nameRu: q.definition?.nameRu ?? null,
        description: { en: q.definition?.descriptionEn ?? null, ru: q.definition?.descriptionRu ?? null },
        certificateNumber: q.certificateNumber,
        issuer: q.issuer,
        issuedOn: q.issuedOn ? formatDate(q.issuedOn) : null,
        expiresOn: q.expiresOn ? formatDate(q.expiresOn) : null,
        status: expiry.status,
        color: expiry.color,
        verificationState: q.verificationState
      };
    });

    const safetyCard = chips.find((c) => c.code === SAFETY_CODE) ?? null;
    const hotWorkCard = chips.find((c) => c.code === HOT_WORK_CODE) ?? null;
    const otherChips = chips.filter((c) => c.code !== SAFETY_CODE && c.code !== HOT_WORK_CODE);

    const ranks: number[] = [];
    const expiryDates: string[] = [];
    for (const indicator of [safetyCard, hotWorkCard]) {
      if (!indicator) {
        ranks.push(STATUS_RANK.MISSING);
      } else {
        ranks.push(STATUS_RANK[indicator.status]);
        if (indicator.expiresOn) expiryDates.push(indicator.expiresOn);
      }
    }
    for (const chip of otherChips) {
      ranks.push(STATUS_RANK[chip.status]);
      if (chip.expiresOn) expiryDates.push(chip.expiresOn);
    }
    const worstStatusRank = ranks.length > 0 ? Math.min(...ranks) : STATUS_RANK.VALID;
    const nearestExpiry = expiryDates.length > 0 ? expiryDates.sort()[0] : null;

    const professions: MatrixProfession[] = employee.professions.map((p) => ({
      id: p.definitionId ?? '',
      code: p.definition?.code ?? null,
      category: (p.definition?.category ?? p.customCategory) as ProfessionCategory,
      nameEn: p.definition?.nameEn ?? p.customName ?? '',
      nameRu: p.definition?.nameRu ?? null,
      isCustom: p.definitionId === null
    }));
    const currentSites = employee.siteAssignments
      .map((a) => ({ id: a.site.id, name: a.site.name }))
      .filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i);

    return {
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
      firstName: employee.firstName,
      lastName: employee.lastName,
      dateOfBirth: employee.profile?.dateOfBirth ? formatDate(employee.profile.dateOfBirth) : null,
      active: isActiveEmployee(employee.employments, today),
      professions,
      currentSites,
      safetyCard,
      hotWorkCard,
      otherChips,
      worstStatusRank,
      nearestExpiry
    };
  });

  const filtered = rows.filter((row) => {
    if (query.active === 'ACTIVE' && !row.active) return false;
    if (query.active === 'INACTIVE' && row.active) return false;

    if (query.qualificationCode) {
      const chip = [row.safetyCard, row.hotWorkCard, ...row.otherChips].find((c) => c?.definitionCode === query.qualificationCode);
      if (query.status === 'MISSING') {
        if (chip) return false;
      } else if (query.status !== 'ALL') {
        if (!chip || chip.status !== query.status) return false;
      } else if (!chip) {
        return false;
      }
      if (query.verification !== 'ALL' && chip && chip.verificationState !== query.verification) return false;
      if (query.verification !== 'ALL' && !chip) return false;
      return true;
    }

    // No specific qualification chosen — "All".
    const allChips = [row.safetyCard, row.hotWorkCard, ...row.otherChips].filter((c): c is QualificationChip & { code: string | null } => c !== null);
    if (query.status === 'MISSING') {
      if (row.safetyCard && row.hotWorkCard) return false;
    } else if (query.status !== 'ALL') {
      if (!allChips.some((c) => c.status === query.status)) return false;
    }
    if (query.verification !== 'ALL') {
      if (!allChips.some((c) => c.verificationState === query.verification)) return false;
    }
    return true;
  });

  const byName = (a: QualificationMatrixRow, b: QualificationMatrixRow) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName) || a.employeeId.localeCompare(b.employeeId);
  // '￿' reliably sorts after any real name, so rows with no profession / no current site land last.
  const firstProfessionName = (r: QualificationMatrixRow) => (r.professions[0] ? r.professions[0].nameEn || '￿' : '￿');
  const firstSiteName = (r: QualificationMatrixRow) => (r.currentSites[0] ? r.currentSites[0].name : '￿');

  const sorted = [...filtered].sort((a, b) => {
    if (query.sort === 'NAME') return byName(a, b);
    if (query.sort === 'NUMBER') return a.employeeNumber.localeCompare(b.employeeNumber, undefined, { numeric: true }) || byName(a, b);
    if (query.sort === 'PROFESSION') return firstProfessionName(a).localeCompare(firstProfessionName(b)) || byName(a, b);
    if (query.sort === 'CURRENT_SITE') return firstSiteName(a).localeCompare(firstSiteName(b)) || byName(a, b);
    if (query.sort === 'EXPIRY') {
      if (a.nearestExpiry === b.nearestExpiry) return byName(a, b);
      if (a.nearestExpiry === null) return 1;
      if (b.nearestExpiry === null) return -1;
      return a.nearestExpiry.localeCompare(b.nearestExpiry);
    }
    // ATTENTION (default): worst rank first, then nearest expiry, then name.
    if (a.worstStatusRank !== b.worstStatusRank) return a.worstStatusRank - b.worstStatusRank;
    if (a.nearestExpiry !== b.nearestExpiry) {
      if (a.nearestExpiry === null) return 1;
      if (b.nearestExpiry === null) return -1;
      return a.nearestExpiry.localeCompare(b.nearestExpiry);
    }
    return byName(a, b);
  });

  return sorted;
}

export async function getQualificationMatrix(query: QualificationMatrixQuery): Promise<QualificationMatrixResult> {
  const sorted = await buildWorkforceRows(query);
  const totalItems = sorted.length;
  const start = (query.page - 1) * query.pageSize;
  const items = sorted.slice(start, start + query.pageSize);
  return { items, page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / query.pageSize)) };
}

/** T13.6 — the whole filtered scope for a workforce PDF/CSV export. Hard row cap, so a runaway
 *  filter can't build a 10 000-page PDF. */
export const MAX_WORKFORCE_EXPORT_ROWS = 2000;

export type WorkforceScopeResult =
  | { ok: true; rows: QualificationMatrixRow[] }
  | { ok: false; code: 'REPORT_TOO_LARGE'; count: number; limit: number };

export async function resolveWorkforceScope(query: Omit<QualificationMatrixQuery, 'page' | 'pageSize'>): Promise<WorkforceScopeResult> {
  const rows = await buildWorkforceRows(query);
  if (rows.length > MAX_WORKFORCE_EXPORT_ROWS) {
    return { ok: false, code: 'REPORT_TOO_LARGE', count: rows.length, limit: MAX_WORKFORCE_EXPORT_ROWS };
  }
  return { ok: true, rows };
}
