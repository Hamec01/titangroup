import { prisma } from '@/lib/prisma';
import { helsinkiCalendarDateAsUtcMidnight } from '@/lib/attendance-clock';
import { computeQualificationExpiryStatus, type QualificationExpiryStatus, type QualificationStatusColor } from '@/lib/qualification-expiry';

// /admin/qualifications — task spec §16-20. Filtering/sorting/pagination all happen here, on
// the server, over the full Employee set (this app's worker counts are company-scale, not
// millions — an in-memory pass after one bounded query is the same "don't ship rows to the
// browser and filter client-side" guarantee the task asks for, without needing per-status SQL
// date arithmetic). Reuses lib/qualification-expiry.ts for every status computation — never
// recomputed ad hoc.

export type MatrixStatusFilter = 'ALL' | QualificationExpiryStatus | 'MISSING';
export type MatrixVerificationFilter = 'ALL' | 'VERIFIED' | 'SELF_REPORTED';
export type MatrixSort = 'ATTENTION' | 'NAME' | 'EXPIRY';

export interface QualificationMatrixQuery {
  search: string;
  qualificationCode: string | null;
  status: MatrixStatusFilter;
  siteId: string | null;
  verification: MatrixVerificationFilter;
  sort: MatrixSort;
  page: number;
  pageSize: number;
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
  return { validFrom: { lte: today }, OR: [{ validTo: null }, { validTo: { gte: today } }] };
}

export async function getQualificationMatrix(query: QualificationMatrixQuery): Promise<QualificationMatrixResult> {
  const today = helsinkiCalendarDateAsUtcMidnight(new Date());

  let siteEmployeeIds: Set<string> | null = null;
  if (query.siteId) {
    const assignments = await prisma.siteAssignment.findMany({
      where: { siteId: query.siteId, ...currentAssignmentWhere(today) },
      select: { employeeId: true }
    });
    siteEmployeeIds = new Set(assignments.map((a) => a.employeeId));
  }

  const searchTerm = query.search.trim();
  const employees = await prisma.employee.findMany({
    where: {
      ...(siteEmployeeIds ? { id: { in: Array.from(siteEmployeeIds) } } : {}),
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

    return {
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
      firstName: employee.firstName,
      lastName: employee.lastName,
      dateOfBirth: employee.profile?.dateOfBirth ? formatDate(employee.profile.dateOfBirth) : null,
      safetyCard,
      hotWorkCard,
      otherChips,
      worstStatusRank,
      nearestExpiry
    };
  });

  const filtered = rows.filter((row) => {
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

  const sorted = [...filtered].sort((a, b) => {
    if (query.sort === 'NAME') {
      return a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);
    }
    if (query.sort === 'EXPIRY') {
      if (a.nearestExpiry === b.nearestExpiry) return a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);
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
    return a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);
  });

  const totalItems = sorted.length;
  const start = (query.page - 1) * query.pageSize;
  const items = sorted.slice(start, start + query.pageSize);

  return { items, page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / query.pageSize)) };
}
