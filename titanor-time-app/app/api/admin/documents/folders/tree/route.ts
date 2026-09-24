import type { NextRequest } from 'next/server';
import { authorizeDocumentRequest, documentJsonError } from '@/lib/document-api';
import { getDocumentSpace } from '@/lib/documents';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await authorizeDocumentRequest(request, 'document.read');
  if (!auth.ok) return documentJsonError(auth.status, auth.code, auth.requestId);
  const space = await getDocumentSpace();
  const rows = await prisma.documentFolder.findMany({
    where: { storageSpaceId: space.id },
    select: { id: true, parentId: true, name: true },
    orderBy: [{ parentId: 'asc' }, { name: 'asc' }],
    take: 2001
  });
  if (rows.length > 2000) return documentJsonError(409, 'TOO_MANY_FOLDERS', auth.requestId);

  const byParent = new Map<string | null, typeof rows>();
  for (const row of rows) byParent.set(row.parentId, [...(byParent.get(row.parentId) ?? []), row]);
  const folders: Array<{ id: string; parentId: string | null; name: string; path: string; depth: number }> = [];
  function visit(parentId: string | null, prefix: string, depth: number) {
    for (const row of byParent.get(parentId) ?? []) {
      const path = prefix ? `${prefix} / ${row.name}` : row.name;
      folders.push({ ...row, path, depth });
      visit(row.id, path, depth + 1);
    }
  }
  visit(null, '', 0);
  return Response.json({ folders }, { headers: { 'Cache-Control': 'no-store' } });
}
