import type { NextRequest, NextResponse } from 'next/server';
import { POST as endPost } from '../end/route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §6 — POST /api/admin/assignments/:id/remove
// is the D7 name for "Снять с объекта". Deploy A keeps it byte-identical to the legacy /end
// endpoint (same body { validTo, reason? }, same lifecycle-service call, same responses). Deploy B's
// worker-card redesign adds the structured reason presets here and repoints the UI from /end.
// (Next.js won't let route files re-export `dynamic`/`revalidate`, so the handler is wrapped
// rather than re-exported.)
export function POST(request: NextRequest, ctx: { params: Promise<{ assignmentId: string }> }): Promise<NextResponse> {
  return endPost(request, ctx);
}
