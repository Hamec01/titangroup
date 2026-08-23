import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { NewCityForm } from './NewCityForm';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

export default async function NewCityPage() {
  const session = await resolveServerSession();
  if (!session) redirect('/login');
  const locale = await resolveAppLocale();
  const s = adminDailyStrings(locale);

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

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{localeText(locale, 'New city', 'Новый город')}</h1>
        <p className="setup-subtitle">{localeText(locale, 'Create a city, then select it when creating or editing a site.', 'Создайте город, затем выберите его при создании или редактировании объекта.')}</p>
        <NewCityForm />
      </div>
    </main>
  );
}
