# Инцидент 2026-08-31 — Caddy остановлен на ~46 минут (все публичные сайты недоступны)

- **Severity:** высокая (внешний простой), данные не затронуты.
- **Окно простоя:** 2026-08-31 **08:41:43 – 09:27:28 CEST** (~46 мин). CEST = UTC+2.
- **Затронуто:** `titanorgroup.fi`, `www.titanorgroup.fi`, `collabstudio.run`,
  `84-247-130-242.sslip.io` (ardor staging), `t97-dd686bc3d4.84.247.130.242.nip.io` (pilot) —
  все отдавали таймаут/refused, т.к. на `:80`/`:443` никто не слушал.
- **НЕ затронуто:** контейнеры приложений и БД (работали всё время, health/ready на
  `127.0.0.1:3297` — 200), DNS, `/etc/caddy/Caddyfile` (не изменялся), сертификаты,
  данные, миграции.

## Причина (root cause)

**Команда `caddy stop`, выполненная агентом при проверке конфигурации R11 в scratchpad,
остановила боевой Caddy.**

Последовательность:

1. Агент проверял holding-паттерн Caddy (`error` + `handle_errors` + `file_server` → 503)
   во временном каталоге. Тестовый `Caddyfile` содержал `admin off` и слушал `:8899`.
2. Тест выполнил `caddy start --config Caddyfile`, затем **`caddy stop`** (без `--address`).
3. У тестового экземпляра `admin off` → своего admin API нет. Поэтому `caddy stop`
   подключился к admin API по адресу по умолчанию `localhost:2019` — **это боевой Caddy**
   (`127.0.0.1:2019`) — и корректно (graceful) его остановил в **08:41:43 CEST**.
4. systemd-юнит `caddy.service` — `Type=notify`, без `Restart=`. Процесс завершился с кодом 0
   → служба перешла в `inactive` и осталась выключенной.
5. Тестовый экземпляр (`caddy run --pingback … --config Caddyfile`, pid 40457) **пережил**
   `caddy stop` (его нельзя было адресовать без admin API) и продолжал работать на `:8899`
   до ~09:24, пока агент его не завершил вручную.

Подтверждение по времени: в выводе тестового `curl` фигурирует
`Last-Modified: Mon, 31 Aug 2026 06:41:43 GMT` (= 08:41:43 CEST) — момент теста; ровно
совпадает с моментом остановки Caddy.

**Запуск R11-скрипта `apply-caddy-r11.sh` (09:24 CEST) НЕ является причиной.** Он упал именно
потому, что Caddy уже был мёртв (admin API отказал на reload), и корректно откатил
`/etc/caddy/Caddyfile` из backup. Скрипт отработал fail-closed как задумано, но не смог
поднять уже остановленную службу.

## Восстановление

- Владелец: `sudo systemctl start caddy` (в **09:27:28 CEST**). Конфигурация не менялась.
- Все 5 vhost восстановлены: `titanorgroup.fi` 200 (после редиректа), `collabstudio.run` 200,
  ardor 200, pilot `/login` 200, pilot `/api/ready` 200 `schema:current` 98/98.
- Агент завершил осиротевший тестовый процесс Caddy (pid 40457).
- `/etc/caddy/Caddyfile` — побайтно совпадает с
  `Caddyfile.backup-before-r11-20260831T072400Z`, `caddy validate` — Valid.

## Что было сделано неправильно

1. **`caddy stop` / `caddy start` запускались на хосте, где работает боевой Caddy.** Эти
   команды адресуются admin API по `localhost:2019` и не различают экземпляры —
   `admin off` в тестовом конфиге не изолирует, а наоборот перенаправляет управляющую
   команду в боевой процесс.
2. Тест раскручивал реальный демон вместо `caddy adapt` / `caddy validate` (которые не
   поднимают сервер и ничего не трогают).
3. После теста не была выполнена немедленная проверка, что боевые сайты живы.

## Меры

1. **`ops/titanor-time/r11/apply-caddy-r11.sh` ужесточён:**
   - предусловие: `systemctl is-active --quiet caddy` — иначе abort (не пытаться reload/
     менять конфиг при выключенной службе);
   - baseline-снимок всех существующих vhost до изменений; abort, если хоть один уже лежит;
   - reload только через `systemctl reload caddy` (скрипт и так root), fallback —
     `caddy reload --config … --address 127.0.0.1:2019` (явный IPv4);
   - явный запрет в комментарии: никаких `caddy stop` / `caddy start` / bare `caddy reload`.
2. **Правило для агента (в память):** на хостах с боевым Caddy проверять конфиг только
   `caddy adapt` / `caddy validate`; `caddy start/stop/run` и `caddy reload` без
   `--address` — запрещены; после любой операции рядом с Caddy — немедленный `curl` всех
   vhost.
3. Проверка Caddyfile для R11 — только `caddy validate --config <tmpfile>` и `caddy adapt`,
   без запуска демона (уже достаточно: блок провалидирован).

## Остаточное состояние (безопасно, нужно для реального запуска R11)

- `/var/www/titanor-time-holding/index.html` (root, holding-страница) — создан упавшим
  запуском; корректный, используется реальным запуском R11.
- `/etc/caddy/Caddyfile.backup-before-r11-20260831T072400Z` — идентичен текущему конфигу.
- DNS: владелец создал `A app.titanorgroup.fi → 84.247.130.242` (DNS only) — **уже
  резолвится**. Это ожидаемый шаг R11 §3.2.
