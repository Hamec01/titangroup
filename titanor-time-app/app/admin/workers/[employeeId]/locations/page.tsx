import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { getAdminWorkerGpsView } from '@/lib/attendance-gps-admin';
import { WorkerLocationMap } from './WorkerLocationMap';
import { WorkerCardNav } from '@/components/admin/WorkerCardNav';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

export default async function WorkerLocationsPage({ params }: { params: Promise<{ employeeId: string }> }) {
  const session = await resolveServerSession();
  if (!session) redirect('/login');
  const locale = await resolveAppLocale();
  if (!(await hasPermission(session.user.roles, 'attendance.gps.read.raw')) || !(await hasPermission(session.user.roles, 'worker.read.all'))) {
    return <main className="setup-page"><p className="login-error" role="alert">{localeText(locale, 'Access denied — raw GPS requires a separate administrator permission.', 'Доступ запрещён — для просмотра точных GPS-координат требуется отдельное право администратора.')}</p></main>;
  }
  const { employeeId } = await params;
  const now = new Date();
  const view = await getAdminWorkerGpsView({ employeeId, actorUserId: session.user.id, requestId: randomUUID(), from: new Date(now.getTime() - 7 * 86_400_000), toExclusive: new Date(now.getTime() + 86_400_000) });
  if (!view) return <main className="setup-page"><div className="setup-card"><p>{localeText(locale, 'Worker not found.', 'Работник не найден.')}</p></div></main>;
  return (
    <main className="setup-page"><div className="setup-card worker-card">
      <WorkerCardNav employeeId={employeeId} employeeName={view.employee.name} current="locations" locale={locale} />
      <h1>{localeText(locale, 'Check In/Out locations', 'Места Check In/Out')}</h1>
      <p className="setup-subtitle">{localeText(locale, `Last 7 days · raw coordinates retained for ${view.retentionDays} days · every view is audited.`, `Последние 7 дней · точные координаты хранятся ${view.retentionDays} дней · каждый просмотр записывается в аудит.`)}</p>
      {view.items.length || view.presenceSamples.length ? <WorkerLocationMap items={view.items} presenceSamples={view.presenceSamples} /> : <p>{localeText(locale, 'No retained GPS coordinates. Events marked “GPS not verified” may not contain a point to show.', 'Сохранённых GPS-координат нет. События с отметкой «GPS не подтверждён» могут не содержать точки для показа.')}</p>}
      <ul className="setup-list">
        {view.items.map((item) => <li key={item.clockEventId} className="setup-item setup-item-column"><strong>{item.operationType === 'CHECK_IN' ? 'Check In' : 'Check Out'} · {item.siteName}</strong><span>{new Date(item.effectiveAt).toLocaleString(locale === 'RU' ? 'ru-RU' : 'en-GB', { timeZone: 'Europe/Helsinki' })} · {item.verification} · {localeText(locale, 'accuracy', 'точность')} {item.accuracyMeters ?? localeText(locale, 'unknown', 'неизвестна')} {localeText(locale, 'm', 'м')}</span></li>)}
      </ul>
      {view.presenceSamples.length ? (
        <>
          <h2>{localeText(locale, 'During the shift (auto samples)', 'Во время смены (авто-точки)')}</h2>
          <p className="setup-subtitle">{localeText(locale, 'Captured automatically while a shift was open, whenever the app was foregrounded after 3h+.', 'Снимаются автоматически при открытой смене, когда приложение открывают спустя 3+ часа.')}</p>
          <ul className="setup-list">
            {view.presenceSamples.map((s) => (
              <li key={s.id} className="setup-item setup-item-column">
                <strong>{s.siteName ?? '—'} · {new Date(s.capturedAt).toLocaleString(locale === 'RU' ? 'ru-RU' : 'en-GB', { timeZone: 'Europe/Helsinki' })}</strong>
                <span>
                  {s.insideGeofence === true ? localeText(locale, 'in zone', 'в зоне') : s.insideGeofence === false ? localeText(locale, 'outside zone', 'вне зоны') : localeText(locale, 'zone unknown', 'зона не определена')}
                  {' · '}
                  {localeText(locale, 'accuracy', 'точность')} {s.accuracyMeters} {localeText(locale, 'm', 'м')}
                  {s.capturedOffline ? ` · ${localeText(locale, 'offline', 'офлайн')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div></main>
  );
}
