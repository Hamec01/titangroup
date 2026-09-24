import type { NextRequest } from 'next/server';
import { authorizeDocumentRequest, documentJsonError } from '@/lib/document-api';
import { DocumentStorageUnavailableError, getDocumentStream } from '@/lib/document-storage';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
type Params = { params: Promise<{ fileId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await authorizeDocumentRequest(request, 'document.download');
  if (!auth.ok) return documentJsonError(auth.status, auth.code, auth.requestId);
  const { fileId } = await params;
  const file = await prisma.documentFile.findFirst({ where: { id: fileId, status: 'ACTIVE' } });
  if (!file) return documentJsonError(404, 'FILE_NOT_FOUND', auth.requestId);
  try {
    const object = await getDocumentStream(file.storageKey);
    void prisma.documentFile.update({ where: { id: file.id }, data: { lastDownloadedAt: new Date() } }).catch(() => undefined);
    const fallback = file.displayName.replace(/[^A-Za-z0-9._-]/g, '_') || 'download';
    const headers = new Headers({ 'Content-Type': file.mimeType, 'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.displayName)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    if (object.contentLength !== null) headers.set('Content-Length', String(object.contentLength));
    return new Response(object.body, { headers });
  } catch (error) {
    if (error instanceof DocumentStorageUnavailableError) return documentJsonError(503, 'DOCUMENT_STORAGE_UNAVAILABLE', auth.requestId);
    return documentJsonError(500, 'DOCUMENT_DOWNLOAD_FAILED', auth.requestId);
  }
}
