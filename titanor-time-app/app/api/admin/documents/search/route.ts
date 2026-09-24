import type { NextRequest } from 'next/server';
import { authorizeDocumentRequest, documentJsonError } from '@/lib/document-api';
import { getDocumentSpace } from '@/lib/documents';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const auth = await authorizeDocumentRequest(request, 'document.read');
  if (!auth.ok) return documentJsonError(auth.status, auth.code, auth.requestId);
  const q = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < 2 || q.length > 100) return documentJsonError(400, 'VALIDATION_ERROR', auth.requestId);
  const space = await getDocumentSpace();
  const [folders, files] = await Promise.all([
    prisma.documentFolder.findMany({ where: { storageSpaceId: space.id, name: { contains: q, mode: 'insensitive' } }, take: 100, orderBy: { name: 'asc' } }),
    prisma.documentFile.findMany({ where: { storageSpaceId: space.id, status: 'ACTIVE', displayName: { contains: q, mode: 'insensitive' } }, take: 100, orderBy: { displayName: 'asc' } })
  ]);
  return Response.json({ folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })), files: files.map((f) => ({ id: f.id, displayName: f.displayName, folderId: f.folderId, sizeBytes: f.sizeBytes.toString(), category: f.category })) }, { headers: { 'Cache-Control': 'no-store' } });
}
