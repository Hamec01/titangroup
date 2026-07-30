import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { successHeaders } from '@/lib/api-error';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const requestId = randomUUID();

  return NextResponse.json(
    {
      status: 'ok',
      service: 'titanor-time'
    },
    {
      headers: successHeaders(requestId)
    }
  );
}
