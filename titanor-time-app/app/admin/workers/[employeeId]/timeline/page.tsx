import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { helsinkiToday } from '@/lib/workers';
import { helsinkiDateAndTimeToUtcIso } from '@/lib/helsinki-datetime';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';
import { WorkerCardNav } from '@/components/admin/WorkerCardNav';

export const dynamic = 'force-dynamic';

const DAYS_PER_PAGE = 14;

type RouteParams = {
  params: Promise<{ employeeId: string }>;
  searchParams: Promise<{ page?: string }>;
};

type ShiftSegment = {
  id: string;
  siteName: string;
  workAreaName: string | null;
  startAt: Date;
  endAt: Date | null;
};

type DayRow = {
  isoDate: string;
  weekday: string;
  totalMinutes: number;
  segments: Array<{
    id: string;
    siteName: string;
    workAreaName: string | null;
    startLabel: string;
    endLabel: string;
    minutes: number;
    isOpen: boolean;
  }>;
};

function parsePage(value: string | undefined): number {
  if (!value) return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return 1;
  return n;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toDayStartUtc(isoDate: string): Date {
  return new Date(helsinkiDateAndTimeToUtcIso(isoDate, '00:00'));
}

function dateRangeInclusive(startDate: Date, endDate: Date): Date[] {
  const result: Date[] = [];
  let cursor = new Date(startDate);
  while (cursor <= endDate) {
    result.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return result;
}

function formatTime(instant: Date, locale: 'RU' | 'EN'): string {
  return new Intl.DateTimeFormat(locale === 'RU' ? 'ru-RU' : 'en-GB', {
    timeZone: 'Europe/Helsinki',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(instant);
}

function formatWeekday(instant: Date, locale: 'RU' | 'EN'): string {
  return new Intl.DateTimeFormat(locale === 'RU' ? 'ru-RU' : 'en-GB', {
    timeZone: 'Europe/Helsinki',
    weekday: 'short'
  }).format(instant);
}

function formatDuration(totalMinutes: number, locale: 'RU' | 'EN'): string {
  if (totalMinutes <= 0) return locale === 'RU' ? '0 мин' : '0 min';
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return locale === 'RU' ? `${m} мин` : `${m} min`;
  return locale === 'RU' ? `${h} ч ${m} мин` : `${h} h ${m} min`;
}

function overlapMinutes(startAt: Date, endAt: Date, dayStart: Date, dayEnd: Date): number {
  const overlapStart = Math.max(startAt.getTime(), dayStart.getTime());
  const overlapEnd = Math.min(endAt.getTime(), dayEnd.getTime());
  if (overlapEnd <= overlapStart) return 0;
  return Math.round((overlapEnd - overlapStart) / 60000);
}

export default async function WorkerTimelinePage({ params, searchParams }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }

  const locale = await resolveAppLocale();
  if (!(await hasPermission(session.user.roles, 'worker.read.all'))) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          {localeText(locale, 'Access denied — this page requires worker.read.all.', 'Доступ запрещён — для этой страницы нужно право worker.read.all.')}
        </p>
      </main>
    );
  }

  const { employeeId } = await params;
  const { page: pageParam } = await searchParams;
  const page = parsePage(pageParam);

  const worker = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, firstName: true, lastName: true, employeeNumber: true }
  });

  if (!worker) {
    return (
      <main className="setup-page">
        <div className="setup-card worker-card">
          <p className="login-error" role="alert">
            {localeText(locale, 'Worker not found.', 'Работник не найден.')}
          </p>
        </div>
      </main>
    );
  }

  const today = helsinkiToday();
  const windowEndDate = addDays(today, -((page - 1) * DAYS_PER_PAGE));
  const windowStartDate = addDays(windowEndDate, -(DAYS_PER_PAGE - 1));

  const fromUtc = toDayStartUtc(formatIsoDate(windowStartDate));
  const toUtcExclusive = toDayStartUtc(formatIsoDate(addDays(windowEndDate, 1)));
  const now = new Date();

  const [closedShifts, openShift] = await Promise.all([
    prisma.clockShift.findMany({
      where: {
        employeeId,
        recordedStartAt: { lt: toUtcExclusive },
        recordedEndAt: { gt: fromUtc }
      },
      orderBy: [{ recordedStartAt: 'desc' }],
      select: {
        id: true,
        recordedStartAt: true,
        recordedEndAt: true,
        site: { select: { name: true } },
        workArea: { select: { name: true } }
      }
    }),
    prisma.employeeOpenShift.findUnique({
      where: { employeeId },
      select: {
        id: true,
        openedAt: true,
        site: { select: { name: true } },
        workArea: { select: { name: true } }
      }
    })
  ]);

  const segments: ShiftSegment[] = closedShifts.map((shift) => ({
    id: shift.id,
    siteName: shift.site.name,
    workAreaName: shift.workArea?.name ?? null,
    startAt: shift.recordedStartAt,
    endAt: shift.recordedEndAt
  }));

  if (openShift && openShift.openedAt < toUtcExclusive && now > fromUtc) {
    segments.push({
      id: openShift.id,
      siteName: openShift.site.name,
      workAreaName: openShift.workArea?.name ?? null,
      startAt: openShift.openedAt,
      endAt: null
    });
  }

  const days = dateRangeInclusive(windowStartDate, windowEndDate);
  const rows: DayRow[] = days
    .map((date) => {
      const isoDate = formatIsoDate(date);
      const dayStart = toDayStartUtc(isoDate);
      const dayEnd = toDayStartUtc(formatIsoDate(addDays(date, 1)));
      const daySegments = segments
        .map((segment) => {
          const effectiveEnd = segment.endAt ?? now;
          const minutes = overlapMinutes(segment.startAt, effectiveEnd, dayStart, dayEnd);
          if (minutes <= 0) return null;

          const clippedStart = new Date(Math.max(segment.startAt.getTime(), dayStart.getTime()));
          const clippedEnd = new Date(Math.min(effectiveEnd.getTime(), dayEnd.getTime()));
          return {
            id: `${segment.id}-${isoDate}`,
            siteName: segment.siteName,
            workAreaName: segment.workAreaName,
            startLabel: formatTime(clippedStart, locale),
            endLabel: segment.endAt === null && clippedEnd.getTime() >= now.getTime() ? '—' : formatTime(clippedEnd, locale),
            minutes,
            isOpen: segment.endAt === null
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => !!entry)
        .sort((a, b) => a.startLabel.localeCompare(b.startLabel));

      const totalMinutes = daySegments.reduce((sum, entry) => sum + entry.minutes, 0);

      return {
        isoDate,
        weekday: formatWeekday(dayStart, locale),
        totalMinutes,
        segments: daySegments
      };
    })
    .reverse();

  const rangeLabel = `${formatIsoDate(windowStartDate)} - ${formatIsoDate(windowEndDate)}`;
  const previousPageHref = `/admin/workers/${employeeId}/timeline?page=${page + 1}`;
  const nextPageHref = `/admin/workers/${employeeId}/timeline?page=${page - 1}`;

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <WorkerCardNav employeeId={employeeId} employeeName={`${worker.firstName} ${worker.lastName}`} current="timeline" locale={locale} />
        <h1>{localeText(locale, 'Check In/Out day history', 'История приходов и уходов по дням')}</h1>
        <p className="setup-subtitle">
          #{worker.employeeNumber}
        </p>
        <p className="setup-subtitle">
          {localeText(locale, 'Window', 'Период')}: {rangeLabel} · {localeText(locale, 'page', 'страница')} {page}
        </p>

        <div className="ov-filter-actions">
          <Link href={previousPageHref} className="exc-reset-link">{localeText(locale, 'Older period', 'Более старый период')}</Link>
          {page > 1 ? <Link href={nextPageHref} className="exc-reset-link">{localeText(locale, 'Newer period', 'Более новый период')}</Link> : null}
        </div>

        <div className="worker-table-scroll">
          <table className="worker-table">
            <thead>
              <tr>
                <th>{localeText(locale, 'Date', 'Дата')}</th>
                <th>{localeText(locale, 'Check In', 'Приход')}</th>
                <th>{localeText(locale, 'Check Out', 'Уход')}</th>
                <th>{localeText(locale, 'Today total', 'Итого за день')}</th>
                <th>{localeText(locale, 'Details', 'Детали')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.isoDate}>
                  <td>
                    <strong>{row.isoDate}</strong>
                    <div className="setup-subtitle">{row.weekday}</div>
                  </td>
                  <td>{row.segments[0]?.startLabel ?? '—'}</td>
                  <td>{row.segments[row.segments.length - 1]?.endLabel ?? '—'}</td>
                  <td>{formatDuration(row.totalMinutes, locale)}</td>
                  <td>
                    {row.segments.length === 0 ? (
                      <span className="setup-subtitle">{localeText(locale, 'No shifts', 'Смен нет')}</span>
                    ) : (
                      <ul className="setup-list">
                        {row.segments.map((segment) => (
                          <li key={segment.id} className="setup-item setup-item-column">
                            <strong>{segment.siteName}{segment.workAreaName ? ` · ${segment.workAreaName}` : ''}</strong>
                            <span>
                              {segment.startLabel} - {segment.endLabel} · {formatDuration(segment.minutes, locale)}
                              {segment.isOpen ? ` · ${localeText(locale, 'open shift', 'открытая смена')}` : ''}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
