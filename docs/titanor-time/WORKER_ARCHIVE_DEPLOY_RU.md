# Production deploy — архив работников (Вариант B, без миграции)

- **Дата:** 2026-09-02.
- **Вердикт:** **PASS**.
- **Product commit / deployed HEAD:** `08acb30` (`feat(time): archive deactivated workers out of the default list`).
- **Образ:** `titanor-time-app:worker-archive-08acb30` (`sha256:17855d1f…`).
- **Scope:** только production web. Scheduler, DB, Caddy, DNS, public site — не менялись. **Без миграции.**
- **Основание:** дефект R15 **D1b** — владелец выбрал Вариант B: «деактивировать» = «убрать в архив»
  (данные не удаляются), список работников по умолчанию скрывает архивных.

## Что изменено

- `listWorkers(page, size, { includeArchived })` — по умолчанию фильтр
  `employments: { some: { active: true } }`; возвращает `archivedCount`.
  `?archived=1` снимает фильтр.
- `GET /api/admin/workers?archived=1` — то же. Пикер назначений (`?pageSize=100`) теперь получает
  только активных работников (архивного всё равно нельзя назначить — `createAssignment` его отклоняет).
- `/admin/workers` — архивные скрыты по умолчанию; в подзаголовке переключатель
  **«Показать архив (N)» / «Скрыть архив»**.
- `WorkerActions.tsx` — секция «Деактивация» теперь объясняет: работник уходит в архив,
  ничего не удаляется, «Восстановить работника» возвращает, список по умолчанию архивных скрывает.
- Физического DELETE у Employee по-прежнему нет (by design, `T9_INTERNAL_TEST_PLAN.md` §1).

## Проверки до deploy

- `tsc --noEmit` чисто.
- Browser lane (disposable PG16 + app из кандидата): `_test-t9-setup-lifecycle.ts` **77/0**
  (шаги 20h–20l — фильтр на странице и в API, обе стороны), `_test-t9-role-matrix.ts` **33/0**,
  `_test-t9-setup-ui.ts` **26/0**, `_test-t9-full-flow.ts` **84/0**.
- Кандидат на `127.0.0.1:3198` против production-схемы: `/api/ready` 200 98/98, `/login` 200,
  `/admin/workers` + `?archived=1` без сессии 307, `/api/admin/workers` + `?archived=1` без сессии 401,
  error-логи 0. Контейнер удалён.
- Verified pre-deploy backup:
  `production-20260902T072241Z-pre-deploy` (1893 rows, 98 migrations, SHA256SUMS OK, off-box OK).

## Swap

- Web-only: `07:23:37Z` → `07:23:38Z`, ready `07:23:41Z` (~4 c), healthy ~+10 c.
- Новый `titanor-time-prod-app`: `worker-archive-08acb30`, healthy, RestartCount 0.
- Rollback-контейнер: `titanor-time-prod-app-pre-08acb30` на `worker-reactivate-c229a44`.
- Scheduler не заменялся: `r14-release-1416503`, тот же StartedAt, healthy.

## После deploy

- `https://app.titanorgroup.fi/api/ready` 200 98/98; `/login` 200.
- Live-проверка под `pilot-owner` (SUPER_ADMIN): `/admin/workers` рендерится, 9 активных;
  `archivedCount=0` → переключатель скрыт (архивных сейчас нет — это ожидаемо);
  `/api/admin/workers` возвращает `archivedCount`.
- `titanorgroup.fi/en` + `/fi` 200, `collabstudio.run` 200 — Caddy/DNS не менялись.
- Prod app/scheduler/db healthy, RestartCount 0, error-логи чисто.

## Rollback

До завершения R15 не удалять `titanor-time-prod-app-pre-08acb30` и pre-deploy backup.
`docker rm -f titanor-time-prod-app && docker rename titanor-time-prod-app-pre-08acb30
titanor-time-prod-app && docker start titanor-time-prod-app`. DB restore не нужен.

## Не сделано (осознанно)

- Матрица `/admin/workforce` — у неё свой фильтр «Занятость» (по умолчанию «Все»); не менял,
  чтобы deploy оставался узким. Если нужно — по умолчанию «Только активные» отдельным изменением.
- Отчёты `/admin/reports` — пикер работника показывает всех (по бывшим работникам нужны отчёты).
