import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CreateVacancyInput, Vacancy } from './vacancy-types';
import { hasSupabaseConfig, supabaseRequest } from './supabase-rest';

const dataFilePath = join(process.cwd(), 'data', 'vacancies.json');

const defaultVacancies: Vacancy[] = [
  {
    id: 'vacancy-ship-fitter',
    role: 'Ship Fitter',
    location: 'Finland / EU shipyards',
    duration: 'Project-based, full-time',
    description:
      'Steel fitting and installation work in marine projects. Experience with shipyard safety standards is an advantage.',
    postedAt: '2026-06-02'
  }
];

function normalize(raw: unknown): Vacancy[] {
  if (!Array.isArray(raw)) {
    return [...defaultVacancies];
  }

  const parsed = raw
    .map((item): Vacancy | null => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const record = item as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : null;
      const role = typeof record.role === 'string' ? record.role : null;
      const location = typeof record.location === 'string' ? record.location : null;
      const duration = typeof record.duration === 'string' ? record.duration : null;
      const description = typeof record.description === 'string' ? record.description : null;
      const postedAt = typeof record.postedAt === 'string' ? record.postedAt : null;

      if (!id || !role || !location || !duration || !description || !postedAt) {
        return null;
      }

      return {
        id,
        role,
        location,
        duration,
        description,
        postedAt
      };
    })
    .filter((item): item is Vacancy => item !== null);

  return parsed.length > 0 ? parsed : [...defaultVacancies];
}

function sortVacancies(vacancies: Vacancy[]): Vacancy[] {
  return [...vacancies].sort((left, right) => right.postedAt.localeCompare(left.postedAt));
}

export async function getVacancies(): Promise<Vacancy[]> {
  if (hasSupabaseConfig()) {
    const response = await supabaseRequest('/job_vacancies?select=id,role,location,duration,description,posted_at&order=posted_at.desc');

    if (response.ok) {
      const rows = (await response.json()) as Array<{
        id: string;
        role: string;
        location: string;
        duration: string;
        description: string;
        posted_at: string;
      }>;

      if (rows.length === 0) {
        return [...defaultVacancies];
      }

      return rows.map((row) => ({
        id: row.id,
        role: row.role,
        location: row.location,
        duration: row.duration,
        description: row.description,
        postedAt: row.posted_at
      }));
    }
  }

  try {
    const raw = await readFile(dataFilePath, 'utf8');
    return sortVacancies(normalize(JSON.parse(raw)));
  } catch {
    return sortVacancies([...defaultVacancies]);
  }
}

async function saveVacancies(vacancies: Vacancy[]): Promise<void> {
  if (hasSupabaseConfig()) {
    const deleteResponse = await supabaseRequest('/job_vacancies?id=not.is.null', {
      method: 'DELETE'
    });

    if (!deleteResponse.ok) {
      throw new Error(`Supabase vacancy reset failed with status ${deleteResponse.status}`);
    }

    const rows = vacancies.map((vacancy) => ({
      id: vacancy.id,
      role: vacancy.role,
      location: vacancy.location,
      duration: vacancy.duration,
      description: vacancy.description,
      posted_at: vacancy.postedAt
    }));

    if (rows.length > 0) {
      const insertResponse = await supabaseRequest('/job_vacancies', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(rows)
      });

      if (!insertResponse.ok) {
        throw new Error(`Supabase vacancy save failed with status ${insertResponse.status}`);
      }
    }

    return;
  }

  await mkdir(dirname(dataFilePath), { recursive: true });
  await writeFile(dataFilePath, `${JSON.stringify(vacancies, null, 2)}\n`, 'utf8');
}

export async function addVacancy(input: CreateVacancyInput): Promise<Vacancy[]> {
  const vacancies = await getVacancies();
  const created: Vacancy = {
    id: randomUUID(),
    role: input.role,
    location: input.location,
    duration: input.duration,
    description: input.description,
    postedAt: input.postedAt
  };

  const next = sortVacancies([created, ...vacancies]);
  await saveVacancies(next);
  return next;
}

export async function removeVacancy(id: string): Promise<Vacancy[]> {
  const vacancies = await getVacancies();
  const next = vacancies.filter((vacancy) => vacancy.id !== id);
  await saveVacancies(next);
  return next;
}
