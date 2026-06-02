import { NextResponse } from 'next/server';
import { getServiceContent } from '../../../lib/service-content-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const content = await getServiceContent();
  return NextResponse.json(content);
}
