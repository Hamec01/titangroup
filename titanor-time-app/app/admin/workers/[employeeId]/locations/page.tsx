import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { getAdminWorkerGpsView } from '@/lib/attendance-gps-admin';
import { WorkerLocationMap } from './WorkerLocationMap';

export const dynamic = 'force-dynamic';

export default async function WorkerLocationsPage({ params }: { params: Promise<{ employeeId: string }> }) {
  const session = await resolveServerSession();
  if (!session) redirect('/login');
  if (!(await hasPermission(session.user.roles, 'attendance.gps.read.raw')) || !(await hasPermission(session.user.roles, 'worker.read.all'))) {
    return <main className="setup-page"><p className="login-error" role="alert">Access denied — raw GPS requires a separate administrator permission.</p></main>;
  }
  const { employeeId } = await params;
  const now = new Date();
  const view = await getAdminWorkerGpsView({ employeeId, actorUserId: session.user.id, requestId: randomUUID(), from: new Date(now.getTime() - 7 * 86_400_000), toExclusive: new Date(now.getTime() + 86_400_000) });
  if (!view) return <main className="setup-page"><div className="setup-card"><p>Worker not found.</p></div></main>;
  return (
    <main className="setup-page"><div className="setup-card worker-card">
      <p><Link href={`/admin/workers/${employeeId}`}>← Back to worker</Link></p>
      <h1>Check In/Out locations — {view.employee.name}</h1>
      <p className="setup-subtitle">Last 7 days · raw coordinates retained for {view.retentionDays} days · every view is audited.</p>
      {view.items.length ? <WorkerLocationMap items={view.items} /> : <p>No retained GPS coordinates. Events marked “GPS not verified” may not contain a point to show.</p>}
      <ul className="setup-list">
        {view.items.map((item) => <li key={item.clockEventId} className="setup-item setup-item-column"><strong>{item.operationType === 'CHECK_IN' ? 'Check In' : 'Check Out'} · {item.siteName}</strong><span>{new Date(item.effectiveAt).toLocaleString('en-GB', { timeZone: 'Europe/Helsinki' })} · {item.verification} · accuracy {item.accuracyMeters ?? 'unknown'} m</span></li>)}
      </ul>
    </div></main>
  );
}
