// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §6 + §9 — the admin UI stays in the
// selected language, so a failed report operation shows a localized message keyed off the
// normalized error `code` (never a raw server string, SQL or stack trace). Unknown codes fall back
// to a generic localized sentence.

const RU: Record<string, string> = {
  REPORT_FILE_NOT_FOUND: 'Файл не найден — возможно, он уже удалён.',
  REPORT_FILE_CORRUPT: 'Файл повреждён и не был отдан. Создайте отчёт заново.',
  REPORT_FILE_INVALID: 'Не удалось собрать отчёт: некорректные параметры.',
  PERIOD_NOT_FOUND: 'Расчётный период не найден.',
  SITE_NOT_FOUND: 'Объект не найден.',
  WORKER_NOT_FOUND: 'Работник не найден.',
  VALIDATION_ERROR: 'Проверьте параметры запроса.',
  CSRF_REJECTED: 'Сессия устарела. Обновите страницу и попробуйте снова.',
  NOT_AUTHENTICATED: 'Сессия завершена. Войдите заново.',
  FORBIDDEN: 'Недостаточно прав для этого действия.',
  IDEMPOTENCY_KEY_REUSED: 'Этот запрос уже был использован для другого действия.',
  IDEMPOTENCY_KEY_IN_PROGRESS: 'Предыдущий такой же запрос ещё выполняется. Подождите немного.'
};

const EN: Record<string, string> = {
  REPORT_FILE_NOT_FOUND: 'File not found — it may already have been deleted.',
  REPORT_FILE_CORRUPT: 'The file failed its integrity check and was not served. Create the report again.',
  REPORT_FILE_INVALID: 'The report could not be built: invalid parameters.',
  PERIOD_NOT_FOUND: 'No payroll period with this id.',
  SITE_NOT_FOUND: 'No site with this id.',
  WORKER_NOT_FOUND: 'No worker with this id.',
  VALIDATION_ERROR: 'Check the request parameters.',
  CSRF_REJECTED: 'Your session is stale. Reload the page and try again.',
  NOT_AUTHENTICATED: 'Your session has ended. Sign in again.',
  FORBIDDEN: 'You do not have permission for this action.',
  IDEMPOTENCY_KEY_REUSED: 'This request key was already used for a different action.',
  IDEMPOTENCY_KEY_IN_PROGRESS: 'An identical request is still being processed. Wait a moment.'
};

export function reportErrorText(code: string | undefined, ru: boolean, fallbackKind: 'create' | 'delete'): string {
  const table = ru ? RU : EN;
  if (code && table[code]) return table[code];
  if (fallbackKind === 'delete') return ru ? 'Не удалось удалить файл.' : 'Could not delete the file.';
  return ru ? 'Не удалось создать файл.' : 'Could not create the file.';
}
