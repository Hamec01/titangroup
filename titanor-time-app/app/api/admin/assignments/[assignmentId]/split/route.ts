import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6 — DEPRECATED 2026-09-02 (R15-D7 Deploy D).
//
// This endpoint did a raw `siteAssignment.create` outside the lifecycle service: it neither took
// the per-employee advisory lock nor demoted a prior live primary, so splitting a PRIMARY
// assignment left two rows matching the ux_site_assignment_one_live_primary partial unique index
// and the create failed with 23505 → 500. It was also untested/incomplete and had no UI caller.
//
// POST /api/admin/assignments/:id/change is the supported close-old + open-materialised-replacement
// operation (through lib/assignment-lifecycle-service.ts — advisory lock, AssignmentTransition,
// AuditEvent, one transaction, primary demotion handled). This route now returns 410 Gone.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  return jsonError(
    410,
    {
      code: 'ENDPOINT_GONE',
      message:
        'POST /api/admin/assignments/:id/split is removed. Use POST /api/admin/assignments/:id/change to move a worker to a different site/customer/template from a given date.'
    },
    requestId
  );
}
