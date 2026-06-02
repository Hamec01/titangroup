import { NextResponse } from 'next/server';
import { getServiceImageUrls } from '../../../lib/service-images-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const images = await getServiceImageUrls();
  return NextResponse.json(images);
}
