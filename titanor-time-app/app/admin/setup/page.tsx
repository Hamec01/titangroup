import { AccessDeniedNotice } from '@/components/admin/AccessDeniedNotice';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getSetupStatus, type SetupStatus } from '@/lib/setup-status';
import { resolveAppLocale } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §2 (/admin/setup): checklist of the
// first vertical scenario, "не декоративный dashboard" — every item below is
// a plain done/not-done flag from getSetupStatus(), no counts, no invented
// numbers. Items link only to real routes: work areas are managed within a
// site; templates have their own list at /admin/templates.
interface ChecklistItem {
  key: keyof SetupStatus;
  label: string;
  description: string;
  optional?: boolean;
  createHref: string | null;
  doneHref: string | null;
  createActionLabel?: string;
  doneActionLabel?: string;
}

const CHECKLIST: ChecklistItem[] = [
  {
    key: 'hasCity',
    label: 'City',
    description: 'Optional reference for grouping sites. It does not block setup.',
    optional: true,
    createHref: '/admin/cities',
    doneHref: '/admin/cities',
    doneActionLabel: 'Add another'
  },
  {
    key: 'hasSite',
    label: 'Site',
    description: 'The actual workplace a worker can be assigned to and check in at.',
    createHref: '/admin/sites/new',
    doneHref: '/admin/sites'
  },
  {
    key: 'hasWorkArea',
    label: 'Work area',
    description: 'Optional subdivision inside a site. Skip it when the whole site is one work area.',
    optional: true,
    createHref: '/admin/work-areas',
    doneHref: '/admin/work-areas',
    createActionLabel: 'Manage work areas'
  },
  {
    key: 'hasTemplate',
    label: 'Work schedule template',
    description: 'Defines the worker\'s usual working week.',
    createHref: '/admin/templates/new',
    doneHref: '/admin/templates'
  },
  {
    key: 'hasWorker',
    label: 'Worker',
    description: 'Employee account that will use Check In/Out and enter hours.',
    createHref: '/admin/workers/new',
    doneHref: '/admin/workers'
  },
  {
    key: 'hasAssignment',
    label: 'Assignment',
    description: 'Connects a worker to a site and schedule for a date range.',
    createHref: '/admin/assignments/new',
    doneHref: '/admin/assignments'
  },
  {
    key: 'hasSubmissionScheduleConfigured',
    label: 'Timesheet submission cycle',
    description: 'Choose Weekly or Every two weeks on each active worker. Payroll periods are then created automatically.',
    createHref: '/admin/submission-cycles',
    doneHref: '/admin/submission-cycles',
    createActionLabel: 'Configure cycles'
  }
];

export default async function AdminSetupPage() {
  const [session, locale] = await Promise.all([resolveServerSession(), resolveAppLocale()]);
  const ru = locale === 'RU';
  if (!session) {
    redirect('/login');
  }

  const isAdmin = session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN');
  if (!isAdmin) {
    return <AccessDeniedNotice area="setup" locale={locale} />;
  }

  const status = await getSetupStatus();

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{ru ? 'Первоначальная настройка' : 'Setup checklist'}</h1>
        <p className="setup-subtitle">
          {ru ? 'Вы вошли как' : 'Signed in as'} {session.user.username} ({session.user.roles.join(', ')})
        </p>
        <ul className="setup-list">
          {CHECKLIST.map((item) => {
            const done = status[item.key];
            const actionHref = done ? item.doneHref : item.createHref;
            const translated = ru ? ({
              hasCity: ['Город', 'Необязательная справочная запись для группировки объектов. Не блокирует настройку.'],
              hasSite: ['Объект', 'Фактическое место работы, куда назначается работник и где он отмечает приход.'],
              hasWorkArea: ['Рабочая зона', 'Необязательная часть объекта. Пропустите, если весь объект является одной рабочей зоной.'],
              hasTemplate: ['Шаблон рабочего графика', 'Определяет обычную рабочую неделю работника.'],
              hasWorker: ['Работник', 'Учётная запись сотрудника для отметки прихода/ухода и внесения часов.'],
              hasAssignment: ['Назначение', 'Связывает работника с объектом и графиком на выбранный срок.'],
              hasSubmissionScheduleConfigured: ['Цикл отправки табеля', 'Выберите для каждого активного работника: еженедельно или раз в две недели. Периоды будут создаваться автоматически.']
            } as Partial<Record<keyof SetupStatus, [string, string]>>)[item.key] : null;
            const actionLabel = done ? (ru ? (item.doneActionLabel === 'Add another' ? 'Добавить ещё' : 'Управлять') : (item.doneActionLabel ?? 'Manage')) : (ru ? (item.createActionLabel === 'Manage work areas' ? 'Управлять зонами' : item.createActionLabel === 'Configure cycles' ? 'Настроить циклы' : 'Создать') : (item.createActionLabel ?? 'Create'));
            return (
              <li key={item.key} className="setup-item">
                <span
                  className={done ? 'setup-status setup-status-done' : item.optional ? 'setup-status setup-status-optional' : 'setup-status setup-status-pending'}
                >
                  {done ? (ru ? 'Готово' : 'Done') : item.optional ? (ru ? 'Необязательно' : 'Optional') : (ru ? 'Не готово' : 'Not done')}
                </span>
                <span className="setup-copy">
                  <span className="setup-label">{translated?.[0] ?? item.label}</span>
                  <span className="setup-description">{translated?.[1] ?? item.description}</span>
                </span>
                {actionHref ? (
                  <Link className="setup-action" href={actionHref}>
                    {actionLabel}
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}
