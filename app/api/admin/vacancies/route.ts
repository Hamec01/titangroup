import { NextRequest, NextResponse } from 'next/server';
import { isAdminRequestAuthenticated } from '../../../../lib/admin-auth';
import { rejectIfCsrfMissing } from '../../../../lib/csrf';
import { addVacancy, getVacancies, removeVacancy } from '../../../../lib/vacancies-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function unauthorizedResponse() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET(request: NextRequest) {
  if (!isAdminRequestAuthenticated(request)) {
    return unauthorizedResponse();
  }

  const vacancies = await getVacancies();
  return NextResponse.json(vacancies);
}

export async function POST(request: NextRequest) {
  if (!isAdminRequestAuthenticated(request)) {
    return unauthorizedResponse();
  }

  const csrf = rejectIfCsrfMissing(request);
  if (csrf) return csrf;

  let body: {
    role?: string;
    location?: string;
    duration?: string;
    description?: string;
    postedAt?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    if (
      typeof body.role !== 'string' ||
      typeof body.location !== 'string' ||
      typeof body.duration !== 'string' ||
      typeof body.description !== 'string' ||
      typeof body.postedAt !== 'string' ||
      !body.role.trim() ||
      !body.location.trim() ||
      !body.duration.trim() ||
      !body.description.trim() ||
      !body.postedAt.trim()
    ) {
      return NextResponse.json({ error: 'All vacancy fields are required' }, { status: 400 });
    }

    const vacancies = await addVacancy({
      role: body.role.trim(),
      location: body.location.trim(),
      duration: body.duration.trim(),
      description: body.description.trim(),
      postedAt: body.postedAt.trim()
    });

    return NextResponse.json(vacancies);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Vacancy add failed';
    return NextResponse.json({ error: `Vacancy add failed: ${message}` }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isAdminRequestAuthenticated(request)) {
    return unauthorizedResponse();
  }

  const csrf = rejectIfCsrfMissing(request);
  if (csrf) return csrf;

  let body: { id?: string };
  try {
    body = (await request.json()) as { id?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    if (typeof body.id !== 'string' || !body.id.trim()) {
      return NextResponse.json({ error: 'Vacancy id is required' }, { status: 400 });
    }

    const vacancies = await removeVacancy(body.id);
    return NextResponse.json(vacancies);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Vacancy delete failed';
    return NextResponse.json({ error: `Vacancy delete failed: ${message}` }, { status: 500 });
  }
}
