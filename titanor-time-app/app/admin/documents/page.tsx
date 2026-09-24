import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { resolveAppLocale } from '@/lib/i18n/server';
import { hasPermission } from '@/lib/permissions';
import { DocumentsManager } from './DocumentsManager';

export const dynamic = 'force-dynamic';

export default async function DocumentsPage() {
  const [session, locale] = await Promise.all([resolveServerSession(), resolveAppLocale()]);
  if (!session) redirect('/login');
  if (!(await hasPermission(session.user.roles, 'document.read'))) {
    return <main className="setup-page"><p className="login-error">{locale === 'RU' ? 'Нет доступа к документам.' : 'No access to documents.'}</p></main>;
  }
  return <DocumentsManager locale={locale} />;
}
