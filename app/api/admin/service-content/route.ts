import { NextRequest, NextResponse } from 'next/server';
import { isAdminRequestAuthenticated } from '../../../../lib/admin-auth';
import { getServiceContent, saveServiceContent, type ServiceContentByLocale } from '../../../../lib/service-content-store';
import { serviceSections, type ServiceSection } from '../../../../lib/service-sections';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function unauthorizedResponse() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET(request: NextRequest) {
  if (!isAdminRequestAuthenticated(request)) {
    return unauthorizedResponse();
  }

  const content = await getServiceContent();
  return NextResponse.json(content);
}

export async function PUT(request: NextRequest) {
  if (!isAdminRequestAuthenticated(request)) {
    return unauthorizedResponse();
  }

  try {
    const payload = (await request.json()) as Partial<ServiceContentByLocale>;
    const current = await getServiceContent();

    for (const locale of ['en', 'fi'] as const) {
      const localeBlock = payload?.[locale];
      if (!localeBlock || typeof localeBlock !== 'object') {
        continue;
      }

      for (const section of serviceSections) {
        const value = localeBlock[section];
        if (typeof value === 'string' && value.trim().length > 0) {
          current[locale][section] = value;
        }
      }
    }

    await saveServiceContent(current);
    return NextResponse.json(current);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Save failed';
    return NextResponse.json({ error: `Save failed: ${message}` }, { status: 500 });
  }
}
