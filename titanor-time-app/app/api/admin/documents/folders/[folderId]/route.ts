import { Prisma } from '@prisma/client';
import type { NextRequest } from 'next/server';
import { authorizeDocumentRequest, documentJsonError } from '@/lib/document-api';
import { DocumentError, MAX_FOLDER_DEPTH, getDocumentSpace, normalizeDocumentName } from '@/lib/documents';
import { deleteDocumentObject } from '@/lib/document-storage';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

type Params = { params: Promise<{ folderId: string }> };

async function assertMoveAllowed(folderId: string, parentId: string | null, storageSpaceId: string) {
  if (!parentId) return;
  if (parentId === folderId) throw new DocumentError('FOLDER_MOVE_CYCLE', '', 409);
  let cursor: string | null = parentId;
  for (let depth = 0; cursor; depth += 1) {
    if (depth >= MAX_FOLDER_DEPTH) throw new DocumentError('FOLDER_DEPTH_EXCEEDED', '', 409);
    if (cursor === folderId) throw new DocumentError('FOLDER_MOVE_CYCLE', '', 409);
    const row: { parentId: string | null } | null = await prisma.documentFolder.findFirst({ where: { id: cursor, storageSpaceId }, select: { parentId: true } });
    if (!row) throw new DocumentError('FOLDER_NOT_FOUND', '', 404);
    cursor = row.parentId;
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await authorizeDocumentRequest(request, 'document.rename', true);
  if (!auth.ok) return documentJsonError(auth.status, auth.code, auth.requestId);
  const { folderId } = await params;
  try {
    const body = await request.json() as { name?: unknown; parentId?: unknown };
    const space = await getDocumentSpace();
    const current = await prisma.documentFolder.findFirst({ where: { id: folderId, storageSpaceId: space.id } });
    if (!current) throw new DocumentError('FOLDER_NOT_FOUND', '', 404);
    const data: { name?: string; normalizedName?: string; parentId?: string | null } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string') throw new DocumentError('VALIDATION_ERROR');
      Object.assign(data, normalizeDocumentName(body.name));
    }
    if (body.parentId !== undefined) {
      if (body.parentId !== null && typeof body.parentId !== 'string') throw new DocumentError('VALIDATION_ERROR');
      await assertMoveAllowed(folderId, body.parentId, space.id);
      data.parentId = body.parentId;
    }
    if (Object.keys(data).length === 0) throw new DocumentError('VALIDATION_ERROR');
    const folder = await prisma.$transaction(async (tx) => {
      const updated = await tx.documentFolder.update({ where: { id: folderId }, data });
      await createAuditEvent(tx, { actorUserId: auth.session.user.id, eventType: body.parentId !== undefined ? 'DOCUMENT_FOLDER_MOVED' : 'DOCUMENT_FOLDER_RENAMED', entityType: 'DOCUMENT_FOLDER', entityId: folderId, requestId: auth.requestId, beforeValue: { name: current.name, parentId: current.parentId }, afterValue: { name: updated.name, parentId: updated.parentId } });
      return updated;
    });
    return Response.json({ folder: { id: folder.id, name: folder.name, parentId: folder.parentId } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return documentJsonError(409, 'DOCUMENT_NAME_CONFLICT', auth.requestId);
    if (error instanceof DocumentError) return documentJsonError(error.status, error.code, auth.requestId);
    return documentJsonError(400, 'VALIDATION_ERROR', auth.requestId);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await authorizeDocumentRequest(request, 'document.delete', true);
  if (!auth.ok) return documentJsonError(auth.status, auth.code, auth.requestId);
  const { folderId } = await params;
  const space = await getDocumentSpace();
  const root = await prisma.documentFolder.findFirst({ where: { id: folderId, storageSpaceId: space.id } });
  if (!root) return documentJsonError(404, 'FOLDER_NOT_FOUND', auth.requestId);
  const folders = [folderId];
  for (let i = 0; i < folders.length; i += 1) {
    const children = await prisma.documentFolder.findMany({ where: { parentId: folders[i], storageSpaceId: space.id }, select: { id: true } });
    folders.push(...children.map((c) => c.id));
  }
  const files = await prisma.documentFile.findMany({ where: { folderId: { in: folders }, storageSpaceId: space.id }, select: { id: true, storageKey: true, sizeBytes: true, status: true } });
  await prisma.documentFile.updateMany({ where: { id: { in: files.map((f) => f.id) } }, data: { status: 'DELETING' } });
  try {
    for (const file of files) await deleteDocumentObject(file.storageKey);
  } catch {
    await prisma.documentFile.updateMany({ where: { id: { in: files.map((f) => f.id) } }, data: { status: 'ACTIVE' } });
    return documentJsonError(503, 'DOCUMENT_STORAGE_UNAVAILABLE', auth.requestId);
  }
  const bytes = files.reduce((sum, f) => sum + f.sizeBytes, BigInt(0));
  await prisma.$transaction(async (tx) => {
    if (files.length) await tx.documentFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
    for (const id of [...folders].reverse()) await tx.documentFolder.delete({ where: { id } });
    if (bytes) await tx.storageSpace.update({ where: { id: space.id }, data: { usedBytes: { decrement: bytes } } });
    await createAuditEvent(tx, { actorUserId: auth.session.user.id, eventType: 'DOCUMENT_FOLDER_DELETED', entityType: 'DOCUMENT_FOLDER', entityId: folderId, requestId: auth.requestId, beforeValue: { name: root.name, fileCount: files.length, sizeBytes: bytes.toString() } });
  });
  return new Response(null, { status: 204 });
}
