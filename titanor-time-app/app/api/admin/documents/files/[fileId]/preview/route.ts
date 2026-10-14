import type { NextRequest } from 'next/server';
import { authorizeDocumentRequest, documentJsonError } from '@/lib/document-api';
import { resolveDocumentPreview } from '@/lib/document-preview';
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

  const preview = resolveDocumentPreview(file.mimeType, file.displayName);
  if (!preview) return documentJsonError(415, 'FILE_PREVIEW_UNSUPPORTED', auth.requestId);

  try {
    const object = await getDocumentStream(file.storageKey);
    const fallback = file.displayName.replace(/[^A-Za-z0-9._-]/g, '_') || 'preview';
    const headers = new Headers({
      'Content-Type': preview.contentType,
      'Content-Disposition': `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.displayName)}`,
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': auth.requestId
    });
    if (object.contentLength !== null) headers.set('Content-Length', String(object.contentLength));
    return new Response(object.body, { headers });
  } catch (error) {
    if (error instanceof DocumentStorageUnavailableError) return documentJsonError(503, 'DOCUMENT_STORAGE_UNAVAILABLE', auth.requestId);
    return documentJsonError(500, 'DOCUMENT_PREVIEW_FAILED', auth.requestId);
  }
}
