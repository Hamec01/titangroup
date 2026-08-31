# R13 — автоматизированная device/role acceptance

- **Дата:** 2026-08-31.
- **Hotfix commit:** `1416503` (`fix(time): land admins on operational overview after login`).
- **Образ:** `titanor-time-app:r13-hotfix-1416503`.
- **Image ID:** `sha256:864267bb1698dc43d585fb0a094345766a1eff7afc006d778c42fc7eff5c4bbb`.
- **Статус:** автоматизируемая часть **PASS**. R14/cutover не разрешён.

## 1. Live role/mobile smoke на pilot

Реальные одноразовые `r13-*` аккаунты проверены через Chromium на публичном HTTPS pilot. Пароли,
cookies и координаты не записывались в Git/evidence.

- четыре реальных UI-login: SUPER_ADMIN / ADMIN / WORKER / FOREMAN;
- WORKER и FOREMAN не видят admin chrome на `/admin/users`, получают человеческий отказ без 500;
- Android phone `390x844` и Android tablet `800x1280`: touch включён, page-level horizontal overflow
  отсутствует, browser page errors отсутствуют;
- worker manifest доступен, `start_url`/`scope` ограничены `/worker`, основной clock action присутствует;
- pilot `/api/health` и `/api/ready` — 200, schema current 98/98.

Первый live-smoke был **37/40** и обнаружил одно реальное расхождение A1/A2: ADMIN и SUPER_ADMIN
после login попадали на `/admin/setup`, хотя release-ТЗ §19.5 требует `/admin` Today. Третье
расхождение было timing-only: registration Service Worker уже существовала с правильным scope, но
проверка прочитала состояние до перехода worker в `active`; полный PWA/cold-start набор ниже зелёный.

## 2. Исправление A1/A2

`app/login/page.tsx::resolveHomeRoute()` теперь направляет ADMIN/SUPER_ADMIN на `/admin`.
`/admin/setup` не удалён и остаётся доступен из admin navigation. Добавлена browser-регрессия в
`_test-t9-role-matrix.ts`; заодно исправлена узкая TypeScript-типизация locale-case в
`_test-offline-shell-locale.ts`, найденная честным `tsc --noEmit`.

## 3. Новый образ и автоматические доказательства

Все тесты выполнялись на disposable PostgreSQL 16 и disposable app containers, по одному clean DB
на browser-test. Pilot/production/Caddy/DNS/public site не изменялись.

Focused hotfix run:

- role/permission matrix: **33/33**;
- полный attendance→timesheet→approval flow с browser geolocation: **84/84**;
- offline cold restart: **6/6**;
- offline RU/EN/FI persistence: **12/12**;
- PWA install/lifecycle/mobile: **59/59**.

Полный browser-lane нового образа:

- основной isolated harness: **14 PASS / 0 FAIL**;
- `_test-offline-views.ts`: **71/71** (долго, 1093 s на загруженном хосте, но без timeout/fail);
- dedicated restart persistence: seed **84/84**, prepare **5/5**, реальный restart disposable app,
  verify **18/18**;
- dedicated worker dossier: **31/31**;
- итог: **16/16 browser test files PASS**.

Технические проверки: `git diff --check`, `tsc --noEmit`, production Docker/Next.js build — PASS.
Disposable containers/networks удалены. `titanor-time-app:latest` не перетегировывался.

## 4. Live safety после тестов

- pilot app/scheduler: healthy, RestartCount 0, исходный image/StartedAt не менялись;
- old production app/db: healthy, RestartCount 0, image/StartedAt не менялись;
- Caddy: active;
- pilot `/api/ready`: 200;
- `app.titanorgroup.fi`: 503 holding;
- `titanorgroup.fi`: 307 как до теста.

## 5. Что остаётся владельцу / release gate

Владелец подтвердил, что реальная установка PWA на iPhone работает. Автоматизация не заменяет
короткую ручную проверку реального GPS/offline на iPhone и, желательно, Android-планшете.

Не автоматизировались на общих pilot-аккаунтах намеренно: смена пароля, logout-all, шесть неверных
паролей/rate-limit и удаление одноразовых `r13-*` данных. Они меняют состояние аккаунтов и должны
выполняться владельцем либо на отдельной fixture.

Так как исправлен product-код и изменился image digest, прежний R12 rehearsal относится к
`r12-candidate-367420e`. Перед R14 новый `r13-hotfix-1416503` (или итоговый образ от этого commit)
обязан повторно пройти R12 restore/rehearsal и получить новый release manifest. До этого R13 нельзя
закрывать окончательно, а R14 начинать нельзя.
