import { resolveAppLocale } from '@/lib/i18n/server';
import { resolveServerSession } from '@/lib/server-session';
import { GuideView } from '@/components/guide/GuideView';

export const dynamic = 'force-dynamic';

// Public, unauthenticated by design — reachable from /login before signing in, and from the
// admin/foreman header once signed in. No auth *gate* here on purpose — but the "back" link needs
// to know whether a session already exists, so a signed-in visitor lands back on their own
// dashboard instead of the sign-in form (which, with an existing session cookie, reads to them as
// "logged out" even though nothing actually changed).
function resolveHomeHref(roles: string[] | undefined): string {
  if (!roles) return '/login';
  if (roles.includes('SUPER_ADMIN') || roles.includes('ADMIN')) return '/admin';
  if (roles.includes('FOREMAN')) return '/foreman';
  if (roles.includes('WORKER')) return '/worker';
  return '/login';
}

export default async function GuidePage() {
  const [locale, session] = await Promise.all([resolveAppLocale(), resolveServerSession()]);
  const homeHref = resolveHomeHref(session?.user.roles);
  return <GuideView initialLocale={locale} homeHref={homeHref} />;
}
