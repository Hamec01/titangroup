import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { DEFAULT_MAX_FILE_BYTES, DOCUMENT_QUOTA_BYTES, deleteDocumentObject, type StoredObject } from '@/lib/document-storage';

export const DOCUMENT_SPACE_NAME = 'Titanor Documents';
export const MAX_FOLDER_DEPTH = 32;

export class DocumentError extends Error {
  constructor(public code: string, message = code, public status = 400) { super(message); }
}

export function normalizeDocumentName(input: string): { name: string; normalizedName: string } {
  const name = input.normalize('NFC').trim();
  if (!name || name.length > 255 || /[\u0000-\u001f/\\]/u.test(name) || name === '.' || name === '..') {
    throw new DocumentError('INVALID_DOCUMENT_NAME');
  }
  return { name, normalizedName: name.toLocaleLowerCase('en-US') };
}

export function classifyDocument(mimeType: string, extension: string | null): string {
  if (mimeType.startsWith('image/')) return 'IMAGE';
  if (mimeType.startsWith('video/')) return 'VIDEO';
  if (mimeType === 'application/pdf') return 'PDF';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension ?? '')) return 'ARCHIVE';
  if (/^(text\/|application\/(msword|vnd\.|rtf|json|xml))/i.test(mimeType)) return 'DOCUMENT';
  return 'OTHER';
}

export function splitFileName(input: string) {
  const { name, normalizedName } = normalizeDocumentName(input);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase().slice(0, 32) : null;
  return { name, normalizedName, extension };
}

export async function getDocumentSpace() {
  const space = await prisma.storageSpace.findUnique({ where: { name: DOCUMENT_SPACE_NAME } });
  if (!space) throw new DocumentError('DOCUMENT_STORAGE_NOT_INITIALIZED', 'Document storage is not initialized.', 503);
  return space;
}

export async function reserveDocumentBytes(actorUserId: string, sizeBytes: bigint): Promise<{ id: string; storageSpaceId: string }> {
  const max = BigInt(process.env.DOCUMENT_MAX_FILE_BYTES || DEFAULT_MAX_FILE_BYTES.toString());
  if (sizeBytes <= BigInt(0) || sizeBytes > max) throw new DocumentError('FILE_TOO_LARGE', 'Invalid file size.', 413);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; quotaBytes: bigint; usedBytes: bigint; reservedBytes: bigint }>>`
      SELECT "id", "quotaBytes", "usedBytes", "reservedBytes" FROM "StorageSpace" WHERE "name"=${DOCUMENT_SPACE_NAME} FOR UPDATE`;
    const space = rows[0];
    if (!space) throw new DocumentError('DOCUMENT_STORAGE_NOT_INITIALIZED', 'Document storage is not initialized.', 503);
    const expired = await tx.documentUploadReservation.aggregate({ where: { storageSpaceId: space.id, expiresAt: { lt: new Date() } }, _sum: { sizeBytes: true } });
    const expiredBytes = expired._sum.sizeBytes ?? BigInt(0);
    if (expiredBytes > BigInt(0)) {
      await tx.documentUploadReservation.deleteMany({ where: { storageSpaceId: space.id, expiresAt: { lt: new Date() } } });
      await tx.storageSpace.update({ where: { id: space.id }, data: { reservedBytes: { decrement: expiredBytes } } });
    }
    const reserved = space.reservedBytes - expiredBytes;
    if (space.usedBytes + reserved + sizeBytes > space.quotaBytes) throw new DocumentError('STORAGE_QUOTA_EXCEEDED', 'Insufficient storage space.', 409);
    const reservation = await tx.documentUploadReservation.create({ data: { storageSpaceId: space.id, createdByUserId: actorUserId, sizeBytes, expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
    await tx.storageSpace.update({ where: { id: space.id }, data: { reservedBytes: { increment: sizeBytes } } });
    return { id: reservation.id, storageSpaceId: space.id };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function releaseDocumentReservation(id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const reservation = await tx.documentUploadReservation.findUnique({ where: { id } });
    if (!reservation) return;
    await tx.documentUploadReservation.delete({ where: { id } });
    await tx.storageSpace.update({ where: { id: reservation.storageSpaceId }, data: { reservedBytes: { decrement: reservation.sizeBytes } } });
  });
}

export async function finishDocumentUpload(input: { reservationId: string; folderId: string | null; originalName: string; mimeType: string; stored: StoredObject; actorUserId: string; requestId: string }) {
  const parsed = splitFileName(input.originalName);
  try {
    return await prisma.$transaction(async (tx) => {
      const reservation = await tx.documentUploadReservation.findUnique({ where: { id: input.reservationId } });
      if (!reservation || reservation.createdByUserId !== input.actorUserId || reservation.sizeBytes !== input.stored.sizeBytes) throw new DocumentError('UPLOAD_RESERVATION_INVALID', 'Upload reservation is invalid.', 409);
      if (input.folderId) {
        const folder = await tx.documentFolder.findFirst({ where: { id: input.folderId, storageSpaceId: reservation.storageSpaceId }, select: { id: true } });
        if (!folder) throw new DocumentError('FOLDER_NOT_FOUND', 'Folder not found.', 404);
      }
      const file = await tx.documentFile.create({ data: { storageSpaceId: reservation.storageSpaceId, folderId: input.folderId, originalName: parsed.name, displayName: parsed.name, normalizedName: parsed.normalizedName, extension: parsed.extension, mimeType: input.mimeType.slice(0, 255) || 'application/octet-stream', category: classifyDocument(input.mimeType, parsed.extension), sizeBytes: input.stored.sizeBytes, storageKey: input.stored.storageKey, checksumSha256: input.stored.checksumSha256, createdByUserId: input.actorUserId } });
      await tx.documentUploadReservation.delete({ where: { id: reservation.id } });
      await tx.storageSpace.update({ where: { id: reservation.storageSpaceId }, data: { reservedBytes: { decrement: reservation.sizeBytes }, usedBytes: { increment: reservation.sizeBytes } } });
      await createAuditEvent(tx, { actorUserId: input.actorUserId, eventType: 'DOCUMENT_FILE_UPLOADED', entityType: 'DOCUMENT_FILE', entityId: file.id, requestId: input.requestId, afterValue: { fileName: file.displayName, sizeBytes: file.sizeBytes.toString(), folderId: file.folderId } });
      return file;
    });
  } catch (error) {
    await deleteDocumentObject(input.stored.storageKey).catch(() => undefined);
    await releaseDocumentReservation(input.reservationId).catch(() => undefined);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new DocumentError('DOCUMENT_NAME_CONFLICT', 'An item with this name already exists.', 409);
    throw error;
  }
}

export function serializeSpace(space: { quotaBytes: bigint; usedBytes: bigint; reservedBytes: bigint }) {
  return { quotaBytes: space.quotaBytes.toString(), usedBytes: space.usedBytes.toString(), reservedBytes: space.reservedBytes.toString(), freeBytes: (space.quotaBytes - space.usedBytes - space.reservedBytes).toString(), configuredQuotaBytes: DOCUMENT_QUOTA_BYTES.toString() };
}
