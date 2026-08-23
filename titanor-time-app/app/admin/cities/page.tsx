import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { prisma } from '@/lib/prisma';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';
import { CityList } from './CityList';

export const dynamic = 'force-dynamic';

export default async function AdminCitiesPage() {
  const session = await resolveServerSession();
  if (!session) redirect('/login');

  const locale = await resolveAppLocale();
  if (!(await hasPermission(session.user.roles, 'city.read.all'))) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">{localeText(locale, 'Access denied — this page requires city.read.all.', 'Доступ запрещён — для этой страницы нужно право city.read.all.')}</p>
      </main>
    );
  }

  const [cities, canDelete] = await Promise.all([
    prisma.city.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, _count: { select: { sites: true } } }
    }),
    hasPermission(session.user.roles, 'city.delete')
  ]);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{localeText(locale, 'Cities', 'Города')}</h1>
        <p className="setup-subtitle">
          {cities.length} {localeText(locale, cities.length === 1 ? 'city' : 'cities', cities.length === 1 ? 'город' : 'городов')} · <Link href="/admin/cities/new">{localeText(locale, 'Add city', 'Добавить город')}</Link>
        </p>
        <CityList cities={cities.map((city) => ({ id: city.id, name: city.name, siteCount: city._count.sites }))} canDelete={canDelete} />
      </div>
    </main>
  );
}