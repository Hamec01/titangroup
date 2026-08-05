import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { listActionablePeriods } from '@/lib/worker-context';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §3 — /worker is the post-login landing route
// (app/login/page.tsx's resolveHomeRoute). "Обычно один [actionable период], но
// может быть несколько" — redirect straight to it when there's exactly one,
// otherwise defer to /worker/periods (which also renders the empty state).
export default async function WorkerHomePage(): Promise<never> {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  if (!session.user.roles.includes('WORKER') || !session.user.employeeId) {
    redirect('/worker/periods');
  }

  const periods = await listActionablePeriods(session.user.employeeId);
  if (periods.length === 1) {
    redirect(`/worker/periods/${periods[0].id}`);
  }
  redirect('/worker/periods');
}
