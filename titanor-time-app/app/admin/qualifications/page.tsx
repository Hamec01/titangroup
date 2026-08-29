import { permanentRedirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

// T13.5 — the qualifications matrix became the workforce matrix. Keep the old URL working:
// permanent-redirect to /admin/workforce, carrying the query string (the old `qualification`
// filter param name is unchanged).
type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AdminQualificationsRedirect({ searchParams }: RouteParams) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    qs.set(key, Array.isArray(value) ? (value[0] ?? '') : value);
  }
  const suffix = qs.toString();
  permanentRedirect(`/admin/workforce${suffix ? `?${suffix}` : ''}`);
}
