import type { NextRequest } from 'next/server';
import { authorizeDocumentRequest, documentJsonError } from '@/lib/document-api';
import { getDocumentSpace, serializeSpace } from '@/lib/documents';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await authorizeDocumentRequest(request, 'document.read');
  if (!auth.ok) return documentJsonError(auth.status, auth.code, auth.requestId);
  const folderId = request.nextUrl.searchParams.get('folderId');
  if (request.nextUrl.searchParams.getAll('folderId').length > 1) return documentJsonError(400, 'VALIDATION_ERROR', auth.requestId);
  const space = await getDocumentSpace();
  const current = folderId ? await prisma.documentFolder.findFirst({ where: { id: folderId, storageSpaceId: space.id } }) : null;
  if (folderId && !current) return documentJsonError(404, 'FOLDER_NOT_FOUND', auth.requestId);
  const [folders, files] = await Promise.all([
    prisma.documentFolder.findMany({ where: { storageSpaceId: space.id, parentId: folderId }, orderBy: { name: 'asc' }, include: { _count: { select: { children: true, files: true } } } }),
    prisma.documentFile.findMany({ where: { storageSpaceId: space.id, folderId, status: 'ACTIVE' }, orderBy: { displayName: 'asc' } })
  ]);
  const breadcrumbs: Array<{ id: string; name: string }> = [];
  let cursor = current;
  for (let depth = 0; cursor && depth < 32; depth += 1) {
    breadcrumbs.unshift({ id: cursor.id, name: cursor.name });
    cursor = cursor.parentId ? await prisma.documentFolder.findUnique({ where: { id: cursor.parentId } }) : null;
  }
  return Response.json({ folder: current ? { id: current.id, name: current.name } : null, breadcrumbs, folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, updatedAt: f.updatedAt, itemCount: f._count.children + f._count.files })), files: files.map((f) => ({ id: f.id, displayName: f.displayName, mimeType: f.mimeType, category: f.category, sizeBytes: f.sizeBytes.toString(), updatedAt: f.updatedAt })), storage: serializeSpace(space) }, { headers: { 'Cache-Control': 'no-store' } });
}
