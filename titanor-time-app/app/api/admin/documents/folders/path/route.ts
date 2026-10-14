import type { NextRequest } from 'next/server';
import { isUuid } from '@/lib/api-guard';
import { authorizeDocumentRequest, documentJsonError } from '@/lib/document-api';
import { DocumentError, MAX_FOLDER_DEPTH, ensureDocumentFolderPath } from '@/lib/documents';

/** Folder upload: resolves (creating when missing) `segments` below `parentId` and returns the leaf folder. */
export async function POST(request: NextRequest) {
  const auth = await authorizeDocumentRequest(request, 'document.create_folder', true);
  if (!auth.ok) return documentJsonError(auth.status, auth.code, auth.requestId);
  try {
    const body = await request.json() as { parentId?: unknown; segments?: unknown };
    if ((body.parentId != null && !isUuid(body.parentId)) || !Array.isArray(body.segments) || body.segments.length === 0 || body.segments.length > MAX_FOLDER_DEPTH || !body.segments.every((s) => typeof s === 'string')) throw new DocumentError('VALIDATION_ERROR');
    const result = await ensureDocumentFolderPath({ parentId: typeof body.parentId === 'string' ? body.parentId : null, segments: body.segments as string[], actorUserId: auth.session.user.id, requestId: auth.requestId });
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof DocumentError) return documentJsonError(error.status, error.code, auth.requestId);
    return documentJsonError(400, 'VALIDATION_ERROR', auth.requestId);
  }
}
