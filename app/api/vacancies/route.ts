import { NextResponse } from 'next/server';
import { getVacancies } from '../../../lib/vacancies-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const vacancies = await getVacancies();
  return NextResponse.json(vacancies);
}
