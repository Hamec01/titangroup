import type { NextRequest } from 'next/server';
import { authorizeDocumentRequest, documentJsonError } from '@/lib/document-api';
import { documentStorageConfigured } from '@/lib/document-storage';
import { getDocumentSpace, serializeSpace } from '@/lib/documents';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await authorizeDocumentRequest(request, 'document.read');
  if (!auth.ok) return documentJsonError(auth.status, auth.code, auth.requestId);
  const space = await getDocumentSpace();
  const grouped = await prisma.documentFile.groupBy({ by: ['category'], where: { storageSpaceId: space.id, status: 'ACTIVE' }, _sum: { sizeBytes: true } });
  return Response.json({ storage: serializeSpace(space), categories: Object.fromEntries(grouped.map((g) => [g.category, (g._sum.sizeBytes ?? BigInt(0)).toString()])), available: documentStorageConfigured() }, { headers: { 'Cache-Control': 'no-store' } });
}
