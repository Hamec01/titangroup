# Root-runbook: восстановление `titanorgroup-backup.service` (backup ПУБЛИЧНОГО сайта)

**Основание:** `fixroad.md` F04. **Это backup публичного сайта `titanorgroup.fi`, НЕ Titanor Time.**
Titanor Time backup (`titanor-time-backup@production.timer`) и GPS-archive работают и копируются
off-box — их этот runbook не касается.

> **Требуется root.** Все команды ниже — под `sudo`. **Ничего под root не менять без отдельного
> подтверждения владельца.** Раздел 1 (диагностика) — только чтение, можно выполнять; разделы 3–4
> (правка причины, ручной запуск) — только после подтверждения и после того, как раздел 1 показал
> конкретную причину.

---

## 0. Что известно (read-only, без root, срез 2026-09-04 ~12:00 UTC)

| | |
|---|---|
| Unit | `/etc/systemd/system/titanorgroup-backup.service` — `Type=oneshot`, `User=root`, `ExecStart=/usr/local/sbin/backup-titanorgroup.sh` |
| Скрипт | `/usr/local/sbin/backup-titanorgroup.sh` — `-rwx------ root root`, 1356 байт, дата 2026-07-09 (не читается без root) |
| Таймер | `titanorgroup-backup.timer` — `OnCalendar=*-*-* 03:30`, `Persistent=true`, `RandomizedDelaySec=10m`. Активен, следующий запуск ~03:32. |
| Последний прогон | **failed**, `code=exited, status=1/FAILURE`, `Fri 2026-09-04 03:37:07 CEST`. CPU 278 ms — **упал быстро** (похоже на конфиг / путь / права / отсутствующую команду, не на долгий сбой копирования). |
| Последний успешный артефакт on-box | `/home/deploy/backups/titanorgroup/pre-r14-20260831T155601Z/` (2026-08-31). Ежедневных снапшотов после 31 августа нет. |
| Off-box mirror | `/mnt/250gb/titanorgroup/backups/` — последняя папка тоже `…20260831T155601Z`. |
| Что бэкапится | 2 docker-volume публичного сайта: `titanorgroup_titanorgroup_data` (`/app/data`), `titanorgroup_titanorgroup_uploads` (`/app/public/uploads`). Контейнер `titanorgroup-web-1` — healthy, up 3 дня. |
| Диск `/` | 76 %, свободно ~35 GiB — **не причина**. |

---

## 1. Диагностика (root, только чтение)

```bash
# 1.1 полный статус + последний журнал прогона
sudo systemctl status titanorgroup-backup.service --no-pager -l
sudo journalctl -u titanorgroup-backup.service -n 200 --no-pager

# 1.2 только последний неуспешный запуск, с временными метками
sudo journalctl -u titanorgroup-backup.service --no-pager -o short-iso \
     --since "2026-09-01" | tail -120

# 1.3 сам скрипт (понять, на каком шаге падает)
sudo cat -n /usr/local/sbin/backup-titanorgroup.sh

# 1.4 проверить синтаксис скрипта, не выполняя его
sudo bash -n /usr/local/sbin/backup-titanorgroup.sh

# 1.5 что скрипт ожидает: целевые каталоги, права, docker-доступ
sudo ls -la /home/deploy/backups/titanorgroup/
sudo ls -la /mnt/250gb/titanorgroup/backups/
mountpoint -q /mnt/250gb && echo "/mnt/250gb смонтирован" || echo "/mnt/250gb НЕ смонтирован"
sudo docker volume ls | grep titanorgroup
sudo docker ps --filter name=titanorgroup-web-1

# 1.6 если в скрипте есть off-box по SSH/rsync — проверить доступность цели
#     (команду взять из вывода 1.3; например:)
# sudo -u root ssh -o BatchMode=yes <backup-host> true
```

**Типовые причины `status=1` с быстрым выходом (сверить с выводом 1.2/1.3):**
- `/mnt/250gb` не смонтирован → off-box `cp/rsync` падает (`set -e`);
- каталог назначения off-box переименован/удалён;
- в PATH юнита нет нужной команды (юнит задаёт `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` — если скрипт зовёт `docker` из `/usr/bin/docker`, ок; если что-то из `~/.local/bin` — не найдёт);
- volume/имя контейнера в скрипте не совпадает с текущим (`titanorgroup_titanorgroup_data` / `titanorgroup-web-1`);
- `SHA256SUMS` / checksum-шаг падает из-за пустого/битого предыдущего артефакта;
- нет места на off-box томе (проверить `df -h /mnt/250gb`);
- скрипт делает `docker exec`/`docker run` и `docker.service` был недоступен в момент запуска (юнит имеет `Wants=docker.service` + `After=…`, но не `Requires=`).

---

## 2. СТОП — показать причину владельцу

После раздела 1 сформулировать **одну конкретную причину** и предложить **минимальную правку**.
Дальше — только после подтверждения владельца. Не менять скрипт «на всякий случай», не трогать
таймер, не удалять старые артефакты.

---

## 3. Исправление причины (root, ТОЛЬКО после подтверждения)

Общий принцип: правка минимальная, обратимая, с бэкапом изменяемого файла.

```bash
# 3.1 перед любой правкой скрипта/юнита — копия
sudo cp -a /usr/local/sbin/backup-titanorgroup.sh /root/backup-titanorgroup.sh.bak-$(date -u +%Y%m%dT%H%M%SZ)
sudo cp -a /etc/systemd/system/titanorgroup-backup.service /root/titanorgroup-backup.service.bak-$(date -u +%Y%m%dT%H%M%SZ)

# 3.2 примеры точечных правок (применять только ту, что соответствует найденной причине):
#   - смонтировать off-box:            sudo mount /mnt/250gb   (и проверить /etc/fstab)
#   - создать пропавший каталог:        sudo mkdir -p /mnt/250gb/titanorgroup/backups && sudo chown root:root /mnt/250gb/titanorgroup/backups
#   - поправить имя volume/контейнера в скрипте: sudo sed -n '…p' затем sudo $EDITOR /usr/local/sbin/backup-titanorgroup.sh
#   - добавить в юнит зависимость:      sudo systemctl edit titanorgroup-backup.service   → [Unit] Requires=docker.service

# 3.3 перечитать systemd, если менялся юнит
sudo systemctl daemon-reload

# 3.4 ещё раз проверить синтаксис скрипта
sudo bash -n /usr/local/sbin/backup-titanorgroup.sh
```

---

## 4. Ручной запуск и проверка (root, после исправления)

```bash
# 4.1 запустить юнит вручную и дождаться завершения (oneshot)
sudo systemctl start titanorgroup-backup.service
sudo systemctl status titanorgroup-backup.service --no-pager -l
sudo journalctl -u titanorgroup-backup.service -n 100 --no-pager -o short-iso

# 4.2 on-box артефакт: свежая папка с сегодняшней датой
sudo ls -la /home/deploy/backups/titanorgroup/ | tail -5
NEW=$(sudo ls -1 /home/deploy/backups/titanorgroup/ | grep "$(date -u +%Y%m%d)" | tail -1)
echo "новый снапшот: $NEW"
sudo ls -la "/home/deploy/backups/titanorgroup/$NEW"
#   ожидается: titanorgroup-data.tar.gz + titanorgroup-uploads.tar.gz (+ SHA256SUMS, если скрипт его пишет)

# 4.3 целостность архивов (не распаковывая)
sudo gzip -t "/home/deploy/backups/titanorgroup/$NEW"/*.tar.gz && echo "gzip OK"
sudo tar -tzf "/home/deploy/backups/titanorgroup/$NEW/titanorgroup-data.tar.gz" | head
[ -f "/home/deploy/backups/titanorgroup/$NEW/SHA256SUMS" ] && \
  ( cd "/home/deploy/backups/titanorgroup/$NEW" && sudo sha256sum -c SHA256SUMS )

# 4.4 off-box копия появилась и совпадает
sudo ls -la "/mnt/250gb/titanorgroup/backups/$NEW"
sudo diff -rq "/home/deploy/backups/titanorgroup/$NEW" "/mnt/250gb/titanorgroup/backups/$NEW" && echo "on-box == off-box"
#   или, если скрипт кладёт SHA256SUMS: сверить суммы в обеих папках

# 4.5 restore-check в ОДНОРАЗОВЫЙ каталог/контейнер — НЕ трогая рабочие volume
TMP=$(mktemp -d /tmp/tg-restore.XXXX)
sudo tar -xzf "/home/deploy/backups/titanorgroup/$NEW/titanorgroup-data.tar.gz" -C "$TMP"
sudo tar -xzf "/home/deploy/backups/titanorgroup/$NEW/titanorgroup-uploads.tar.gz" -C "$TMP"
sudo ls -la "$TMP"
#   быстрый smoke: поднять временный контейнер на распакованных данных, не публикуя порт наружу
sudo docker run --rm -d --name tg-restore-test \
  -v "$TMP/data:/app/data:ro" -v "$TMP/uploads:/app/public/uploads:ro" \
  -p 127.0.0.1:8899:3000 "$(sudo docker inspect titanorgroup-web-1 --format '{{.Config.Image}}')"
sleep 4
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8899/en   # ожидается 200
sudo docker rm -f tg-restore-test
sudo rm -rf "$TMP"

# 4.6 следующий автоматический прогон
sudo systemctl list-timers titanorgroup-backup.timer --no-pager
#   на следующий день (или после `sudo systemctl start titanorgroup-backup.timer`-триггера в тест-окне)
#   повторить 4.1–4.4 и убедиться, что таймерный прогон тоже PASS
```

---

## 5. Приёмка F04 (совпадает с `fixroad.md` F04)

- [ ] `systemctl is-failed titanorgroup-backup.service` **не** возвращает `failed`;
- [ ] есть свежий on-box артефакт с сегодняшней датой (data + uploads);
- [ ] off-box копия совпадает (diff / SHA256SUMS);
- [ ] restore-check PASS (временный контейнер отдаёт `/en` → 200), рабочие volume не тронуты;
- [ ] следующий таймерный прогон тоже PASS;
- [ ] причина сбоя записана (что именно было сломано и какой минимальной правкой исправлено);
- [ ] изменённые файлы (`backup-titanorgroup.sh` / юнит) — с датированной `.bak` копией в `/root`.

Если публичный сайт решено **не** включать в передачу заказчика — это записать явно (в `fixroad.md`
и `IMPLEMENTATION_STATUS.md`) и назначить владельца, а не оставлять failed-unit молча.

---

## 6. Rollback

```bash
# вернуть скрипт/юнит из датированной копии
sudo cp -a /root/backup-titanorgroup.sh.bak-<TS> /usr/local/sbin/backup-titanorgroup.sh
sudo cp -a /root/titanorgroup-backup.service.bak-<TS> /etc/systemd/system/titanorgroup-backup.service
sudo systemctl daemon-reload
```
Артефакты и off-box копии при откате не удалять.
