import { AccessDeniedNotice } from '@/components/admin/AccessDeniedNotice';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { getExportBatchDetail, isValidExportBatchId, parsePageQuery } from '@/lib/csv-export';
import { getPeriodDetail } from '@/lib/periods';
import { ExportBatchDetailView, type ExportBatchDetailOutcome } from '@/components/exports/ExportBatchDetailView';
import { resolveAppLocale } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4C" §BR — thin Server Component wrapper.
// Calls getExportBatchDetail() directly (lib/csv-export.ts), the same function the real
// GET /api/admin/export-batches/:batchId route calls. Malformed and missing batchId share the same
// safe not-found presentation — no oracle, no distinguishing text.
const REQUIRED_PERMISSION = 'export.read';

type RouteParams = { params: Promise<{ batchId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export default async function AdminExportBatchDetailPage({ params, searchParams }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();

  if (!(await hasPermission(session.user.roles, REQUIRED_PERMISSION))) {
    return (
      <AccessDeniedNotice area="exports" locale={locale} permission={REQUIRED_PERMISSION} />
    );
  }

  const { batchId } = await params;
  const sp = await searchParams;
  const parsedQuery = parsePageQuery({ page: one(sp.page), pageSize: one(sp.pageSize) });
  const page = parsedQuery.ok ? parsedQuery.page : 1;
  const pageSize = parsedQuery.ok ? parsedQuery.pageSize : 20;

  let outcome: ExportBatchDetailOutcome;
  if (!isValidExportBatchId(batchId)) {
    outcome = { kind: 'not-found' };
  } else {
    const detail = await getExportBatchDetail(batchId, { page, pageSize });
    if (!detail) {
      outcome = { kind: 'not-found' };
    } else {
      const period = await getPeriodDetail(detail.batch.periodId);
      const periodLabel = period ? `${period.startDate} – ${period.endDate} · ${period.status}` : null;
      outcome = { kind: 'ok', detail, periodLabel };
    }
  }

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <ExportBatchDetailView batchId={batchId} outcome={outcome} page={page} pageSize={pageSize} locale={locale} />
      </div>
    </main>
  );
}
