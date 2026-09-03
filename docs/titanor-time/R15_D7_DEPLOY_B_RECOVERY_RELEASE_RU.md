# R15-D7 — объединённый релиз: Deploy B + восстановление пароля (ссылка + QR)

**Статус:** ✅ сборка + все проверки объединённого дерева зелёные. **Production не изменялся.**
Ждёт отдельного разрешения на production-деплой.

Ветка `feature/titanor-time-foundation`, HEAD **`7fd9bd2`** (`git cherry-pick cdc04b6` поверх
Deploy B `157850f`). Объединённый образ **`titanor-time-app:d7b-recovery-7fd9bd2`** (794 MB).
Перед production — свежая пересборка под финальный SHA (после push).

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
