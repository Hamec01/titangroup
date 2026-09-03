import Link from 'next/link';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { WorkerAssignmentCard, CardAssignment, CardTransition } from '@/lib/assignment-card';
import { ChangeWorkplaceForm } from './ChangeWorkplaceForm';
import { RemoveFromSiteAction } from './RemoveFromSiteAction';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §2.3 / §3 — the redesigned worker card's
// workplace blocks. Server components: they render the plain-language layout and hand each row to
// the client action components (ChangeWorkplaceForm / RemoveFromSiteAction).

function assignmentLabel(a: Pick<CardAssignment, 'siteName' | 'workAreaName'>): string {
  return a.workAreaName ? `${a.siteName} — ${a.workAreaName}` : a.siteName;
}

function stateLabel(locale: AppLocale, a: CardAssignment): string {
  switch (a.state) {
    case 'SHIFT_OPEN':
      return localeText(locale, 'Shift in progress', 'Идёт смена');
    case 'SCHEDULED':
      return localeText(locale, 'Scheduled', 'Запланировано');
    case 'ENDED':
      return localeText(locale, 'Finished', 'Завершено');
    case 'NEEDS_ATTENTION':
      return localeText(locale, 'Needs attention', 'Требует внимания');
    default:
      return localeText(locale, 'Working here now', 'Работает здесь сейчас');
  }
}

function reasonLabel(locale: AppLocale, code: string, text: string | null): string {
  switch (code) {
    case 'PROJECT_DONE':
      return localeText(locale, 'Project finished', 'Проект завершён');
    case 'TRANSFER':
      return localeText(locale, 'Moved to another site', 'Перевод на другой объект');
    case 'ASSIGNED_BY_MISTAKE':
      return localeText(locale, 'Assigned by mistake', 'Назначен по ошибке');
    default:
      return text ?? localeText(locale, 'Other', 'Другое');
  }
}

export function WorkplaceNowSection({
  card,
  today,
  tomorrow,
  endDateDefaults,
  locale
}: {
  card: WorkerAssignmentCard;
  today: string;
  tomorrow: string;
  endDateDefaults: Record<string, string>;
  locale: AppLocale;
}) {
  const t = (en: string, ru: string) => localeText(locale, en, ru);
  return (
    <section id="worker-assignments" aria-label={t('Workplace now', 'Место работы сейчас')}>
      <h2>{t('Workplace now', 'Место работы сейчас')}</h2>
      {card.currentAssignments.length === 0 ? (
        <div className="worker-setup-callout">
          <p>
            {t(
              'No site has been assigned yet. The worker can already sign in and install the app — it will explain the employer has not assigned a site.',
              'Объект ещё не назначен. Работник уже может войти и установить приложение — оно сообщит, что начальник пока не назначил объект.'
            )}
          </p>
        </div>
      ) : (
        <ul className="setup-list">
          {card.currentAssignments.map((a) => (
            <li key={a.assignmentId} className="setup-item setup-item-column" data-assignment-id={a.assignmentId}>
              <span className="setup-label">
                <Link href={`/admin/sites/${a.siteId}`}>{a.siteName}</Link>
                {a.workAreaId && a.workAreaName ? (
                  <>
                    {' — '}
                    <Link href={`/admin/work-areas/${a.workAreaId}`}>{a.workAreaName}</Link>
                  </>
                ) : null}
                {a.isPrimary ? ` — ${t('main workplace', 'основное место')}` : ''}
                {' · '}
                <span className="assignment-state">{stateLabel(locale, a)}</span>
              </span>
              <span className="setup-subtitle">
                {a.templateName
                  ? t(`Schedule: ${a.templateName}`, `График: ${a.templateName}`)
                  : t('No schedule template', 'Без шаблона графика')}
              </span>
              <div className="assignment-actions">
                <ChangeWorkplaceForm assignment={a} today={today} tomorrow={tomorrow} />
                <RemoveFromSiteAction assignment={a} today={today} defaultValidTo={endDateDefaults[a.assignmentId] ?? today} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ScheduledChangesSection({ card, locale }: { card: WorkerAssignmentCard; locale: AppLocale }) {
  const t = (en: string, ru: string) => localeText(locale, en, ru);
  if (card.scheduledChanges.length === 0) {
    return null;
  }
  return (
    <section aria-label={t('Scheduled changes', 'Запланированные изменения')}>
      <h2>{t('Scheduled changes', 'Запланированные изменения')}</h2>
      <p className="setup-subtitle">
        {t(
          'The worker moves automatically on the date below — nothing else needs doing. To change or cancel a plan, use "Change workplace" on the current assignment.',
          'Работник перейдёт автоматически в указанную дату — больше ничего делать не нужно. Чтобы изменить или отменить план, используйте «Изменить место работы» у текущего назначения.'
        )}
      </p>
      <ul className="setup-list">
        {card.scheduledChanges.map((s) => (
          <li key={s.assignment.assignmentId} className="setup-item setup-item-column" data-scheduled-id={s.assignment.assignmentId}>
            <span className="setup-label">
              {t(`From ${s.assignment.validFrom}`, `С ${s.assignment.validFrom}`)}
              {' → '}
              <strong>{assignmentLabel(s.assignment)}</strong>
              {s.assignment.isPrimary ? ` — ${t('main workplace', 'основное место')}` : ''}
            </span>
            {s.transition ? (
              <span className="setup-subtitle">
                {t(
                  `Scheduled by ${s.transition.actorName ?? '—'} on ${s.transition.actedAt.slice(0, 10)}`,
                  `Запланировал ${s.transition.actorName ?? '—'} · ${s.transition.actedAt.slice(0, 10)}`
                )}
              </span>
            ) : null}
            {!s.cancellable ? (
              <span className="setup-subtitle">{t('The worker already has hours against this — it can no longer be cancelled cleanly.', 'По этому назначению уже есть часы — отменить его без последствий уже нельзя.')}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PastAssignmentsSection({ card, locale }: { card: WorkerAssignmentCard; locale: AppLocale }) {
  const t = (en: string, ru: string) => localeText(locale, en, ru);
  if (card.pastAssignments.length === 0 && card.recentTransitions.length === 0) {
    return null;
  }
  // pair each past assignment with the transition that ended it, for the reason line
  const removeByFrom = new Map<string, CardTransition>();
  for (const tr of card.recentTransitions) {
    if ((tr.kind === 'REMOVE' || tr.kind === 'CHANGE' || tr.kind === 'SITE_FINISH') && tr.fromAssignmentId) {
      if (!removeByFrom.has(tr.fromAssignmentId)) {
        removeByFrom.set(tr.fromAssignmentId, tr);
      }
    }
  }
  return (
    <details className="worker-past-assignments">
      <summary>
        {t('Past assignments', 'Прошлые назначения')} ({card.pastAssignments.length})
      </summary>
      {card.pastAssignments.length > 0 ? (
        <ul className="setup-list">
          {card.pastAssignments.map((a) => {
            const tr = removeByFrom.get(a.assignmentId);
            return (
              <li key={a.assignmentId} className="setup-item setup-item-column">
                <span className="setup-label">{assignmentLabel(a)}</span>
                <span className="setup-subtitle">
                  {a.validFrom} → {a.validTo ?? (a.clockInDisabledAt ? a.clockInDisabledAt.slice(0, 10) : '—')}
                  {tr ? ` · ${t('Reason', 'Причина')}: ${reasonLabel(locale, tr.reasonCode, tr.reasonText)}` : ''}
                  {tr?.actorName ? ` · ${t('by', 'изменил')} ${tr.actorName}` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="setup-subtitle">{t('No past assignments.', 'Прошлых назначений нет.')}</p>
      )}
    </details>
  );
}
