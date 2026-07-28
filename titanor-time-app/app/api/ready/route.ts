import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;

    return NextResponse.json(
      {
        status: 'ready',
        service: 'titanor-time',
        database: 'connected'
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store'
        }
      }
    );
  } catch {
    // Intentionally not forwarding the caught error (message, stack, or any
    // Prisma/PostgreSQL detail) to the client or to this log line — it can
    // include host/port. Only a fixed, credential-free string is recorded.
    console.error('titanor-time readiness check: database unreachable');

    return NextResponse.json(
      {
        status: 'not_ready',
        service: 'titanor-time',
        database: 'unavailable'
      },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store'
        }
      }
    );
  }
}
