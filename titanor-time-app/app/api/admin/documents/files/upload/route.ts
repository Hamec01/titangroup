import type { NextRequest } from 'next/server';
import { authorizeDocumentRequest, documentJsonError } from '@/lib/document-api';
import { DocumentError, finishDocumentUpload, releaseDocumentReservation, reserveDocumentBytes } from '@/lib/documents';
import { DocumentStorageUnavailableError, putDocumentStream } from '@/lib/document-storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = await authorizeDocumentRequest(request, 'document.upload', true);
  if (!auth.ok) return documentJsonError(auth.status, auth.code, auth.requestId);
  const encodedName = request.headers.get('x-file-name');
  const sizeRaw = request.headers.get('x-file-size');
  const folderId = request.headers.get('x-folder-id') || null;
  if (!encodedName || !sizeRaw || !/^\d+$/.test(sizeRaw) || (!request.body && sizeRaw !== '0')) return documentJsonError(400, 'VALIDATION_ERROR', auth.requestId);
  let name: string;
  try { name = decodeURIComponent(encodedName); } catch { return documentJsonError(400, 'VALIDATION_ERROR', auth.requestId); }
  let reservation: { id: string; storageSpaceId: string } | null = null;
  try {
    const sizeBytes = BigInt(sizeRaw);
    reservation = sizeBytes > BigInt(0) ? await reserveDocumentBytes(auth.session.user.id, sizeBytes) : null;
    const stored = await putDocumentStream(request.body, sizeBytes, request.headers.get('content-type') || 'application/octet-stream');
    const file = await finishDocumentUpload({ reservationId: reservation?.id ?? null, folderId, originalName: name, mimeType: request.headers.get('content-type') || 'application/octet-stream', stored, actorUserId: auth.session.user.id, requestId: auth.requestId });
    return Response.json({ file: { id: file.id, displayName: file.displayName, sizeBytes: file.sizeBytes.toString(), category: file.category, updatedAt: file.updatedAt } }, { status: 201 });
  } catch (error) {
    if (reservation) await releaseDocumentReservation(reservation.id).catch(() => undefined);
    if (error instanceof DocumentError) return documentJsonError(error.status, error.code, auth.requestId);
    if (error instanceof DocumentStorageUnavailableError) return documentJsonError(503, 'DOCUMENT_STORAGE_UNAVAILABLE', auth.requestId);
    if (error instanceof Error && error.message === 'DOCUMENT_UPLOAD_SIZE_MISMATCH') return documentJsonError(400, 'DOCUMENT_UPLOAD_SIZE_MISMATCH', auth.requestId);
    console.error('[documents] upload failed', auth.requestId, error);
    return documentJsonError(500, 'DOCUMENT_UPLOAD_FAILED', auth.requestId);
  }
}
