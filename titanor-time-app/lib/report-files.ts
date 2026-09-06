import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';

export type ReportFileFormat = 'CSV' | 'PDF';

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

function toSummary(file: {
  id: string; periodId: string | null; reportType: string; format: string; fileName: string;
  mimeType: string; fileHash: string; fileSizeBytes: number; rowCount: number | null;
  createdByUserId: string; createdAt: Date;
}): ReportFileSummary {
  return { ...file, format: file.format as ReportFileFormat, createdAt: file.createdAt.toISOString(), downloadUrl: `/api/admin/report-files/${file.id}/download` };
}

export async function createReportFile(input: {
  periodId?: string | null;
  reportType: string;
  format: ReportFileFormat;
  fileName: string;
  mimeType: string;
  content: Buffer;
  rowCount?: number | null;
  createdByUserId: string;
}): Promise<ReportFileSummary> {
  const fileHash = createHash('sha256').update(input.content).digest('hex');
  const row = await prisma.reportFile.create({
    data: {
      periodId: input.periodId ?? null,
      reportType: input.reportType,
      format: input.format,
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileHash,
      fileSizeBytes: input.content.byteLength,
      rowCount: input.rowCount ?? null,
      content: new Uint8Array(input.content) as Uint8Array<ArrayBuffer>,
      createdByUserId: input.createdByUserId
    },
    select: { id: true, periodId: true, reportType: true, format: true, fileName: true, mimeType: true, fileHash: true, fileSizeBytes: true, rowCount: true, createdByUserId: true, createdAt: true }
  });
  return toSummary(row);
}

export async function listReportFiles(periodId?: string): Promise<ReportFileSummary[]> {
  const rows = await prisma.reportFile.findMany({
    where: periodId ? { periodId } : undefined,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
    select: { id: true, periodId: true, reportType: true, format: true, fileName: true, mimeType: true, fileHash: true, fileSizeBytes: true, rowCount: true, createdByUserId: true, createdAt: true }
  });
  return rows.map(toSummary);
}

export async function getReportFileDownload(id: string) {
  return prisma.reportFile.findUnique({ where: { id }, select: { fileName: true, mimeType: true, fileHash: true, fileSizeBytes: true, content: true } });
}

export async function deleteReportFile(id: string): Promise<boolean> {
  const result = await prisma.reportFile.deleteMany({ where: { id } });
  return result.count === 1;
}
