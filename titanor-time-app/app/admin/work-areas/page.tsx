import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';
import { WorkAreaList } from './WorkAreaList';

export const dynamic = 'force-dynamic';

export default async function AdminWorkAreasPage() {
  const session = await resolveServerSession();
  if (!session) redirect('/login');
  const locale = await resolveAppLocale();
  if (!(await hasPermission(session.user.roles, 'workarea.read.all'))) {
    return <main className="setup-page"><p className="login-error" role="alert">{localeText(locale, 'Access denied — this page requires workarea.read.all.', 'Доступ запрещён — для этой страницы нужно право workarea.read.all.')}</p></main>;
  }

  const [workAreas, canManage] = await Promise.all([
    prisma.workArea.findMany({ orderBy: [{ site: { name: 'asc' } }, { name: 'asc' }], select: { id: true, name: true, active: true, version: true, site: { select: { id: true, name: true } } } }),
    hasPermission(session.user.roles, 'workarea.update')
  ]);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{localeText(locale, 'Customers', 'Заказчики')}</h1>
        <p className="setup-subtitle">{workAreas.length} {localeText(locale, workAreas.length === 1 ? 'customer' : 'customers', workAreas.length === 1 ? 'заказчик' : 'заказчиков')} · <Link href="/admin/sites">{localeText(locale, 'Manage sites', 'Управлять объектами')}</Link></p>
        <WorkAreaList workAreas={workAreas} canManage={canManage} />
      </div>
    </main>
  );
}