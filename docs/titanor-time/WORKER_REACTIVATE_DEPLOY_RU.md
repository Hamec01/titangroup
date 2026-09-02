# Production deploy — восстановление работника (reactivate)

- **Дата:** 2026-09-02.
- **Вердикт:** **PASS**.
- **Product commit / deployed HEAD:** `c229a44` (`feat(time): reactivate a deactivated worker`).
- **Образ:** `titanor-time-app:worker-reactivate-c229a44` (`sha256:cbaea92c…`).
- **Scope:** только production web. Scheduler, DB, Caddy, DNS, public site — не менялись. **Без миграции.**
- **Основание:** дефект R15 **D1** (`R15_OBSERVATION_RU.md`) — деактивация была в одну сторону,
  приложение писало «сначала восстановите работника», указывая на несуществующее действие.

## Что добавлено

- `POST /api/admin/workers/[employeeId]/reactivate` — обратное к sibling `deactivate`:
  те же guard-ы (CSRF-заголовок, malformed id → 404 без oracle, без Idempotency-Key),
  та же permission `worker.deactivate` (ADMIN + SUPER_ADMIN владеют всем жизненным циклом).
  Транзакция: `Employment.active=true` + очистка `endDate`/`deactivationReason`,
  `User.status=ACTIVE`, audit-событие `WORKER_REACTIVATED`. Повтор → `409 ALREADY_ACTIVE`.
  Не трогает `SiteAssignment` и не воскрешает отозванные сессии (работник входит заново).
- `WorkerActions.tsx` — секция **«Восстановление» / «Восстановить работника»**, показывается,
  когда трудоустройство неактивно (симметрично секции «Деактивация»). Сообщение о невозможности
  активации теперь указывает на эту кнопку.
- `_test-t9-setup-lifecycle.ts` — шаги 20b–20g: кнопка появляется, состояние меняется,
  `SiteAssignment` цел, audit-событие есть, повтор → 409.

## Проверки до deploy

- `tsc --noEmit` чисто.
- Browser lane (disposable PG16 + app из кандидата, `run-browser-acceptance.sh`):
  `_test-t9-setup-lifecycle.ts` **72/0**, `_test-t9-role-matrix.ts` **33/0**.
- Кандидат на loopback `127.0.0.1:3198` против production-схемы: `/api/ready` 200
  `schema:current` 98/98, `/login` 200, `POST …/reactivate` без сессии 401,
  malformed id без сессии 401, поведение идентично sibling `deactivate`. Контейнер удалён.
- Verified pre-deploy backup:
  `/home/deploy/backups/titanor-time-production/production-20260902T070449Z-pre-deploy`
  (1829 rows, 98 migrations, uploads, SHA256SUMS OK, off-box mirror OK).

## Swap

- Web-only: `07:06:25Z` → `07:06:26Z` (~1.6 c stop→run), ready `07:06:29Z` (~4 c), healthy ~+5 c.
- Новый `titanor-time-prod-app`: `worker-reactivate-c229a44`, healthy, RestartCount 0.
- Rollback-контейнер: `titanor-time-prod-app-pre-c229a44` на `titanor-time-app:guide-whats-new-1f35ebb`.
- Scheduler намеренно не заменялся (feature не трогает runtime/scheduler): `r14-release-1416503`,
  тот же StartedAt, healthy.

## После deploy

- `https://app.titanorgroup.fi/api/ready` 200, schema 98/98; `/login` 200.
- `POST /api/admin/workers/<id>/reactivate` без сессии → 401.
- `titanor-time-prod-{app,scheduler,db}` healthy, RestartCount 0; error-логи чисто.
- `titanorgroup.fi/en` + `/fi` 200, `collabstudio.run` 200 — Caddy/DNS не менялись.

## Rollback

До завершения R15 не удалять `titanor-time-prod-app-pre-c229a44` и pre-deploy backup.
При системном дефекте: `docker rm -f titanor-time-prod-app && docker rename
titanor-time-prod-app-pre-c229a44 titanor-time-prod-app && docker start titanor-time-prod-app`.
DB restore не нужен (code-only, без миграции).

## Не входит в этот deploy

«Удалить работника в архив» (второй запрос владельца) — отдельная задача: нужен либо
schema-миграция (`Employee.archivedAt`), либо изменение поведения списка работников
(скрывать неактивных по умолчанию + вкладка «Архив»). См. `R15_OBSERVATION_RU.md` D1.
