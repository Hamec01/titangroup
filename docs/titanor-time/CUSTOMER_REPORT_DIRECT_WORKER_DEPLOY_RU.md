# Production deploy — прямой выбор работников в отчёте заказчика

- **Дата:** 2026-08-31.
- **Вердикт:** **PASS**.
- **Коммит:** `e9e7c62` (`feat(time): add direct worker customer report scope`).
- **Образ:** `titanor-time-app:customer-worker-scope-e9e7c62`.
- **Scope:** только production web. Scheduler, DB, Caddy, DNS и public site не менялись.

## Изменение

На `/admin/reports/customer` добавлен выбор «По объектам / По работникам». Прямой режим показывает
работника независимо от текущего назначения: без объекта — с явной пометкой; сменивший объект — со
всеми связанными объектами за диапазон дат. Экспорт использует существующую модель
`employeeIds`/`siteIds`; расчёты, readiness, PDF/CSV и схема БД не менялись.

## Проверки до deploy

- lint, Prisma validate, typecheck, production Docker build — PASS;
- `_test-customer-report-scope.ts` — PASS (включая no-site и multi-site);
- `_test-customer-report-scope-ui.ts` — PASS (реальный Chromium);
- `_test-customer-hours.ts` — PASS (регрессия отчёта/PDF/CSV);
- кандидат на `127.0.0.1:3198`: ready 200, schema 98/98, login 200, auth guards 307/401;
- verified backup:
  `/home/deploy/backups/titanor-time-production/production-20260831T215239Z-pre-deploy` —
  1799 rows, 98 migrations, uploads, checksums; off-box mirror — OK.

## Web-only swap

- Основное переключение: `21:54:23Z` → `21:54:27Z` (~4 с).
- Затем контейнер немедленно пересоздан с исходным Docker healthcheck, пропущенным в первой ручной
  команде; готов и healthy в `21:55:37Z`. Данные и код при этом не менялись.
- `titanor-time-prod-app`: новый образ, healthy, RestartCount 0.
- Предыдущий web сохранён остановленным как `titanor-time-prod-app-pre-e9e7c62` на образе
  `titanor-time-app:customer-scope-c6f9cb4`.
- Ещё более старый rollback `titanor-time-prod-app-pre-c6f9cb4` также не удалён.

## После deploy

- `https://app.titanorgroup.fi/api/ready` — 200, schema current 98/98;
- `/login` — 200; защищённый report — 307; scope API без сессии — 401;
- production scheduler и DB не перезапускались, healthy, RestartCount 0;
- `titanorgroup.fi/en` и `/fi` — 200; ошибок web-контейнера не найдено.

## Rollback

При дефекте остановить и удалить новый `titanor-time-prod-app`, переименовать
`titanor-time-prod-app-pre-e9e7c62` обратно в `titanor-time-prod-app` и запустить. Restore БД не
нужен: изменение code-only, миграций и записей при deploy не было.
