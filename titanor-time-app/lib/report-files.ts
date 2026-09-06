import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §7 — the ReportFile service.
// Every write goes through here so the FK/CHECK guard rails (20260906210000_harden_report_files)
// are never the first line of defence, and so REPORT_FILE_CREATED / REPORT_FILE_DELETED land in
// AuditEvent inside the same transaction as the row change (lib/audit.ts contract).

export type ReportFileFormat = 'CSV' | 'PDF';
export type ReportType = 'PERIOD_SUMMARY' | 'SITE_DETAIL' | 'WORKER_DETAIL';

export const REPORT_FILE_FORMATS: readonly ReportFileFormat[] = ['CSV', 'PDF'];
export const REPORT_FILE_TYPES: readonly ReportType[] = ['PERIOD_SUMMARY', 'SITE_DETAIL', 'WORKER_DETAIL'];

/** Documented single-file ceiling (docs §7.7). Mirrors CK-55 in 20260906210000_harden_report_files.
 * A company-wide period / site / worker working report is a few MB at the very most. */
export const REPORT_FILE_MAX_BYTES = 26_214_400; // 25 MiB

/** Served Content-Type per format — pinned, and re-asserted by CK-57. */
export const REPORT_FILE_MIME: Record<ReportFileFormat, string> = {
  PDF: 'application/pdf',
  CSV: 'text/csv; charset=utf-8'
};

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
const FILE_NAME_PATTERN = /^[A-Za-z0-9._ -]{1,255}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export class ReportFileValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string
  ) {
    super(message);
    this.name = 'ReportFileValidationError';
  }
}

export interface ReportFileSummary {
  id: string;
  periodId: string | null;
  reportType: string;
  format: ReportFileFormat;
  fileName: string;
  mimeType: string;
  fileHash: string;
  fileSizeBytes: number;
  rowCount: number | null;
  createdByUserId: string;
  createdAt: string;
  downloadUrl: string;
}

const SUMMARY_SELECT = {
  id: true,
  periodId: true,
  reportType: true,
  format: true,
  fileName: true,
  mimeType: true,
  fileHash: true,
  fileSizeBytes: true,
  rowCount: true,
  createdByUserId: true,
  createdAt: true
} as const;

function toSummary(file: {
  id: string;
  periodId: string | null;
  reportType: string;
  format: string;
  fileName: string;
  mimeType: string;
  fileHash: string;
  fileSizeBytes: number;
  rowCount: number | null;
  createdByUserId: string;
  createdAt: Date;
}): ReportFileSummary {
  return {
    ...file,
    format: file.format as ReportFileFormat,
    createdAt: file.createdAt.toISOString(),
    downloadUrl: `/api/admin/report-files/${file.id}/download`
  };
}

/** AuditEvent before/after payload — file metadata only, never the bytes, never anything secret. */
function auditPayload(file: {
  periodId: string | null;
  reportType: string;
  format: string;
  fileName: string;
  fileSizeBytes: number;
  fileHash: string;
  rowCount: number | null;
}): Prisma.InputJsonValue {
  return {
    periodId: file.periodId,
    reportType: file.reportType,
    format: file.format,
    fileName: file.fileName,
    fileSizeBytes: file.fileSizeBytes,
    fileHash: file.fileHash,
    rowCount: file.rowCount
  };
}

export interface ReportFilesQueryInput {
  page: string | null;
  pageSize: string | null;
}

export type ReportFilesQueryResult =
  | { ok: true; page: number; pageSize: number }
  | { ok: false; fieldErrors: Record<string, string[]> };

/** Mirrors parsePeriodReportQuery / parseSiteReportQuery — the saved-files history is paginated in
 * the URL, never a hidden take=100 (docs §3.1, §7.9). */
export function parseReportFilesQuery(input: ReportFilesQueryInput): ReportFilesQueryResult {
  const fieldErrors: Record<string, string[]> = {};

  let page = 1;
  if (input.page !== null && input.page !== '') {
    const parsed = Number(input.page);
    if (!Number.isInteger(parsed) || parsed < 1) {
      fieldErrors.page = ['must be a positive integer'];
    } else {
      page = parsed;
    }
  }

  let pageSize = DEFAULT_PAGE_SIZE;
  if (input.pageSize !== null && input.pageSize !== '') {
    const parsed = Number(input.pageSize);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
      fieldErrors.pageSize = [`must be an integer between 1 and ${MAX_PAGE_SIZE}`];
    } else {
      pageSize = parsed;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, page, pageSize };
}

export interface ReportFilesPage {
  items: ReportFileSummary[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export async function listReportFiles(opts: {
  periodId?: string | null;
  page: number;
  pageSize: number;
}): Promise<ReportFilesPage> {
  const page = Number.isInteger(opts.page) && opts.page > 0 ? opts.page : 1;
  const pageSize =
    Number.isInteger(opts.pageSize) && opts.pageSize > 0 && opts.pageSize <= MAX_PAGE_SIZE ? opts.pageSize : DEFAULT_PAGE_SIZE;
  const where = opts.periodId ? { periodId: opts.periodId } : {};

  // One transaction so the count and the page slice agree even under a concurrent create/delete.
  const [totalItems, rows] = await prisma.$transaction([
    prisma.reportFile.count({ where }),
    prisma.reportFile.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: SUMMARY_SELECT
    })
  ]);

  return {
    items: rows.map(toSummary),
    page,
    pageSize,
    totalItems,
    totalPages: Math.max(1, Math.ceil(totalItems / pageSize))
  };
}

export interface CreateReportFileInput {
  periodId?: string | null;
  reportType: ReportType;
  format: ReportFileFormat;
  fileName: string;
  content: Buffer;
  rowCount?: number | null;
  createdByUserId: string;
  requestId: string;
}

export async function createReportFile(input: CreateReportFileInput): Promise<ReportFileSummary> {
  if (!REPORT_FILE_FORMATS.includes(input.format)) {
    throw new ReportFileValidationError('format', 'format must be one of PDF, CSV.');
  }
  if (!REPORT_FILE_TYPES.includes(input.reportType)) {
    throw new ReportFileValidationError('reportType', `reportType must be one of ${REPORT_FILE_TYPES.join(', ')}.`);
  }
  if (!FILE_NAME_PATTERN.test(input.fileName)) {
    throw new ReportFileValidationError('fileName', 'fileName may only contain letters, digits, dot, underscore, space and hyphen (1..255).');
  }
  if (!Buffer.isBuffer(input.content) || input.content.byteLength === 0) {
    throw new ReportFileValidationError('content', 'content must be a non-empty buffer.');
  }
  if (input.content.byteLength > REPORT_FILE_MAX_BYTES) {
    throw new ReportFileValidationError('content', `content exceeds the ${REPORT_FILE_MAX_BYTES}-byte limit.`);
  }
  if (input.rowCount != null && (!Number.isInteger(input.rowCount) || input.rowCount < 0)) {
    throw new ReportFileValidationError('rowCount', 'rowCount must be null or a non-negative integer.');
  }

  const fileHash = createHash('sha256').update(input.content).digest('hex');
  const mimeType = REPORT_FILE_MIME[input.format];
  const fileSizeBytes = input.content.byteLength;

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.reportFile.create({
      data: {
        periodId: input.periodId ?? null,
        reportType: input.reportType,
        format: input.format,
        fileName: input.fileName,
        mimeType,
        fileHash,
        fileSizeBytes,
        rowCount: input.rowCount ?? null,
        content: new Uint8Array(input.content) as Uint8Array<ArrayBuffer>,
        createdByUserId: input.createdByUserId
      },
      select: SUMMARY_SELECT
    });
    await createAuditEvent(tx, {
      actorUserId: input.createdByUserId,
      eventType: 'REPORT_FILE_CREATED',
      entityType: 'ReportFile',
      entityId: row.id,
      requestId: input.requestId,
      afterValue: auditPayload(row)
    });
    return row;
  });

  return toSummary(created);
}

export interface ReportFileDownload {
  fileName: string;
  mimeType: string;
  format: ReportFileFormat;
  fileHash: string;
  fileSizeBytes: number;
  content: Buffer;
}

export async function getReportFileDownload(id: string): Promise<ReportFileDownload | null> {
  const row = await prisma.reportFile.findUnique({
    where: { id },
    select: { fileName: true, mimeType: true, format: true, fileHash: true, fileSizeBytes: true, content: true }
  });
  if (!row) return null;
  return {
    fileName: row.fileName,
    mimeType: row.mimeType,
    format: row.format as ReportFileFormat,
    fileHash: row.fileHash,
    fileSizeBytes: row.fileSizeBytes,
    content: Buffer.from(row.content)
  };
}

/** Re-checks the stored bytes against the recorded hash + size before the download route serves
 * them (docs §7 "проверить hash и размер перед возвратом"). The CHECK constraints already pin
 * fileSizeBytes = octet_length(content) and the hash *format*; this is the extra hash-*content*
 * check that no column constraint can express. Report files are small, so recomputing SHA-256 on
 * every download is cheap. */
export function verifyReportFileIntegrity(file: ReportFileDownload): boolean {
  if (file.content.byteLength !== file.fileSizeBytes) return false;
  if (!SHA256_HEX_PATTERN.test(file.fileHash)) return false;
  return createHash('sha256').update(file.content).digest('hex') === file.fileHash;
}

/** Physical delete of a working file — allowed by design (docs §7.12), but the fact of deletion
 * stays in AuditEvent. Returns false when the row does not exist (already deleted / never
 * existed) so the route can answer a clean 404. */
export async function deleteReportFile(id: string, actorUserId: string, requestId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.reportFile.findUnique({
      where: { id },
      select: { id: true, periodId: true, reportType: true, format: true, fileName: true, fileSizeBytes: true, fileHash: true, rowCount: true }
    });
    if (!existing) return false;

    await tx.reportFile.delete({ where: { id } });
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'REPORT_FILE_DELETED',
      entityType: 'ReportFile',
      entityId: existing.id,
      requestId,
      beforeValue: auditPayload(existing)
    });
    return true;
  });
}
