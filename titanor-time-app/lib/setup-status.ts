import { prisma } from '@/lib/prisma';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §10 (GET /api/admin/setup-status) and
// docs/titanor-time/01_SCREEN_MAP.md (/admin/setup) — checklist of the first
// vertical scenario. Plain existence checks (count > 0), not aggregate
// numbers — the screen map is explicit that this is a checklist, "не
// декоративный dashboard", with no fabricated figures.
export interface SetupStatus {
  hasCity: boolean;
  hasSite: boolean;
  hasWorkArea: boolean;
  hasTemplate: boolean;
  hasWorker: boolean;
  hasAssignment: boolean;
  hasOpenPeriod: boolean;
}

/** hasCity is informational only — per contract it never blocks checklist completion (City is optional). */
export async function getSetupStatus(): Promise<SetupStatus> {
  const [cityCount, siteCount, workAreaCount, templateCount, workerCount, assignmentCount, openPeriodCount] =
    await Promise.all([
      prisma.city.count(),
      prisma.workSite.count(),
      prisma.workArea.count(),
      prisma.workScheduleTemplate.count(),
      prisma.employee.count(),
      prisma.siteAssignment.count(),
      prisma.payrollPeriod.count({ where: { status: 'OPEN' } })
    ]);

  return {
    hasCity: cityCount > 0,
    hasSite: siteCount > 0,
    hasWorkArea: workAreaCount > 0,
    hasTemplate: templateCount > 0,
    hasWorker: workerCount > 0,
    hasAssignment: assignmentCount > 0,
    hasOpenPeriod: openPeriodCount > 0
  };
}
