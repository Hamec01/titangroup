import { Prisma } from '@prisma/client';
import type { NextRequest } from 'next/server';
import { authorizeDocumentRequest, documentJsonError } from '@/lib/document-api';
import { DocumentError, getDocumentSpace, splitFileName } from '@/lib/documents';
import { deleteDocumentObject } from '@/lib/document-storage';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

type Params = { params: Promise<{ fileId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await authorizeDocumentRequest(request, 'document.rename', true);
  if (!auth.ok) return documentJsonError(auth.status, auth.code, auth.requestId);
  const { fileId } = await params;
  try {
    const body = await request.json() as { name?: unknown; folderId?: unknown };
    const current = await prisma.documentFile.findFirst({ where: { id: fileId, status: 'ACTIVE' } });
    if (!current) throw new DocumentError('FILE_NOT_FOUND', '', 404);
    const data: { displayName?: string; normalizedName?: string; extension?: string | null; folderId?: string | null } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string') throw new DocumentError('VALIDATION_ERROR');
      const parsed = splitFileName(body.name);
      Object.assign(data, { displayName: parsed.name, normalizedName: parsed.normalizedName, extension: parsed.extension });
    }
    if (body.folderId !== undefined) {
      if (body.folderId !== null && typeof body.folderId !== 'string') throw new DocumentError('VALIDATION_ERROR');
      if (body.folderId && !(await prisma.documentFolder.findFirst({ where: { id: body.folderId, storageSpaceId: current.storageSpaceId } }))) throw new DocumentError('FOLDER_NOT_FOUND', '', 404);
      data.folderId = body.folderId;
    }
    if (!Object.keys(data).length) throw new DocumentError('VALIDATION_ERROR');
    const file = await prisma.$transaction(async (tx) => {
      const updated = await tx.documentFile.update({ where: { id: fileId }, data });
      await createAuditEvent(tx, { actorUserId: auth.session.user.id, eventType: body.folderId !== undefined ? 'DOCUMENT_FILE_MOVED' : 'DOCUMENT_FILE_RENAMED', entityType: 'DOCUMENT_FILE', entityId: fileId, requestId: auth.requestId, beforeValue: { name: current.displayName, folderId: current.folderId }, afterValue: { name: updated.displayName, folderId: updated.folderId } });
      return updated;
    });
    return Response.json({ file: { id: file.id, displayName: file.displayName, folderId: file.folderId } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return documentJsonError(409, 'DOCUMENT_NAME_CONFLICT', auth.requestId);
    if (error instanceof DocumentError) return documentJsonError(error.status, error.code, auth.requestId);
    return documentJsonError(400, 'VALIDATION_ERROR', auth.requestId);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await authorizeDocumentRequest(request, 'document.delete', true);
  if (!auth.ok) return documentJsonError(auth.status, auth.code, auth.requestId);
  const { fileId } = await params;
  const file = await prisma.documentFile.findFirst({ where: { id: fileId, status: 'ACTIVE' } });
  if (!file) return documentJsonError(404, 'FILE_NOT_FOUND', auth.requestId);
  await prisma.documentFile.update({ where: { id: file.id }, data: { status: 'DELETING' } });
  try { await deleteDocumentObject(file.storageKey); } catch {
    await prisma.documentFile.update({ where: { id: file.id }, data: { status: 'ACTIVE' } });
    return documentJsonError(503, 'DOCUMENT_STORAGE_UNAVAILABLE', auth.requestId);
  }
  await prisma.$transaction(async (tx) => {
    await tx.documentFile.delete({ where: { id: file.id } });
    await tx.storageSpace.update({ where: { id: file.storageSpaceId }, data: { usedBytes: { decrement: file.sizeBytes } } });
    await createAuditEvent(tx, { actorUserId: auth.session.user.id, eventType: 'DOCUMENT_FILE_DELETED', entityType: 'DOCUMENT_FILE', entityId: file.id, requestId: auth.requestId, beforeValue: { name: file.displayName, folderId: file.folderId, sizeBytes: file.sizeBytes.toString() } });
  });
  return new Response(null, { status: 204 });
}
