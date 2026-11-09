# Установка Signage на чистую Ubuntu

Пошаговая инструкция: от пустой виртуальной машины до экрана, который показывает контент. Рассчитана на Ubuntu Server 24.04 LTS в Proxmox, но подойдёт любая VM или физический сервер с Ubuntu 22.04/24.04.

Время: около часа, из них 10–15 минут — сборка образа.

## Содержание

1. [Что подготовить заранее](#1-что-подготовить-заранее)
2. [Виртуальная машина в Proxmox](#2-виртуальная-машина-в-proxmox)
3. [Установка Ubuntu](#3-установка-ubuntu)
4. [Первичная настройка системы](#4-первичная-настройка-системы)
5. [Установка Docker](#5-установка-docker)
6. [Сетевой диск SMB](#6-сетевой-диск-smb)
7. [Код Signage на сервере](#7-код-signage-на-сервере)
8. [Файл .env и монтирование SMB](#8-файл-env-и-монтирование-smb)
9. [Конфиг config.yaml и пользователи](#9-конфиг-configyaml-и-пользователи)
10. [Сборка и запуск](#10-сборка-и-запуск)
11. [Брандмауэр](#11-брандмауэр)
12. [Первый вход и проверка](#12-первый-вход-и-проверка)
13. [Экраны](#13-экраны)
14. [Проверка отказоустойчивости](#14-проверка-отказоустойчивости)
15. [Неполадки](#15-неполадки)
16. [Шпаргалка](#16-шпаргалка)

---

## 1. Что подготовить заранее

| Что | Пример | Где взять |
|---|---|---|
| IP-адрес сервера (статический) | `10.33.44.20` | у сетевого администратора |
| Маска, шлюз, DNS | `/24`, `10.33.44.1`, `10.33.44.1` | там же |
| Подсети, из которых открывают админку и где стоят экраны | `10.0.0.0/8` | там же |
| Файловый сервер и шара SMB | `//10.33.44.5/signage` | раздел 6 |
| Пользователь и пароль для шары | `signage` / `…` | раздел 6 |
| Логины сотрудников админки и их роли | `admin` (admin), `ivanova` (operator) | решите заранее |
| Интернет на сервере | нужен для установки и для погоды/курсов в HTML-виджетах | — |

Экранам интернет не нужен, только доступ к серверу по локальной сети.

## 2. Виртуальная машина в Proxmox

Скачайте ISO Ubuntu Server 24.04 LTS (<https://ubuntu.com/download/server>) и загрузите его в хранилище Proxmox: **local → ISO Images → Upload**.

**Create VM**:

| Вкладка | Параметр | Значение |
|---|---|---|
| General | Name | `signage` |
| | Start at boot | ✅ (без этого после перезагрузки Proxmox сервер не поднимется) |
| OS | ISO image | ubuntu-24.04-live-server-amd64.iso |
| System | Machine | q35 |
| | Qemu Agent | ✅ |
| | SCSI Controller | VirtIO SCSI single |
| Disks | Bus | SCSI, ✅ Discard, ✅ IO thread |
| | Размер | **20 ГБ + объём медиатеки** (на диске хранится её копия для работы без SMB). Например, 20 + 50 = 70 ГБ |
| CPU | Cores / Type | 2 / host |
| Memory | | 4096 МБ (минимум 2048) |
| Network | Bridge / Model | мост в локальную сеть (обычно `vmbr0`) / VirtIO |

Запустите VM и откройте **Console**.

## 3. Установка Ubuntu

В установщике:

1. Язык — English (сообщения проще гуглить), раскладка — по желанию.
2. **Type of install**: Ubuntu Server (не minimized).
3. **Network**: можно оставить DHCP, статический адрес настроим в разделе 4. Или сразу задайте: **Edit IPv4 → Manual**.
4. **Storage**: Use an entire disk, LVM — по умолчанию. ⚠ Установщик отдаёт под систему только половину диска, это исправим в разделе 4.
5. **Profile**: имя сервера `signage`, ваш пользователь (например, `itadmin`) и пароль.
6. **SSH**: ✅ Install OpenSSH server.
7. **Featured snaps**: ничего не выбирайте (Docker поставим из официального репозитория, не из snap).

После установки — **Reboot Now**, извлеките ISO, если попросит. Дальше удобнее работать по SSH с вашего компьютера:

```bash
ssh itadmin@<адрес-VM>
```

## 4. Первичная настройка системы

### 4.1. Обновления и базовые пакеты

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y qemu-guest-agent cifs-utils smbclient curl git ca-certificates openssl
sudo systemctl enable --now qemu-guest-agent
```

### 4.2. Весь диск под систему

```bash
sudo lvextend -l +100%FREE -r /dev/ubuntu-vg/ubuntu-lv
df -h /
```

`df` должен показать почти весь размер диска.

### 4.3. Статический IP

Узнайте имя сетевого интерфейса:

```bash
ip -br addr
```

Обычно это `ens18`. Запретите cloud-init перезаписывать сетевые настройки и задайте адрес:

```bash
echo 'network: {config: disabled}' | sudo tee /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg
sudo nano /etc/netplan/50-cloud-init.yaml
```

Содержимое (замените адреса на свои; отступы — пробелами):

```yaml
network:
  version: 2
  ethernets:
    ens18:
      dhcp4: false
      addresses: [10.33.44.20/24]
      routes:
        - to: default
          via: 10.33.44.1
      nameservers:
        addresses: [10.33.44.1]
```

```bash
sudo chmod 600 /etc/netplan/50-cloud-init.yaml
sudo netplan try      # если связь не пропала — нажмите Enter для подтверждения
```

Если вы подключены по SSH к старому адресу, переподключитесь к новому.

### 4.4. Точное время

Расписание и синхронный показ на экранах зависят от часов сервера.

```bash
timedatectl
```

Должно быть `System clock synchronized: yes` и `NTP service: active`. Если нет:

```bash
sudo timedatectl set-ntp true
```

Если в сети учреждения свой NTP-сервер, укажите его в `/etc/systemd/timesyncd.conf` (`NTP=10.33.44.1`) и выполните `sudo systemctl restart systemd-timesyncd`.

Часовой пояс самой VM можно не менять: Signage считает расписание в поясе из своего конфига (`Europe/Moscow`). Для удобства чтения логов:

```bash
sudo timedatectl set-timezone Europe/Moscow
```

## 5. Установка Docker

Официальный репозиторий Docker (в стандартном репозитории Ubuntu версии старее):

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Чтобы не писать `sudo` перед каждой командой docker:

```bash
sudo usermod -aG docker $USER
exit
```

Подключитесь по SSH заново и проверьте:

```bash
docker run --rm hello-world
docker compose version
```

Docker уже запускается вместе с системой (`systemctl is-enabled docker` → `enabled`).

## 6. Сетевой диск SMB

### 6.1. Шара на файловом сервере

**Windows Server** (`10.33.44.5`):

1. Создайте локального (или доменного) пользователя `signage` с надёжным паролем, «Срок действия пароля не ограничен».
2. Создайте папку, например `D:\Signage`.
3. Свойства папки → **Доступ → Расширенная настройка** → ✅ Открыть общий доступ, имя `signage` → **Разрешения**: пользователю `signage` — «Изменение» и «Чтение».
4. Вкладка **Безопасность**: пользователю `signage` — «Изменение».

**NAS (Synology, QNAP и т. п.)**: создайте общую папку `signage`, пользователя `signage` с правами чтения и записи на неё и включите SMB 2/3.

### 6.2. Проверка с сервера Signage

```bash
smbclient -L //10.33.44.5 -U signage          # в списке должна быть шара signage
sudo mkdir -p /mnt/test
sudo mount -t cifs //10.33.44.5/signage /mnt/test -o username=signage,vers=3.0
sudo touch /mnt/test/проверка.txt && ls -la /mnt/test && sudo rm /mnt/test/проверка.txt
sudo umount /mnt/test
```

Пароль спросят при каждой команде. Если монтирование не прошло — см. [Неполадки](#15-неполадки) (`vers=2.1`, домен, права).

## 7. Код Signage на сервере

Каталог установки — `/opt/signage`:

```bash
sudo mkdir -p /opt/signage
sudo chown $USER:$USER /opt/signage
```

**Вариант А — из Git** (когда репозиторий опубликован):

```bash
git clone <адрес-репозитория> /opt/signage
```

**Вариант Б — архивом с компьютера разработчика** (пока репозитория нет). На Mac, в папке проекта:

```bash
cd ~/Desktop/ScreenSystem
git archive --format=tar.gz -o /tmp/signage.tar.gz HEAD
scp /tmp/signage.tar.gz itadmin@10.33.44.20:/tmp/
```

На сервере:

```bash
tar -xzf /tmp/signage.tar.gz -C /opt/signage
ls /opt/signage     # CLAUDE.md, Dockerfile, docker-compose.yml, packages, deploy, docs, kiosk...
```

В архив попадают только файлы из Git — локальные `config.yaml`, `.env` и тестовые данные разработчика не переносятся.

## 8. Файл .env и монтирование SMB

```bash
cd /opt/signage
cp .env.example .env
chmod 600 .env
nano .env
```

```ini
PORT=8080
SMB_HOST=10.33.44.5
SMB_SHARE=signage
SMB_USER=signage
SMB_PASSWORD=пароль-от-шары
SMB_DOMAIN=            # для доменной учётки: имя домена, иначе пусто
SMB_VERS=3.0
SMB_ROOT=/srv/signage-smb
```

Монтирование шары на сервере:

```bash
sudo ./deploy/setup-smb.sh
```

Скрипт:

- сохраняет логин и пароль шары в `/etc/signage-smb.cred` (доступ только root);
- добавляет шару в `/etc/fstab` с опцией `nofail` — сервер загрузится и без SMB;
- создаёт метку `.NOT-MOUNTED` в пустом каталоге `/srv/signage-smb/share` — по ней Signage понимает, что шара не смонтирована;
- ставит таймер `signage-smb-remount`: раз в минуту монтирует шару, если она отвалилась;
- сразу монтирует шару.

Проверка:

```bash
mountpoint /srv/signage-smb/share            # "... is a mountpoint"
ls -la /srv/signage-smb/share                # содержимое шары, БЕЗ файла .NOT-MOUNTED
systemctl list-timers signage-smb-remount.timer
```

## 9. Конфиг config.yaml и пользователи

⚠ Создайте `config.yaml` **до** любых команд `docker compose`: если файла нет, Docker создаст на его месте пустую папку, и сервер не запустится (лечится `rm -r config/config.yaml` и созданием файла).

```bash
cd /opt/signage
cp config/config.example.yaml config/config.yaml
chmod 600 config/config.yaml
openssl rand -hex 32          # скопируйте результат — это sessionSecret
nano config/config.yaml
```

Что заполнить:

```yaml
server:
  port: 8080                              # порт внутри контейнера, не меняйте
  publicUrl: "http://10.33.44.20:8080"    # адрес, по которому экраны видят сервер
  timezone: "Europe/Moscow"
  sessionSecret: "вставьте-результат-openssl"
  allowedNetworks: ["10.0.0.0/8", "192.168.0.0/16", "172.16.0.0/12"]   # только ваши подсети
```

Остальные разделы (`storage`, `proxy`, `player`) для начала можно оставить как в примере. Пути `storage` уже соответствуют `docker-compose.yml` — не меняйте их.

### Пользователи и пароли

Пользователи задаются только здесь, регистрации через интерфейс нет. Роли:

- `admin` — всё, включая регистрацию экранов, группы, бэкапы;
- `operator` — медиа, плейлисты, расписание, ручные переключения, просмотр журнала.

Пароль хранится в виде bcrypt-хэша. Чтобы получить хэш, соберите образ (первая сборка 5–15 минут) и запустите утилиту:

```bash
cd /opt/signage
docker compose build
docker compose run --rm signage node packages/server/dist/cli/hash-password.js
```

Утилита дважды спросит пароль (не короче 8 символов) и напечатает строку вида `$2b$10$...`. Повторите для каждого пользователя и впишите в конфиг:

```yaml
users:
  - login: admin
    role: admin
    passwordHash: "$2b$10$...хэш-1..."
  - login: ivanova
    role: operator
    passwordHash: "$2b$10$...хэш-2..."
```

Хэш — в двойных кавычках, целиком. Строки-заглушки `REPLACE_ME` из примера замените или удалите: с ними войти нельзя.

## 10. Сборка и запуск

```bash
cd /opt/signage
docker compose up -d
docker compose ps
```

Через 20–30 секунд в колонке STATUS должно быть `Up ... (healthy)`.

```bash
curl -s http://localhost:8080/health
```

```json
{"status":"ok","db":true,"storage":true,"storageError":null,"localFallback":true,"localPending":0,"version":"1.0.0"}
```

Логи (JSON, по строке на событие):

```bash
docker compose logs -f --tail=50
```

Если в логах `Ошибка в конфиге:` — сервер перечислит, какие поля неверны. Исправьте `config/config.yaml` и выполните `docker compose restart`.

Контейнер запускается автоматически после перезагрузки VM (`restart: unless-stopped`).

## 11. Брандмауэр

```bash
sudo ufw allow OpenSSH
sudo ufw enable
sudo ufw status
```

⚠ **Docker публикует порты в обход правил ufw**, поэтому `ufw allow/deny 8080` на доступ к Signage не влияет. Доступ к Signage ограничивает сам сервер — параметр `allowedNetworks` (остальным — ответ 403). Наружу (в интернет) порт 8080 не пробрасывайте.

Если сервер стоит в сети с внешним доступом и нужна защита на уровне сети — ограничьте доступ на сетевом оборудовании или опубликуйте порт только на внутреннем адресе: в `docker-compose.yml` замените `"${PORT:-8080}:8080"` на `"10.33.44.20:${PORT:-8080}:8080"`.

## 12. Первый вход и проверка

На любом компьютере в сети учреждения откройте `http://10.33.44.20:8080/admin/` и войдите пользователем с ролью `admin`.

1. **Настройки** — проверьте:
   - Сетевой диск (SMB): **доступен**;
   - Копия медиатеки: включена;
   - ffmpeg: установлен;
   - время сервера совпадает с реальным;
   - в списке бэкапов есть `signage-…-startup.sqlite`.
2. **Медиатека** — перетащите картинку и короткое видео (mp4). У видео должно появиться превью и длительность.
3. **Плейлисты → Новый плейлист** → «Добавить из медиатеки» → **Сохранить**.
4. **Тестовый экран**: на любом компьютере откройте в браузере `http://10.33.44.20:8080/player/` — появится 6-значный код.
5. **Экраны и группы → Добавить экран** — введите код и имя («Тест»). На странице плеера код сменится чёрным экраном.
6. **Расписание** → выберите «Тест» → выделите мышью интервал, включающий текущее время, → выберите плейлист → **Сохранить**. Через пару секунд плеер начнёт показ.
7. **Дашборд** — экран «в сети», видно, что играет и когда смена. Попробуйте «Чёрный экран» и «Вернуть расписание».

После проверки удалите тестовый экран (**Экраны и группы → Удалить**) или оставьте как пример.

## 13. Экраны

Установка плеера на Windows OPS — в [kiosk/README.md](../kiosk/README.md). Кратко:

1. Скопируйте папку `kiosk` на OPS (флешкой или по сети).
2. Создайте локального пользователя `signage` без прав администратора.
3. От администратора: `powershell -ExecutionPolicy Bypass -File .\install.ps1 -ServerUrl http://10.33.44.20:8080 -KioskUser signage`.
4. Включите автовход (Sysinternals Autologon) и перезагрузите.
5. Введите код с экрана в админке.

Адрес в `-ServerUrl` должен в точности совпадать с `publicUrl` из конфига — иначе на экране не заработает офлайн-кэш (в админке у экрана будет «кэш выкл»).

## 14. Проверка отказоустойчивости

Рекомендуется сделать один раз после установки.

**Перезагрузка сервера.**

```bash
sudo reboot
```

Через 1–2 минуты админка снова открывается, экраны переподключаются сами (на экране во время перезагрузки продолжается показ из кэша, в углу — красная точка).

**Пропал сетевой диск.** Отмонтируйте шару:

```bash
sudo umount /srv/signage-smb/share
```

В течение 30 секунд в админке появится жёлтый баннер «Сетевое хранилище недоступно — сервер работает с диска сервера». Загрузите файл — он сохранится на диск VM. В течение минуты таймер смонтирует шару обратно, баннер исчезнет, файл перенесётся на SMB (в «Настройках» «Ждут переноса» станет 0).

**SMB недоступен при загрузке сервера.** Выключите шару (или заблокируйте файловый сервер) и перезагрузите VM: контейнер всё равно стартует, админка работает с диска VM. Когда шара станет доступна, она смонтируется в течение минуты.

## 15. Неполадки

| Симптом | Причина и решение |
|---|---|
| `mount error(13): Permission denied` | Неверный логин/пароль шары или нет прав. Для доменной учётки задайте `SMB_DOMAIN`. Проверьте права на папку и шару (раздел 6.1) |
| `mount error(95): Operation not supported` | Не та версия протокола. Попробуйте `SMB_VERS=2.1` или `2.0` в `.env` и снова `sudo ./deploy/setup-smb.sh` |
| `mount error(112): Host is down` | Сервер SMB недоступен по сети или отключён SMB2/3 |
| В «Настройках» «Сетевой диск не смонтирован (видна метка .NOT-MOUNTED)» | Шара не смонтирована. `sudo mount /srv/signage-smb/share` и посмотрите ошибку; `journalctl -u signage-smb-remount -n 20` |
| «Каталог … недоступен для записи» | Шара смонтирована, но без прав записи для пользователя `signage` на файловом сервере |
| Контейнер `unhealthy` или перезапускается | `docker compose logs --tail=100`. Частое: ошибка в `config.yaml` (сервер пишет, какое поле) |
| `config.yaml` — это папка | Docker создал её, потому что файла не было: `docker compose down && rm -r config/config.yaml`, затем раздел 9 |
| «Неверный логин или пароль» | Хэш вставлен не целиком или без кавычек; после правки конфига нужен `docker compose restart` |
| «Слишком много попыток» | 10 неудачных входов — блокировка на 5 минут |
| Страница отвечает «Доступ только из локальной сети» (403) | Ваш IP не входит в `allowedNetworks` |
| Порт 8080 занят | Укажите другой `PORT` в `.env` и в `publicUrl`; `docker compose up -d` |
| Видео без превью и длительности | В «Настройках» ffmpeg «нет» — пересоберите образ: `docker compose build --no-cache && docker compose up -d` |
| Экран снова показывает код | Экран удалён в админке или профиль браузера на OPS очищен — зарегистрируйте заново |
| На экране «кэш выкл» | `-ServerUrl` при установке киоска не совпадает с адресом в браузере (см. раздел 13) |
| Расписание срабатывает не вовремя | Часы сервера (раздел 4.4) и `server.timezone` в конфиге |
| Сборка образа падает на `npm ci` | Нет доступа в интернет с сервера или к registry.npmjs.org; проверьте прокси/DNS |

Подробный журнал сервера: `docker compose logs -f`. Журнал действий пользователей — в админке, раздел **Журнал**.

## 16. Шпаргалка

```bash
cd /opt/signage

docker compose ps                       # состояние
docker compose logs -f --tail=100       # логи
docker compose restart                  # перезапуск (после правки config.yaml)
docker compose down                     # остановить
docker compose up -d                    # запустить

# обновление (из Git; при установке архивом — распакуйте новый архив поверх)
git pull && docker compose up -d --build

# хэш пароля для config.yaml
docker compose run --rm signage node packages/server/dist/cli/hash-password.js

# сетевой диск
mountpoint /srv/signage-smb/share
sudo ./deploy/setup-smb.sh              # после смены адреса/пароля SMB в .env
systemctl list-timers signage-smb-remount.timer

curl -s http://localhost:8080/health    # ok | degraded (работа без SMB) | down
```

Дальше: обновление, бэкапы и восстановление БД, отказ узла Proxmox — в [deploy.md](deploy.md).
