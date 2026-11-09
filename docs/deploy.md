# Развёртывание сервера Signage

Сервер — один Docker-контейнер (Node.js) в виртуальной машине Ubuntu на Proxmox. Медиатека лежит на сетевом диске SMB (приоритет), её копия и база SQLite — на локальном диске VM. Если SMB недоступен, сервер полностью работает с диска VM.

```
 Proxmox
 └── VM Ubuntu 24.04 (10.33.44.20)
     ├── /srv/signage-smb/share  ← SMB //10.33.44.5/signage, монтирует хост (deploy/setup-smb.sh)
     └── Docker: signage
         ├── /data/smb/share     ← тот же SMB (bind, propagation rslave)
         ├── /data/local-media   ← диск VM: загрузки без SMB и копия медиатеки (volume local_media)
         └── /data/db            ← диск VM, SQLite (volume db)
```

## 1. Виртуальная машина

В Proxmox создайте VM:

- ОС: Ubuntu Server 24.04 LTS;
- 2 vCPU, 2–4 ГБ RAM; диск — 20 ГБ **плюс объём медиатеки**: на диске VM хранится её полная копия для работы без SMB (если места мало, отключите `storage.localMirror`);
- сеть: мост в локальную сеть учреждения, статический IP (например `10.33.44.20`);
- включите **QEMU Guest Agent** (Options → QEMU Guest Agent) и установите его в VM: `sudo apt install qemu-guest-agent`.

Статический адрес задаётся в `/etc/netplan/*.yaml`, затем `sudo netplan apply`.

## 2. Docker и cifs-utils

```bash
sudo apt update
sudo apt install -y ca-certificates curl git cifs-utils
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER   # перелогиньтесь, чтобы работать без sudo
```

## 3. Сетевой диск

На файловом сервере (`10.33.44.5`) создайте шару, например `signage`, и пользователя с правом записи. Проверьте с VM, что она монтируется:

```bash
sudo mkdir -p /mnt/test
sudo mount -t cifs //10.33.44.5/signage /mnt/test -o username=signage,vers=3.0
ls /mnt/test && sudo umount /mnt/test
```

Если `vers=3.0` не подходит (старый NAS), подберите `2.1` или `2.0` и укажите в `.env` (`SMB_VERS`).

## 4. Код и настройки

```bash
sudo mkdir -p /opt/signage && sudo chown $USER /opt/signage
git clone <адрес репозитория> /opt/signage
cd /opt/signage
cp .env.example .env
cp config/config.example.yaml config/config.yaml
chmod 600 .env config/config.yaml
```

**`.env`**: адрес SMB и учётные данные:

```ini
PORT=8080
SMB_HOST=10.33.44.5
SMB_SHARE=signage
SMB_USER=signage
SMB_PASSWORD=...
SMB_DOMAIN=
SMB_VERS=3.0
SMB_ROOT=/srv/signage-smb
```

Смонтируйте SMB на хосте:

```bash
sudo ./deploy/setup-smb.sh
```

Скрипт сохраняет пароль в `/etc/signage-smb.cred` (права 600) и добавляет шару в `/etc/fstab` с `nofail`, поэтому VM загружается и без SMB. Он также ставит таймер `signage-smb-remount`, который раз в минуту монтирует шару заново, если она отвалилась. В пустом каталоге точки монтирования лежит метка `.NOT-MOUNTED`: так сервер отличает несмонтированную шару от пустой. Смена адреса SMB — правка `.env` и повторный запуск `setup-smb.sh`.

**`config/config.yaml`**:

- `server.publicUrl`: адрес, по которому плееры видят сервер (`http://10.33.44.20:8080`);
- `server.sessionSecret`: случайная строка, `openssl rand -hex 32`;
- `server.allowedNetworks`: подсети учреждения; остальным сервер отвечает 403;
- `users`: логины и bcrypt-хэши паролей (см. ниже);
- `proxy.allowlist`: домены, к которым HTML-контент может обращаться через сервер.

Хэш пароля после первой сборки образа (шаг 5):

```bash
docker compose run --rm -it signage node packages/server/dist/cli/hash-password.js
```

Скрипт спросит пароль дважды и выведет строку `$2b$10$...`, вставьте её в `passwordHash`. Регистрации через интерфейс нет: пользователи заводятся только в конфиге. После правки конфига — `docker compose restart`.

## 5. Запуск

```bash
docker compose up -d --build
docker compose ps                       # STATUS: healthy
curl -s http://localhost:8080/health    # {"status":"ok","db":true,"storage":true,...}
docker compose logs -f                  # JSON-логи (pino)
```

Админка: `http://10.33.44.20:8080/admin/`. Плеер: `http://10.33.44.20:8080/player/`. Настройка экранов — `kiosk/README.md`.

Если включён ufw, откройте порт только для локальной сети:

```bash
sudo ufw allow from 10.0.0.0/8 to any port 8080 proto tcp
```

### Healthcheck `/health`

| Ответ | Что значит |
|---|---|
| `200`, `status: ok` | БД и SMB в порядке |
| `200`, `status: degraded` | SMB недоступен, работает резерв на диске VM |
| `503`, `status: down` | БД недоступна или загружать некуда (SMB недоступен, резерв выключен или диск VM заполнен) |

## 6. Когда SMB недоступен

Приоритет у SMB; если он недоступен, сервер работает с диска VM:

- **чтение:** файлы отдаются из копии медиатеки на диске VM (`storage.localMirror: true`). Сервер держит копию сам: каждый новый файл на SMB копируется на диск VM, старые докопируются при старте. Состояние копии видно в «Настройках»;
- **загрузка:** новые файлы сохраняются на диск VM; когда SMB вернётся, сервер сам перенесёт их со сверкой контрольных сумм. URL не меняются, кэш плееров не сбрасывается;
- **бэкапы БД** пишутся на диск VM и переносятся позже;
- в админке жёлтый баннер «Сетевое хранилище недоступно — сервер работает с диска сервера»;
- если на диске VM свободно меньше `storage.localMinFreeMb`, загрузка блокируется, а копия медиатеки перестаёт пополняться: часть файлов без SMB будет недоступна, об этом предупредят «Настройки».

Это работает и **при загрузке VM**: SMB монтирует хост с `nofail`, контейнер стартует всегда. Когда шара появится, таймер `signage-smb-remount` смонтирует её (до минуты), контейнер увидит её без перезапуска (`propagation: rslave`), и сервер вернётся на SMB.

Проверить состояние на VM:

```bash
mountpoint /srv/signage-smb/share
systemctl list-timers signage-smb-remount.timer
curl -s http://localhost:8080/health    # status: ok | degraded
```

Если вы раньше ставили таймер `signage-ensure.timer` из прежней версии этой инструкции, `setup-smb.sh` отключит его: он больше не нужен.

## 7. Обновление

```bash
cd /opt/signage
git pull
docker compose up -d --build
```

Миграции БД применяются автоматически при старте. Перед обновлением полезно сделать бэкап: админка → «Настройки» → «Сделать бэкап сейчас».

## 8. Бэкапы и восстановление БД

- Бэкап создаётся при каждом старте и ежедневно в `storage.backupTime` (по умолчанию 03:30), хранятся последние `storage.backupKeep` (14) копий в `storage.backupPath` на SMB (`_backup` в шаре).
- Делать, скачивать и восстанавливать бэкапы — в админке, раздел «Настройки» (только `admin`). Перед восстановлением автоматически сохраняется страховочная копия.
- Медиафайлы в бэкап не входят: они на SMB (и в копии на диске VM) и резервируются средствами файлового сервера.

**Восстановление вручную** (например, на новой VM, когда админка ещё пуста или не запускается):

```bash
cd /opt/signage
docker compose stop
# имя volume: <проект>_db, проект по умолчанию — имя папки (signage)
docker run --rm -v signage_db:/data/db -v /mnt/backup:/backup alpine \
  sh -c 'rm -f /data/db/signage.sqlite-wal /data/db/signage.sqlite-shm && cp /backup/signage-YYYYMMDD-HHMMSS.sqlite /data/db/signage.sqlite && chown 1000:1000 /data/db/signage.sqlite'
docker compose start
```

Файл бэкапа можно взять прямо с шары SMB (`_backup/`), смонтировав её в `/mnt/backup`.

## 9. Отказ узла Proxmox

**Proxmox HA** (кластер из 3 и более узлов, общее хранилище для дисков VM — Ceph, NFS, iSCSI):

1. Datacenter → HA → Add: VM signage, `state: started`, группа узлов.
2. При отказе узла VM перезапустится на другом узле. Адрес и данные сохраняются: диск VM на общем хранилище, медиа на SMB.
3. Плееры в это время играют из кэша и переподключаются автоматически (до 30 с между попытками).

**Без кластера** (один узел, диски локальные):

1. Делайте резервные копии VM средствами Proxmox (vzdump / Proxmox Backup Server) по расписанию.
2. При отказе узла восстановите VM из копии на другом узле с тем же IP.
3. Если копия VM старше последнего бэкапа БД, восстановите БД из `_backup` на SMB (раздел 8): так не потеряются изменения плейлистов и расписаний.
4. Самый быстрый путь с нуля: новая VM по разделам 1–5, затем восстановление БД из `_backup`. Медиатека уже на SMB, токены экранов хранятся в БД, плееры переподключатся сами.

## 10. Безопасность

- Доступ только из `allowedNetworks`, остальным 403. Наружу порт не публикуйте.
- Сессия админки — подписанная httpOnly-cookie с путями `/api/admin` и `/api/proxy`. После 10 неудачных входов IP и логин блокируются на 5 минут.
- Токены экранов хранятся только в виде хэшей. Удаление экрана в админке отзывает токен.
- Секретов в образе нет: всё в `.env` и `config.yaml` (права 600).
- **HTML-контент — доверенный код.** HTML и zip-пакеты выполняются в браузере с тем же адресом, что и админка (`/content/...`, `sandbox="allow-scripts allow-same-origin"`). Загружайте HTML только из надёжных источников. Полная изоляция потребовала бы отдельного порта или домена для `/content`, это возможное улучшение.
