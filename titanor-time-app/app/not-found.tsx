import Link from 'next/link';
import { resolveAppLocale } from '@/lib/i18n/server';

// R07-A — app-wide 404. A Server Component, so it can resolve the real locale (session or the
// NEXT_LOCALE cookie). No request details are echoed back.
export default async function NotFound() {
  const ru = (await resolveAppLocale()) === 'RU';
  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{ru ? 'Страница не найдена' : 'Page not found'}</h1>
        <p className="login-error" role="alert">
          {ru
            ? 'Такой страницы нет или у вас нет к ней доступа.'
            : 'This page does not exist, or you do not have access to it.'}
        </p>
        <Link href="/" className="exc-apply-button">
          {ru ? 'На главную' : 'Go to start'}
        </Link>
      </div>
    </main>
  );
}
