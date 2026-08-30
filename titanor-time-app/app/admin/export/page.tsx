import { AccessDeniedNotice } from '@/components/admin/AccessDeniedNotice';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { listExportBatches, parsePageQuery, type ExportBatchListResult } from '@/lib/csv-export';
import { listPeriodOptions } from '@/lib/attendance-overview-lookups';
import { getPeriodDetail } from '@/lib/periods';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { ExportHistoryView, type ExportHistoryOutcome, type RawExportFilters, type CreatePanelInfo } from '@/components/exports/ExportHistoryView';
import { resolveAppLocale } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4C" §BR/§BS — thin Server Component wrapper.
// Calls listExportBatches()/listPeriodOptions()/getPeriodDetail() directly (lib/csv-export.ts,
// lib/attendance-overview-lookups.ts, lib/periods.ts — no HTTP self-fetch), the same functions the
// real API routes call.
const REQUIRED_READ_PERMISSION = 'export.read';
const REQUIRED_CREATE_PERMISSIONS = ['period.export', 'export.create'];

type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export default async function AdminExportHistoryPage({ searchParams }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();

  if (!(await hasPermission(session.user.roles, REQUIRED_READ_PERMISSION))) {
    return (
      <AccessDeniedNotice area="exports" locale={locale} permission={REQUIRED_READ_PERMISSION} />
    );
  }

  let canCreate = true;
  for (const permissionCode of REQUIRED_CREATE_PERMISSIONS) {
    if (!(await hasPermission(session.user.roles, permissionCode))) {
      canCreate = false;
      break;
    }
  }

  const sp = await searchParams;
  const rawFilters: RawExportFilters = { periodId: one(sp.periodId), page: one(sp.page), pageSize: one(sp.pageSize) };

  const fieldErrors: Record<string, string[]> = {};
  if (rawFilters.periodId !== null && !UUID_PATTERN.test(rawFilters.periodId)) {
    fieldErrors.periodId = ['must be a UUID'];
  }
  const parsedQuery = parsePageQuery({ page: rawFilters.page, pageSize: rawFilters.pageSize });
  if (!parsedQuery.ok) {
    Object.assign(fieldErrors, parsedQuery.fieldErrors);
  }

  let outcome: ExportHistoryOutcome;
  let list: ExportBatchListResult | null = null;
  if (Object.keys(fieldErrors).length > 0) {
    outcome = { kind: 'invalid', fieldErrors };
  } else {
    const parsedOk = parsedQuery as { ok: true; page: number; pageSize: number };
    list = await listExportBatches({ periodId: rawFilters.periodId ?? undefined }, { page: parsedOk.page, pageSize: parsedOk.pageSize });
    outcome = { kind: 'ok', list };
  }

  const periodOptions = await listPeriodOptions();

  let createPanel: CreatePanelInfo;
  if (!canCreate) {
    createPanel = { kind: 'no-permission' };
  } else if (!rawFilters.periodId || !UUID_PATTERN.test(rawFilters.periodId)) {
    createPanel = { kind: 'no-period-selected' };
  } else {
    const period = await getPeriodDetail(rawFilters.periodId);
    if (!period) {
      createPanel = { kind: 'period-not-found' };
    } else if (period.status === 'OPEN') {
      createPanel = { kind: 'open' };
    } else if (period.status === 'LOCKED') {
      createPanel = { kind: 'locked', periodId: period.id };
    } else {
      createPanel = { kind: 'exported', periodId: period.id };
    }
  }

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <ExportHistoryView rawFilters={rawFilters} periodOptions={periodOptions} outcome={outcome} createPanel={createPanel} locale={locale} />
      </div>
    </main>
  );
}
