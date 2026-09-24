import { Prisma } from '@prisma/client';
import type { NextRequest } from 'next/server';
import { authorizeDocumentRequest, documentJsonError } from '@/lib/document-api';
import { DocumentError, getDocumentSpace, normalizeDocumentName } from '@/lib/documents';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

export async function POST(request: NextRequest) {
  const auth = await authorizeDocumentRequest(request, 'document.create_folder', true);
  if (!auth.ok) return documentJsonError(auth.status, auth.code, auth.requestId);
  try {
    const body = await request.json() as { name?: unknown; parentId?: unknown };
    if (typeof body.name !== 'string' || (body.parentId != null && typeof body.parentId !== 'string')) throw new DocumentError('VALIDATION_ERROR');
    const parentId = typeof body.parentId === 'string' ? body.parentId : null;
    const parsed = normalizeDocumentName(body.name);
    const space = await getDocumentSpace();
    if (parentId && !(await prisma.documentFolder.findFirst({ where: { id: parentId, storageSpaceId: space.id } }))) throw new DocumentError('FOLDER_NOT_FOUND', '', 404);
    const folder = await prisma.$transaction(async (tx) => {
      const created = await tx.documentFolder.create({ data: { storageSpaceId: space.id, parentId, ...parsed, createdByUserId: auth.session.user.id } });
      await createAuditEvent(tx, { actorUserId: auth.session.user.id, eventType: 'DOCUMENT_FOLDER_CREATED', entityType: 'DOCUMENT_FOLDER', entityId: created.id, requestId: auth.requestId, afterValue: { name: created.name, parentId: created.parentId } });
      return created;
    });
    return Response.json({ folder: { id: folder.id, name: folder.name, parentId: folder.parentId } }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return documentJsonError(409, 'DOCUMENT_NAME_CONFLICT', auth.requestId);
    if (error instanceof DocumentError) return documentJsonError(error.status, error.code, auth.requestId);
    return documentJsonError(400, 'VALIDATION_ERROR', auth.requestId);
  }
}
