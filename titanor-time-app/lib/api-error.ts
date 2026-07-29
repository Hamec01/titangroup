import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

// Shared error shape mandated by docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md
// §0 ("Формат ошибки (единый)") — every endpoint in the API, not just auth,
// must return this exact envelope with a fresh X-Request-Id per response.

export interface ApiErrorBody {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
}

export function jsonError(status: number, body: ApiErrorBody): NextResponse {
  const requestId = randomUUID();

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
