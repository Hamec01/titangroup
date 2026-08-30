# Titanor Time — R03: учётные записи, профили и recovery без SMTP

- **Основание:** production release roadmap R03, ТЗ §6–§7.
- **Дата:** 2026-08-30.
- **Production / Caddy / DNS не затронуты.** Перед первым pilot deploy — `pre-deploy` backup (в скрипте деплоя).

---

## 1. Что было и что стало

| Область | Было | Стало (R03) |
|---|---|---|
| Восстановление пароля | self-service по email + SMTP (`/forgot-password`, `password-reset-mailer.ts`); на пилоте не подключено | **admin-assisted, без SMTP.** Админ на карточке пользователя/работника жмёт «Восстановить доступ» → одноразовый код `XXXX-XXXX-XXXX` показывается один раз |
| Ввод восстановления | ссылка с токеном в URL `/reset-password/<token>` | `/reset-password` — работник вводит **логин + код + новый пароль** |
| Смена пароля | не было (только активация по токену) | `POST /api/auth/change-password` — по текущему паролю; форма на `/admin/profile` и `/worker/profile` |
| Смена email | `updateAccountEmail` (по текущему паролю) — уже была | без изменений; текст «email для восстановления» → «email для входа и связи» (ТЗ §6.3) |
| Сессии | только «выйти на всех устройствах» (`logout-all`) | + список активных сессий (устройство/IP/активность) + завершение выбранной |
| Профиль ADMIN | логин, роли, email | + последний вход, язык, ссылка на инструкцию, смена пароля, сессии (полный набор ТЗ §6.1) |
| Email как логин | уже работал (`OR [username, email]`) | без изменений |

## 2. Модель кода восстановления

- Формат: 12 символов Crockford base32 (без I/L/O/U), группами — `K7M4-9QX2-P3RF`. ~60 бит.
- Хранится только `HMAC-SHA256(PASSWORD_RESET_TOKEN_HMAC_KEY, canonicalCode)` — сырой код в БД/логи не попадает.
- Срок жизни 45 минут (`RECOVERY_CODE_TTL_MS`). Новый код отзывает прежний.
- Лимит попыток на код: `RECOVERY_MAX_ATTEMPTS = 5` (`PasswordResetToken.attemptCount`) → код сам себя
  отзывает + audit `ACCOUNT_RECOVERY_LOCKED` (ТЗ §7.2).
- Успешный redeem: новый `passwordHash`, **все сессии отозваны**, код помечен использованным,
  audit `ACCOUNT_RECOVERY_COMPLETED`.
- Не-enumerating: неизвестный логин / нет активного кода / неверный код → одинаковый ответ
  `RECOVERY_INVALID` (400). `EXPIRED` тоже сворачивается в него на уровне route. Ошибка политики
  пароля (`VALIDATION_ERROR`) — отдельная и **не расходует код**.
- Активация (`PENDING_ACTIVATION`, первый вход) и восстановление (`ACTIVE`/`OFFBOARDING`) — разные
  права (`user.activation.generate` vs `user.recovery.generate`), разные event types, разные
  проверки статуса (ТЗ §7.2).

## 3. Схема

- **`20260830090000_account_recovery_admin_assisted`** — `PasswordResetToken.issuedByUserId`
  (админ, выдавший код; NULL для legacy) + `attemptCount`; право `user.recovery.generate` →
  ADMIN, SUPER_ADMIN.
- **`20260830100000_seed_session_own_permissions`** — `session.read.own` + `session.revoke.own`
  → все аутентифицированные роли (`session.revoke_all.own` уже существовало).

Обе миграции — чистое применение с нуля + к копии пилота, без предупреждений.

## 4. API

| Метод / путь | Назначение | Гейт |
|---|---|---|
| `POST /api/admin/users/:userId/recovery` | выдать код standalone-пользователю | `user.recovery.generate`, CSRF, Idempotency-Key |
| `POST /api/admin/workers/:employeeId/recovery` | выдать код работнику (резолвит User) | то же |
| `POST /api/auth/password-reset/confirm` | `{login, code, password}` → сброс | публичный, IP + per-login rate limit |
| `POST /api/auth/change-password` | `{currentPassword, newPassword}` | сессия, CSRF, rate limit |
| `GET /api/me/sessions` | свои активные сессии | `session.read.own` |
| `DELETE /api/me/sessions/:id` | завершить свою сессию | `session.revoke.own`, CSRF |

Удалено: `POST /api/auth/password-reset/request`, `lib/password-reset-mailer.ts`,
`lib/password-reset.ts`, `/forgot-password`, `/reset-password/request`, `/reset-password/[token]`,
`nodemailer` из `titanor-time-app`.

## 5. UI

- `/reset-password` — публичная страница (логин + код + новый пароль ×2), RU/EN.
- `components/account/`: `AccountSettingsForm` (email + последний вход), `ChangePasswordForm`,
  `SessionsPanel`, `RecoveryCodeIssuer` (показ кода один раз, копирование, перевыдача,
  обработка сетевой неопределённости через Idempotency-Key).
- `/admin/profile` — полный экран (ТЗ §6.1). `/worker/profile` — тот же account-блок.
- `/admin/users` — «Восстановить доступ» для ACTIVE/OFFBOARDING. `/admin/workers/[id]` — для
  `ALREADY_ACTIVE`.
- Необязательные поля профиля не блокируют clock (Check In/Out/submit целиком под `/worker`).

## 6. Тесты

| Тест | Lane | Проверок | Покрытие |
|---|---|---:|---|
| `_test-account-recovery.ts` | db | 28 | issue eligibility, one-active-code, redeem happy/wrong-login/wrong-code/attempt-lock/expiry/policy/reuse, email login, updateAccountEmail |
| `_test-recovery-api.ts` | db | 17 | routes issue (worker+user), CSRF/permission/Idempotency-Key/replay, `password-reset/confirm` |
| `_test-change-password.ts` | db | 10 | current-password gate, keeps this session, revokes others, audit |
| `_test-session-management.ts` | db | 15 | list + current flag + no token hash, revoke one, revoke-own-current clears cookie, cross-user 404 |

Полный `npm run test:unit` + `test:db` — **62/62** (11 unit + 51 db, включая 4 новых R03), 0 регрессий. Browser-lane (в т.ч. `_test-t9-role-matrix`)
— на R12.

## 7. Deploy (R03.12)

Скрипт `deploy-<sha>.sh`:
1. `bash ops/titanor-time/backup-titanor-time.sh pre-deploy` — обязательный pre-deploy backup.
2. Если в `app.env` нет `PASSWORD_RESET_TOKEN_HMAC_KEY` — сгенерировать (`openssl rand -base64 32`)
   и дописать (пока этим ключом ничего не зашифровано — свежий безопасен).
3. Собрать образ с изолированным тегом.
4. `prisma migrate deploy` (2 миграции).
5. Пересоздать app + scheduler с `--env-file app.env`.
6. Verify: `/api/ready` `/api/health` `/login` `/reset-password` = 200; счётчик миграций;
   prod baseline не изменился.
Rollback: переименованные `-pre-<sha>` контейнеры.

## 8. Не входит (по ТЗ §6.4 / roadmap)

Профиль FOREMAN (`/foreman/profile` не создаётся — восстановление FOREMAN админ делает тем же
процессом), SMTP, email verification, финский язык.
