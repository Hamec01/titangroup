import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { helsinkiToday } from '@/lib/workers';
import { isValidMonth } from '@/lib/reporting/monthly-matrix';
import type { AppLocale } from '@/lib/i18n/locale';
import type { LedgerActor } from '@/lib/reporting/time-ledger';

// Табель v2 — the same ADMIN/SUPER_ADMIN gate /admin/timesheets uses, plus the shared month param.
export async function resolveTimesheetsV2Context(monthParam: string | string[] | undefined): Promise<{ ok: true; locale: AppLocale; actor: LedgerActor; todayIso: string; month: string } | { ok: false; locale: AppLocale; message: string }> {
  const session = await resolveServerSession();
  if (!session) redirect('/login');
  const locale = await resolveAppLocale();
  const isAdmin = session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN');
  if (!isAdmin) return { ok: false, locale, message: adminDailyStrings(locale).accessDenied };
  const todayIso = helsinkiToday().toISOString().slice(0, 10);
  const month = typeof monthParam === 'string' && isValidMonth(monthParam) ? monthParam : todayIso.slice(0, 7);
  return { ok: true, locale, actor: { userId: session.user.id, employeeId: session.user.employeeId }, todayIso, month };
}
