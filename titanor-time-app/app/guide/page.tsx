import { resolveAppLocale } from '@/lib/i18n/server';
import { GuideView } from '@/components/guide/GuideView';

export const dynamic = 'force-dynamic';

// Public, unauthenticated by design — reachable from /login before signing in, and from the
// admin/foreman header once signed in. No session/role check here on purpose.
export default async function GuidePage() {
  const locale = await resolveAppLocale();
  return <GuideView initialLocale={locale} />;
}
