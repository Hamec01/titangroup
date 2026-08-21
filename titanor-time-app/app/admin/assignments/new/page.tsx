import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { helsinkiToday } from '@/lib/workers';
import { NewAssignmentForm } from './NewAssignmentForm';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §2 (/admin/assignments/new). Same
// auth/role gate shape as the other /admin/*/new pages — deliberately no
// sibling loading.tsx (IMPLEMENTATION_STATUS.md §10).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewAssignmentPage({
  searchParams
}: {
  searchParams: Promise<{ employeeId?: string; primary?: string }>;
}) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const s = adminDailyStrings(await resolveAppLocale());

  const isAdmin = session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN');
  if (!isAdmin) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          {s.accessDenied}
        </p>
      </main>
    );
  }

  const query = await searchParams;
  const initialEmployeeId = query.employeeId && UUID_PATTERN.test(query.employeeId) ? query.employeeId : '';
  const initialValidFrom = helsinkiToday().toISOString().slice(0, 10);

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{s.assignments.newTitle}</h1>
        <p className="setup-subtitle">{s.assignments.newHelp}</p>
        <NewAssignmentForm
          initialEmployeeId={initialEmployeeId}
          initialValidFrom={initialValidFrom}
          initialIsPrimary={query.primary === 'true'}
          returnEmployeeId={initialEmployeeId || null}
          lockEmployee={Boolean(initialEmployeeId)}
        />
      </div>
    </main>
  );
}
