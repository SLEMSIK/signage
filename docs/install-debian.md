# Установка Signage на чистый Debian

От пустой виртуальной машины до экрана, который показывает контент. Рассчитано на **Debian 13 (trixie)** в Proxmox; на Debian 12 и Ubuntu 22.04/24.04 всё то же (отличия Ubuntu — в [install-ubuntu.md](install-ubuntu.md)).

Сервер работает на **Node.js 22 под управлением PM2** (без Docker). Основной путь — скрипт `deploy/install.sh`, который делает всё сам; ручные шаги описаны на случай, если скрипт остановился или нужно понять, что он делает.

## Содержание

1. [Что подготовить заранее](#1-что-подготовить-заранее)
2. [Виртуальная машина в Proxmox](#2-виртуальная-машина-в-proxmox)
3. [Установка Debian](#3-установка-debian)
4. [Шара SMB на файловом сервере](#4-шара-smb-на-файловом-сервере)
5. [Установка Signage скриптом](#5-установка-signage-скриптом)
6. [Первый вход и проверка](#6-первый-вход-и-проверка)
7. [Экраны](#7-экраны)
8. [Управление сервером](#8-управление-сервером)
9. [Проверка отказоустойчивости](#9-проверка-отказоустойчивости)
10. [Неполадки](#10-неполадки)
11. [Ручная установка (без скрипта)](#11-ручная-установка-без-скрипта)

Как устроено на сервере:

| Что | Где |
|---|---|
| Код и сборка | `/opt/signage` (владелец — системный пользователь `signage`) |
| Настройки | `/etc/signage/config.yaml` — сервер, пользователи; `/etc/signage/signage.env` — пароль SMB |
| База данных, копия медиатеки, PM2 | `/var/lib/signage` (домашний каталог `signage`) |
| Сетевой диск | `/srv/signage-smb/share` |
| Процесс | PM2 от имени `signage`, автозапуск — служба `pm2-signage` |
| Управление | команда `signage` (`status`, `logs`, `restart`, `config`, `update`…) |

---

## 1. Что подготовить заранее

| Что | Пример | Где взять |
|---|---|---|
| IP-адрес сервера (статический) | `10.33.44.20` | у сетевого администратора |
| Маска, шлюз, DNS | `/24`, `10.33.44.1`, `10.33.44.1` | там же |
| Домен локальной сети (если есть) | `school.local` | там же; если домена нет — не нужен |
| Подсети, из которых открывают админку и где стоят экраны | `10.0.0.0/8` | там же |
| Файловый сервер и шара SMB | `//10.33.44.5/signage` | раздел 4 |
| Пользователь и пароль для шары | `signage` / `…` | раздел 4 |
| Логины сотрудников админки и их роли | `admin` (admin), `ivanova` (operator) | решите заранее |
| Интернет на сервере | нужен для установки и для погоды/курсов в HTML-виджетах | — |

Экранам интернет не нужен, только доступ к серверу по локальной сети.

## 2. Виртуальная машина в Proxmox

Скачайте образ **netinst** Debian 13 для amd64: <https://www.debian.org/distrib/netinst> (файл вида `debian-13.x.x-amd64-netinst.iso`). Загрузите его в хранилище Proxmox: **local → ISO Images → Upload**.

**Create VM**:

| Вкладка | Параметр | Значение |
|---|---|---|
| General | Name | `signage` |
| | Start at boot | ✅ (без этого после перезагрузки Proxmox сервер не поднимется) |
| OS | ISO image | debian-13.x.x-amd64-netinst.iso |
| System | Machine / Qemu Agent | q35 / ✅ |
| | SCSI Controller | VirtIO SCSI single |
| Disks | Bus | SCSI, ✅ Discard, ✅ IO thread |
| | Размер | **20 ГБ + объём медиатеки** (на диске хранится её копия для работы без SMB). Например, 20 + 50 = 70 ГБ |
| CPU | Cores / **Type** | 2 / **host** — обязательно. Тип по умолчанию (`x86-64-v2-AES`) без инструкций AVX2, и сборка падает с «Illegal instruction» |
| Memory | | 4096 МБ (минимум 2048 — сборка при установке требует памяти) |
| Network | Bridge / Model | мост в локальную сеть (обычно `vmbr0`) / VirtIO |

Запустите VM и откройте **Console**.

## 3. Установка Debian

В меню загрузки выберите **Install** (или Graphical install). По шагам:

| Шаг установщика | Что выбрать |
|---|---|
| Language / Location / Keyboard | по желанию (русский язык допустим) |
| **Configure the network** | если в сети есть DHCP, адрес возьмётся сам — потом скрипт предложит закрепить его. Чтобы сразу задать статический: дождитесь автонастройки → **Go Back** → **Configure network manually**: IP `10.33.44.20/24`, шлюз, **DNS обязательно** |
| **Hostname** | `signage` |
| **Domain name** | домен локальной сети, если он есть (`school.local`). **Если домена нет — оставьте пустым.** Это не IP-адрес |
| **Root password** | можно оставить пустым — тогда root отключён, а ваш пользователь получит `sudo`. Если задать пароль — работайте под root, скрипт сам поставит `sudo` |
| Full name / Username / Password | ваш администратор, например `itadmin` |
| Clock | часовой пояс — Москва |
| **Partitioning** | Guided – use entire disk → диск → **All files in one partition** → Finish partitioning → Yes |
| **Package manager** | «Scan extra installation media» — No; **Use a network mirror — Yes** → Russian Federation → `deb.debian.org`; HTTP proxy — пусто, если нет прокси |
| Popularity contest | No |
| **Software selection** | ❌ Debian desktop environment, ❌ GNOME (и любые рабочие столы), ✅ **SSH server**, ✅ **standard system utilities** |
| GRUB | Yes → `/dev/sda` |

Если на шаге зеркала установщик пишет «Проблема с зеркалом архива Debian» — у машины нет интернета или не работает DNS. Нажмите «Продолжить» и закончите установку без зеркала: скрипт установки сам поправит источники пакетов, проверит сеть и при необходимости спросит DNS-сервер.

После **Installation complete** VM перезагрузится. Дальше удобнее работать по SSH с вашего компьютера (`ssh itadmin@<адрес>`), чтобы вставлять команды из буфера. Узнать адрес — в консоли Proxmox: `ip -br addr`.

## 4. Шара SMB на файловом сервере

Медиатека хранится на сетевом диске. Можно пропустить и подключить позже — тогда Signage работает с диска сервера.

**Windows Server** (`10.33.44.5`):

1. Создайте локального (или доменного) пользователя `signage` с надёжным паролем, «Срок действия пароля не ограничен». Пароль без апострофа (`'`).
2. Создайте папку, например `D:\Signage`.
3. Свойства папки → **Доступ → Расширенная настройка** → ✅ Открыть общий доступ, имя `signage` → **Разрешения**: пользователю `signage` — «Изменение» и «Чтение».
4. Вкладка **Безопасность**: пользователю `signage` — «Изменение».

**NAS (Synology, QNAP и т. п.)**: общая папка `signage`, пользователь `signage` с правами чтения и записи, включён SMB 2/3.

## 5. Установка Signage скриптом

Скрипт `deploy/install.sh`:

- чинит источники пакетов (если при установке ОС не выбрали сетевое зеркало) и DNS, диагностирует сеть;
- ставит пакеты, синхронизацию времени, ffmpeg, **Node.js 22** (из репозитория NodeSource) и **PM2**;
- создаёт системного пользователя `signage`, кладёт код в `/opt/signage` и собирает его;
- спрашивает адрес сервера, сети, сетевой диск SMB (сразу проверяет доступ), логины и пароли;
- монтирует SMB, запускает сервер через PM2 с автозапуском и проверяет, что он отвечает;
- открывает порт в ufw, если брандмауэр включён; предлагает закрепить IP как статический.

### Вариант А — скачать скрипт прямо на сервере

Если репозиторий на GitHub публичный. Под root (или через `sudo`):

```bash
wget -O install.sh https://raw.githubusercontent.com/SLEMSIK/signage/main/deploy/install.sh
bash install.sh
```

Код скрипт скачает сам. Если `wget` пишет, что не может найти адрес (не работает DNS), сначала: `echo "nameserver 8.8.8.8" > /etc/resolv.conf`.

### Вариант Б — привезти проект с компьютера

На Mac, в папке проекта:

```bash
cd ~/Desktop/ScreenSystem
git archive --format=tar.gz -o /tmp/signage.tar.gz HEAD
scp /tmp/signage.tar.gz itadmin@10.33.44.20:~
```

На сервере:

```bash
mkdir -p ~/signage && tar -xzf ~/signage.tar.gz -C ~/signage
sudo bash ~/signage/deploy/install.sh
```

### Вопросы скрипта

В скобках — значение по умолчанию, Enter его принимает.

| Вопрос | Что ответить |
|---|---|
| IP-адрес сервера | подставлен текущий; по нему экраны найдут сервер |
| Порт | `8080` |
| Разрешённые сети | ваши подсети через запятую; остальным — «доступ запрещён» |
| Часовой пояс | `Europe/Moscow` |
| Подключить сетевой диск? | Да → адрес файлового сервера, имя шары, пользователь, пароль, домен (если учётка доменная). Доступ проверяется сразу |
| Логин и пароль администратора | пароль не короче 8 символов, вводится дважды |
| Создать оператора? | при необходимости — второй пользователь с ролью operator |
| Закрепить IP как статический? | Да, если адрес получен по DHCP (применится после перезагрузки) |

Первая установка — 10–20 минут (основное время — скачивание зависимостей и сборка). В конце скрипт покажет адрес админки. Журнал — `/var/log/signage-install.log`.

Повторный запуск безопасен: так же меняются адрес, SMB и пароли (на вопрос «Оставить настройки без изменений?» ответьте «Нет»).

## 6. Первый вход и проверка

На компьютере в сети учреждения откройте `http://10.33.44.20:8080/admin/` и войдите администратором.

1. **Настройки** — проверьте:
   - Сетевой диск (SMB): **доступен** (если подключали);
   - Копия медиатеки: включена;
   - ffmpeg: установлен;
   - время сервера совпадает с реальным;
   - в списке бэкапов есть `signage-…-startup.sqlite`.
2. **Медиатека** — перетащите картинку и короткое видео (mp4). У видео должно появиться превью и длительность.
3. **Плейлисты → Новый плейлист** → «Добавить из медиатеки» → **Сохранить**.
4. **Тестовый экран**: на любом компьютере откройте `http://10.33.44.20:8080/player/` — появится 6-значный код.
5. **Экраны и группы → Добавить экран** — введите код и имя («Тест»).
6. **Расписание** → «Тест» → выделите мышью интервал с текущим временем → плейлист → **Сохранить**. Через пару секунд начнётся показ.
7. **Дашборд** — экран «в сети». Попробуйте «Чёрный экран» и «Вернуть расписание».

После проверки удалите тестовый экран или оставьте как пример.

## 7. Экраны

Установка плеера на Windows OPS — в [kiosk/README.md](../kiosk/README.md). Кратко:

1. Скопируйте папку `kiosk` на OPS (флешкой или по сети).
2. Создайте локального пользователя `signage` без прав администратора.
3. От администратора: `powershell -ExecutionPolicy Bypass -File .\install.ps1 -ServerUrl http://10.33.44.20:8080 -KioskUser signage`.
4. Включите автовход (Sysinternals Autologon) и перезагрузите.
5. Введите код с экрана в админке.

Адрес в `-ServerUrl` должен в точности совпадать с `publicUrl` из конфига — иначе на экране не заработает офлайн-кэш (в админке у экрана будет «кэш выкл»).

## 8. Управление сервером

```bash
signage status            # состояние процесса (PM2)
signage health            # {"status":"ok"...} — БД и сетевой диск
signage logs              # журнал сервера (Ctrl+C — выход)
signage restart           # перезапуск
signage config            # открыть /etc/signage/config.yaml в редакторе и перезапустить
signage hash-password     # хэш пароля для нового пользователя в config.yaml
signage smb               # перемонтировать SMB (после правки /etc/signage/signage.env)
signage update            # обновить код из Git, пересобрать, перезапустить
```

Команды, которым нужны права, сами попросят `sudo`.

**Добавить пользователя или сменить пароль:** `signage hash-password` → скопируйте строку `$2b$10$...` → `signage config` → в раздел `users` добавьте:

```yaml
  - login: petrov
    role: operator
    passwordHash: "$2b$10$...строка..."
```

Сохраните (Ctrl+O, Enter, Ctrl+X) — сервер перезапустится сам.

Обновление, бэкапы и восстановление БД, отказ узла Proxmox — в [deploy.md](deploy.md).

## 9. Проверка отказоустойчивости

Рекомендуется сделать один раз после установки.

**Перезагрузка сервера:** `sudo reboot`. Через 1–2 минуты админка снова открывается (служба `pm2-signage` поднимает сервер), экраны переподключаются сами; во время перезагрузки они продолжают показ из кэша.

**Пропал сетевой диск:** `sudo umount /srv/signage-smb/share`. В течение 30 секунд в админке появится жёлтый баннер «Сетевое хранилище недоступно — сервер работает с диска сервера». Загрузите файл — он сохранится на диск сервера. В течение минуты таймер смонтирует шару обратно, баннер исчезнет, файл перенесётся на SMB.

**Сбой процесса:** `sudo pkill -9 -f packages/server/dist/index.js` — PM2 перезапустит сервер за несколько секунд.

## 10. Неполадки

| Симптом | Причина и решение |
|---|---|
| `apt install` → «Невозможно найти пакет», `apt update` ругается на `cdrom://` | При установке не выбрано сетевое зеркало. Скрипт исправляет это сам; вручную — см. раздел 11.1 |
| «Временная ошибка при разрешении deb.debian.org» | Не работает DNS. Скрипт спросит DNS-сервер; вручную: `echo "nameserver 8.8.8.8" > /etc/resolv.conf` (или DNS учреждения) |
| Скрипт: «Шлюз … не отвечает» / «выхода в интернет нет» | Сеть VM: в Proxmox проверьте мост и VLAN Tag (VM → Оборудование → Сетевое устройство); выход в интернет — у сетевого администратора |
| `sudo: command not found` | Работайте под root (`su -`) — скрипт поставит sudo сам |
| SMB: `NT_STATUS_LOGON_FAILURE` | Неверный логин/пароль шары; для доменной учётки укажите домен |
| SMB: `NT_STATUS_BAD_NETWORK_NAME` | Нет шары с таким именем |
| SMB: `NT_STATUS_ACCESS_DENIED` | Нет прав на папку/шару у пользователя (раздел 4) |
| В «Настройках» «Сетевой диск не смонтирован (видна метка .NOT-MOUNTED)» | `sudo mount /srv/signage-smb/share` и посмотрите ошибку; `journalctl -u signage-smb-remount -n 20` |
| «Каталог … недоступен для записи» | Шара смонтирована, но у пользователя шары нет права записи |
| Сборка: «Illegal instruction» | Тип процессора VM без AVX2. Proxmox: VM → Оборудование → Процессоры → Тип: **host**. Затем VM **выключить** (Shutdown/Stop, не Reboot), включить и снова запустить `bash install.sh`. Проверка: `grep -c avx2 /proc/cpuinfo` должно быть больше 0 |
| `npm ci` не прошёл | Нет доступа к registry.npmjs.org; проверьте интернет и запустите скрипт снова |
| `signage status` — статус `errored`, сервер перезапускается | `signage logs`: сервер пишет причину. Частое — ошибка в `/etc/signage/config.yaml` (сервер называет поле) |
| «Неверный логин или пароль» | Хэш вставлен не целиком или без кавычек; после правки нужен `signage restart` |
| «Слишком много попыток» | 10 неудачных входов — блокировка на 5 минут |
| «Доступ только из локальной сети» (403) | Ваш IP не входит в `allowedNetworks` |
| Порт занят (`EADDRINUSE` в журнале) | Другой сервис на порту (например, контейнер от прежней установки через Docker: `docker rm -f signage`). Или смените порт в конфиге и в `publicUrl` |
| Видео без превью и длительности | В «Настройках» ffmpeg «нет»: `sudo apt install ffmpeg && signage restart` |
| Экран снова показывает код | Экран удалён в админке или профиль браузера на OPS очищен — зарегистрируйте заново |
| На экране «кэш выкл» | `-ServerUrl` при установке киоска не совпадает с адресом в браузере |
| Расписание срабатывает не вовремя | Часы сервера: `timedatectl` должен показывать `synchronized: yes`; часовой пояс — `server.timezone` в конфиге |

Журнал установки — `/var/log/signage-install.log`; журнал сервера — `signage logs`; журнал действий пользователей — в админке, раздел **Журнал**.

## 11. Ручная установка (без скрипта)

То же, что делает `install.sh`, — по шагам. Команды выполняются под root (или с `sudo`).

### 11.1. Источники пакетов и сеть

```bash
# только если apt ругается на cdrom:
echo "deb http://deb.debian.org/debian trixie main contrib non-free-firmware" > /etc/apt/sources.list
echo "deb http://deb.debian.org/debian trixie-updates main contrib non-free-firmware" >> /etc/apt/sources.list
echo "deb http://security.debian.org/debian-security trixie-security main contrib non-free-firmware" >> /etc/apt/sources.list

ping -c 2 deb.debian.org      # если «не удаётся разрешить» — DNS:
echo "nameserver 8.8.8.8" > /etc/resolv.conf
```

Статический адрес — в `/etc/network/interfaces` (замените `ens18`, адреса — на свои; применять из консоли Proxmox):

```
allow-hotplug ens18
iface ens18 inet static
    address 10.33.44.20/24
    gateway 10.33.44.1
```

```bash
systemctl restart networking
```

### 11.2. Пакеты, время, Node.js 22, PM2

```bash
apt update
apt install -y --no-install-recommends ca-certificates curl git gnupg openssl sudo cifs-utils smbclient \
  ffmpeg python3 make g++ systemd-timesyncd qemu-guest-agent
timedatectl set-ntp true && timedatectl set-timezone Europe/Moscow

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/nodesource.asc
echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_22.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt update && apt install -y nodejs
node -v          # v22.x
npm install -g pm2@7
```

### 11.3. Пользователь, код, сборка

```bash
useradd --system --home-dir /var/lib/signage --create-home --shell /usr/sbin/nologin signage
install -d -m 0750 -o signage -g signage /var/lib/signage/db /var/lib/signage/local-media
install -d -m 0750 -o root -g signage /etc/signage

git clone https://github.com/SLEMSIK/signage.git /opt/signage   # или распакуйте архив в /opt/signage
chown -R signage:signage /opt/signage
cd /opt/signage
sudo -u signage -H npm ci
sudo -u signage -H npm run build
install -m 0755 deploy/signage /usr/local/bin/signage
```

### 11.4. Настройки

```bash
cp config/config.example.yaml /etc/signage/config.yaml
chown root:signage /etc/signage/config.yaml && chmod 640 /etc/signage/config.yaml
openssl rand -hex 32                 # → sessionSecret
signage hash-password                # → passwordHash для каждого пользователя
nano /etc/signage/config.yaml
```

Заполните `publicUrl` (`http://10.33.44.20:8080`), `sessionSecret`, `allowedNetworks`, раздел `users`. Пути в `storage` в примере уже соответствуют серверу.

Сетевой диск:

```bash
cp deploy/signage.env.example /etc/signage/signage.env
chmod 600 /etc/signage/signage.env
nano /etc/signage/signage.env        # SMB_HOST, SMB_SHARE, SMB_USER, SMB_PASSWORD, SMB_DOMAIN
bash deploy/setup-smb.sh             # монтирование, fstab с nofail, таймер перемонтирования
```

Без SMB: `mkdir -p /srv/signage-smb/share && touch /srv/signage-smb/share/.NOT-MOUNTED`.

### 11.5. Запуск через PM2

```bash
pm2 startup systemd -u signage --hp /var/lib/signage      # автозапуск: служба pm2-signage
sudo -u signage -H env PM2_HOME=/var/lib/signage/.pm2 pm2 start /opt/signage/deploy/ecosystem.config.cjs
sudo -u signage -H env PM2_HOME=/var/lib/signage/.pm2 pm2 save
sudo -u signage -H env PM2_HOME=/var/lib/signage/.pm2 pm2 install pm2-logrotate   # ротация журналов
signage health
```
