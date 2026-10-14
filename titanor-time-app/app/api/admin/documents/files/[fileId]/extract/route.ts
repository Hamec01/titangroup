import type { NextRequest } from 'next/server';
import { isUuid } from '@/lib/api-guard';
import { authorizeDocumentRequest, documentJsonError } from '@/lib/document-api';
import { extractDocumentArchive } from '@/lib/document-archive';
import { DocumentError } from '@/lib/documents';
import { DocumentStorageUnavailableError } from '@/lib/document-storage';
import { hasPermission } from '@/lib/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ fileId: string }> };

/** Extracts an uploaded zip/rar/7z/tar/gz archive into a new folder next to it. The archive itself stays. */
export async function POST(request: NextRequest, { params }: Params) {
  const auth = await authorizeDocumentRequest(request, 'document.upload', true);
  if (!auth.ok) return documentJsonError(auth.status, auth.code, auth.requestId);
  if (!(await hasPermission(auth.session.user.roles, 'document.create_folder'))) return documentJsonError(403, 'FORBIDDEN', auth.requestId);
  const { fileId } = await params;
  if (!isUuid(fileId)) return documentJsonError(404, 'FILE_NOT_FOUND', auth.requestId);
  try {
    const result = await extractDocumentArchive({ fileId, actorUserId: auth.session.user.id, requestId: auth.requestId });
    return Response.json({ folder: result.folder, fileCount: result.fileCount, folderCount: result.folderCount, totalBytes: result.totalBytes.toString(), skipped: result.skipped }, { status: 201 });
  } catch (error) {
    if (error instanceof DocumentError) return documentJsonError(error.status, error.code, auth.requestId);
    if (error instanceof DocumentStorageUnavailableError) return documentJsonError(503, 'DOCUMENT_STORAGE_UNAVAILABLE', auth.requestId);
    console.error('[documents] archive extraction failed', auth.requestId, error);
    return documentJsonError(500, 'ARCHIVE_EXTRACTION_FAILED', auth.requestId);
  }
}
