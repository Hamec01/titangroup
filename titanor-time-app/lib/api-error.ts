import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

// Shared error shape mandated by docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md
// §0 ("Формат ошибки (единый)") — every endpoint in the API, not just auth,
// must return this exact envelope with a fresh X-Request-Id per response.

export interface ApiErrorBody {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
  // period.lock's 409 NOT_ALL_FINAL_APPROVED (01_SCREEN_MAP.md §3: "список блокеров") — which
  // participants are still holding the lock back, so the UI can render the list without a
  // second round-trip.
  blockers?: { employeeId: string; employeeName: string; timesheetId: string | null; status: string | null }[];
  // attendance exception resolve's 409 ACTION_NOT_APPLICABLE (T7A_1_ATTENDANCE_CLOCK_DESIGN.md
  // §11) — the full domain-level allowed-actions list for this exceptionType, which may include
  // actions this endpoint doesn't implement yet (informational only, never a promise that POSTing
  // one of them will succeed).
  allowedActions?: string[];
}

// requestId is optional so existing callers keep working unchanged, but every
// route should generate one request id per incoming request (randomUUID(),
// once, at the top of the handler) and pass it here — and to every success
// response of that same request via successHeaders() below — so a single
// request's success/error responses agree, and any future
// AuditEvent.requestId (03_DATA_MODEL_ERD.md §4.8) has a real value to use.
export function jsonError(status: number, body: ApiErrorBody, requestId: string = randomUUID()): NextResponse {
  return NextResponse.json(
    { error: { ...body, requestId } },
    {
      status,
      headers: {
        'X-Request-Id': requestId,
        'Cache-Control': 'no-store'
      }
    }
  );
}

/** Headers for a success response, carrying the same request id as any error jsonError() might have returned for this request. */
export function successHeaders(requestId: string): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Request-Id': requestId
  };
}
