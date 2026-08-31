# Production deploy — customer-report scope picker

- **Дата:** 2026-08-31.
- **Вердикт:** **PASS**.
- **Product commit:** `ecaf87a`; deployed source HEAD: `c6f9cb4` (выше только docs/test tallies).
- **Образ:** `titanor-time-app:customer-scope-c6f9cb4`.
- **Scope:** только production web; scheduler, DB, Caddy, DNS и public site не менялись.

## До deploy

- Ветка чистая и синхронизирована с GitHub.
- Сборка production Docker image прошла: Prisma generate, Next build, TypeScript и runtime bundles.
- Кандидат поднят на отдельном loopback `127.0.0.1:3198` против production-схемы:
  `/api/ready` 200 `schema:current` 98/98, `/login` 200, customer report redirect без сессии,
  scope API 401 без сессии, fatal/error log matches 0. Disposable-контейнер удалён.
- Создан verified pre-deploy backup:
  `/home/deploy/backups/titanor-time-production/production-20260831T204919Z-pre-deploy` —
  1789 rows, 98 migrations, uploads archive, SHA256SUMS OK.
- Off-box mirror:
  `/mnt/250gb/titanor-time-foundation/backups/production/production-20260831T204919Z-pre-deploy`.

## Swap

- Web-only swap: `20:55:56Z` → `20:56:00Z` (около 4 секунд).
- Новый `titanor-time-prod-app`: image `customer-scope-c6f9cb4`, revision
  `c6f9cb46a7040eeba315ac0668622b56c883f5c5`, healthy, RestartCount 0.
- Старый web сохранён остановленным:
  `titanor-time-prod-app-pre-c6f9cb4` на `titanor-time-app:r14-release-1416503`.
- Scheduler намеренно не заменялся: feature не меняет scheduler/runtime; текущий scheduler остался
  healthy со свежими тиками. Это исключило ненужную смену lease.

## После deploy

- `https://app.titanorgroup.fi/api/ready` 200, schema 98/98.
- `/login` 200; новый `/api/admin/reports/customer/scope` без сессии 401.
- Production web / scheduler / DB healthy; RestartCount 0.
- `titanorgroup.fi/en` и `/fi` 200; Caddy/DNS не менялись.
- UI/db/build evidence до deploy: `CUSTOMER_REPORT_SCOPE_PICKER_REPORT_RU.md`.

## Rollback

До завершения наблюдения не удалять `titanor-time-prod-app-pre-c6f9cb4` и backup. При системном
дефекте остановить/удалить новый web, переименовать rollback-контейнер обратно в
`titanor-time-prod-app` и запустить; DB restore для этого code-only deploy не нужен.

