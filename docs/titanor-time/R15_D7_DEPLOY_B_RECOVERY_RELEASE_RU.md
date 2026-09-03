# R15-D7 — объединённый релиз: Deploy B + восстановление пароля (ссылка + QR)

**Статус:** ✅ **РАЗВЁРНУТО НА PRODUCTION 2026-09-03 ~06:40 UTC** (`titanor-time-app:d7b-recovery-80d5c9c`,
**без миграции**, схема 100, простой **≈ 2.6 c**). Разрешение владельца — 2026-09-03. Итог — §6.

Ветка `feature/titanor-time-foundation`, HEAD **`80d5c9c`** (= `7fd9bd2` код + этот отчёт; между
ними только docs). `git cherry-pick cdc04b6` поверх Deploy B `157850f`.
Финальный образ **`titanor-time-app:d7b-recovery-80d5c9c`** (собран из HEAD `80d5c9c`; код идентичен
`d7b-recovery-7fd9bd2`, на котором прошла полная регрессия).

---

## 1. Зачем объединение

Production после моего предыдущего отчёта обновили отдельным hotfix'ом восстановления пароля:
- сейчас на проде — `titanor-time-app:recovery-cdc04b6`, схема 100/100;
- коммит `cdc04b6` (ветка `fix/recovery-link-qr`) — «ссылка + QR для нового пароля».

`d7b-40778bb` (старая сборка Deploy B) **выкладывать нельзя** — в ней нет hotfix'а, и после swap
пропали бы ссылка и QR. Поэтому следующий релиз обязан содержать **всё сразу**:
Deploy A + Deploy D1/D2 + восстановление пароля (ссылка+QR) + Deploy B (новая карточка работника).

## 2. Как сделано слияние

`git checkout feature/titanor-time-foundation` (там уже Deploy A + D1 + D2 + Deploy B,
`157850f`) → `git cherry-pick cdc04b6`.

**Конфликтов не было** — cherry-pick применился 3-way чисто (6 файлов, +142/−8):
- `lib/recovery-link.ts` — новый (fragment-based ссылка, код в `#hash`, не попадает в логи Caddy/Next);
- `components/account/RecoveryCodeIssuer.tsx` — `login?` prop → кнопка «Создать ссылку для нового
  пароля», локальная генерация QR (`qrcode`, dynamic import), «Копировать ссылку» / «Печать»;
- `app/reset-password/page.tsx` — читает `#login=…&code=…`, предзаполняет форму, очищает fragment;
- `scripts/_test-recovery-link.ts` — pure unit-тест (8 проверок);
- `scripts/test-manifest.json` — +1 запись (обе новые записи — `_test-recovery-link` и
  `_test-t9-worker-card-b` — присутствуют);
- `app/admin/workers/[employeeId]/page.tsx` — единственный общий с Deploy B файл: 1 строка —
  `<RecoveryCodeIssuer … login={worker.username} />`. Git автоматически наложил её на новую
  (Deploy B) версию файла на ту же строку. `worker.username` есть в `WorkerDetail` — проверено.

`recovery-link.ts` — единственная логика, чисто клиентская; новых API-роутов, миграций и изменений
схемы нет. Схема остаётся **100**.

## 3. Проверки объединённого дерева (образ `d7b-recovery-7fd9bd2`, чистый PG16)

- `npx tsc --noEmit` — чисто.
- `npm run lint` — чисто (prisma validate, форматирование схемы, test-manifest в синхроне,
  migration-inventory в синхроне = 100, runtime-бандлы, нет секретов).
- `next build` — чисто.
- Шаблонная БД в `run-browser-acceptance.sh`: миграция 100 применяется чисто из образа.

| Тест | Combined (`d7b-recovery-7fd9bd2`) | Deploy B baseline (`d7b-b23bdd8`) |
|---|---|---|
| unit lane (вкл. `_test-recovery-link` **новый**, `_test-worker-clock-panel`) | **18 / 18** | 17 / 17 |
| `_test-t9-worker-card-b` (B1–B4 + P1–P6 через UI, 22/22 P-проверок) | **34 / 34** | 34 / 34 |
| `_test-t9-setup-lifecycle` | **113 / 113** | 113 / 113 |
| `_test-t9-assignment-lifecycle` (L1–L16 + P1–P6 API) | **118 / 118** | 118 / 118 |
| `_test-t9-full-flow` (clock→табель→approval) | **84 / 84** | 84 / 84 |
| `_test-t9-setup-ui` | **26 / 26** | 26 / 26 |
| `_test-t9-role-matrix` | **33 / 33** | 33 / 33 |

**Все совпадают с baseline Deploy B + 1 новый unit-тест (`_test-recovery-link` 8 проверок).**
Слияние ничего не сломало ни в карточке работника, ни в восстановлении пароля.

### Boot-smoke объединённого образа (disposable PG16)
- `migrate deploy` из образа → схема **100/100** чисто;
- `/api/ready` = 200 `schema: current, 100/100`;
- `/reset-password` = 200, `/login` = 200;
- в логе старта ошибок нет.

## 4. План production (после отдельного разрешения)

**Без миграции** — схема остаётся 100 (Deploy A+D2 уже на проде; recovery и Deploy B миграций
не несут). Один web-only swap:

1. `backup-titanor-time.sh pre-deploy` (production env, verified on+off-box SHA256SUMS).
2. Кандидат `d7b-recovery-<финальный SHA>` на `127.0.0.1:3198` против prod-схемы — read-only
   smoke (`/api/ready` → `schema: current 100/100`), карточка работника, форма «Изменить место
   работы», «Работник забыл пароль?» → ссылка+QR. **Никаких write-smoke в prod БД.**
3. Web-only swap: `docker stop -t 30 titanor-time-prod-app` → `docker rename` →
   `titanor-time-prod-app-pre-<sha>` → `docker run` новый. **~4 c простоя.**
4. `titanor-time-prod-app-pre-<sha>` (образ `recovery-cdc04b6`) сохраняется как rollback —
   откат образа, ~4 c, **без отката схемы** (`checkSchemaReadiness` старого образа = `current`,
   миграций не менялось).
5. scheduler / Caddy / DNS / пароли / публичный сайт — не трогать.

## 5. Что в релизе / чего нет

**Есть:** Deploy A (единый гейт + lifecycle-сервис + C8 + §3.12), Deploy D1/D2 (модель «≤1
основного на пересекающийся период» + EXCLUDE-constraint), восстановление пароля (ссылка+QR),
Deploy B (новая карточка работника: «Место работы сейчас» / «Запланированные изменения» /
«Прошлые назначения», одна форма «Изменить место работы» + сводка, «Снять с объекта» с пресетами
причин, пометка перехода в табеле).

**Нет:** Deploy C (завершение объекта / отключение заказчика), Deploy E (групповой перевод),
Deploy F (отчёт «Часы заказчику»).

---

## 6. Production deploy — выполнено 2026-09-03 (строго по плану)

### Хронология
| шаг | детали |
|---|---|
| Финальная сборка | `titanor-time-app:d7b-recovery-80d5c9c` из HEAD `80d5c9c` (`GIT_SHA=80d5c9c`). Код `git diff 7fd9bd2 80d5c9c` = **только 1 docs-файл**, 0 изменений кода/конфига/тестов → полная регрессия на `7fd9bd2` покрывает. Boot-smoke финального образа: `migrate deploy` → схема 100/100, `/api/ready` 200, `/login` 200, `/reset-password` 200, `/worker` 307, 0 ошибок. |
| Backup | `production-20260903T063748Z-pre-deploy` — 2256 строк, 100 миграций, on+off-box mirror OK. `restore-test`: **13/13 PASS** (паритет: миграции, 75 таблиц, 41 триггер, 182 FK, построчные count'ы, all-data SHA-256, uploads). |
| Кандидат `:3198` | `d7b-recovery-80d5c9c` на `127.0.0.1:3198`, сеть `titanor-time-prod-net`, prod `--env-file`, uploads-bind **`:ro`**. `/api/ready` 200 `current 100/100`. **Read-only smoke на реальных prod-данных:** `/admin`, `/admin/workers`, реальная карточка работника (41 KB), `/admin/sites`, реальный объект, реальный заказчик, `/admin/timesheets`, `/api/admin/{workers,assignments}` — **все 200**. Карточка работника содержит новые блоки Deploy B («Место работы сейчас» / «Изменить место работы» / «Снять с объекта») **и** кнопку «Создать ссылку для нового пароля». Сессия для проверки — 1 INSERT в `UserSession` + DELETE после (проверено: 0). 0 ошибок в логе кандидата. |
| **Web-only swap** | T0 `docker stop -t 30` **06:40:08.105Z** → контейнер остановился 06:40:08.628 → `docker rename titanor-time-prod-app → titanor-time-prod-app-pre-80d5c9c` → `docker run` новый (идентичная конфигурация: net `titanor-time-prod-net`, `-p 127.0.0.1:3199:3000`, uploads-bind, тот же `--env-file`, тот же healthcheck 15s/5s/40s/×4, `--restart unless-stopped`) 06:40:09.103 → **`/api/ready` = 200 в 06:40:10.741**. **Простой ≈ 2.6 c.** |
| Health | контейнер `healthy` через ~40 c (start-period). |

### Пост-swap проверки (live prod, через Caddy `https://app.titanorgroup.fi`)
- `/api/ready` → **200 `schema: current 100/100`** (локально и через Caddy);
- `/login` 200, неверные креды → **401**, `/worker` → **307**, `/reset-password` → **200**;
- аутентифицированно (сессия INSERT+DELETE): `/admin`, `/admin/workers`, реальная карточка
  работника, `/admin/sites`, `/admin/timesheets`, `/api/admin/{workers,assignments}` — **все 200**;
- карточка работника: блоки Deploy B + кнопка «Создать ссылку для нового пароля» присутствуют;
- **Mykhailo Sadovnikov #1004** (был двойной primary, исправлен в Deploy D2): `currentAssignments`
  = ровно 1 (Meyer Turku Shipyard — Aros Marine, primary) — фикс D2 держится под новой карточкой;
- **восстановление пароля — end-to-end через реальный браузер** (Ruslan Druz #1003, prod
  тест-аккаунт): «Создать ссылку для нового пароля» → выдан код `XXXX-XXXX-XXXX`, **QR —
  настоящий `data:image/png` (6.4 KB), сгенерирован в браузере**; «Копировать ссылку» →
  `https://app.titanorgroup.fi/reset-password#login=…&code=…` (**query пустой — секрет только во
  фрагменте**); переход по ссылке → `/reset-password` предзаполняет логин `druzr` + код, фрагмент
  из URL очищается, поля пароля пустые. Все 5 выданных при тесте `PasswordResetToken` для Ruslan
  → `revokedAt` проставлен (0 используемых кодов осталось), пароль/сессии не тронуты;
- лог приложения после swap: **0 ошибок**.

### Что НЕ менялось
Схема (100), scheduler (`r14-release-1416503`, up 2 дня), Caddy, DNS, пароли, публичный сайт —
без изменений.

### Rollback
- **Контейнер `titanor-time-prod-app-pre-80d5c9c` (образ `recovery-cdc04b6`) сохранён** —
  быстрый откат: `docker stop titanor-time-prod-app && docker rename titanor-time-prod-app
  titanor-time-prod-app-d7b-failed && docker rename titanor-time-prod-app-pre-80d5c9c
  titanor-time-prod-app && docker start titanor-time-prod-app` (~4 c).
- **Схему откатывать НЕ нужно** — миграций не было, оба образа ждут схему 100.
- Хранятся: контейнер `…-pre-80d5c9c`, образ `recovery-cdc04b6` (`c4a768aabf47`), backup
  `production-20260903T063748Z-pre-deploy` (on+off-box).

### Ветка / worktree
`feature/titanor-time-foundation` @ `80d5c9c` — задеплоенный код; worktree
`titanor-time-foundation` переключён с `fix/recovery-link-qr` на `feature/titanor-time-foundation`.

### Осталось в R15-D7
Deploy C (завершение объекта / отключение заказчика), Deploy E (групповой перевод), Deploy F
(отчёт «Часы заказчику») — не начаты, каждый — отдельное подтверждение владельца.
