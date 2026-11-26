# Установка Signage на чистый Debian

Пошаговая инструкция: от пустой виртуальной машины до экрана, который показывает контент. Рассчитана на **Debian 13 (trixie)** в Proxmox; на Debian 12 (bookworm) все команды те же.

Время: около часа, из них 10–15 минут — сборка образа.

## Быстрая установка одним скриптом

Если ОС уже установлена, всё остальное делает скрипт `deploy/install.sh`. Он:

- исправляет источники пакетов (если при установке ОС не выбрали сетевое зеркало) и DNS;
- ставит пакеты, синхронизацию времени и Docker;
- копирует код в `/opt/signage`;
- спрашивает адрес сервера, сетевой диск SMB (и проверяет доступ к нему), логины и пароли;
- монтирует SMB, собирает и запускает сервер и проверяет, что он отвечает;
- предлагает закрепить текущий IP-адрес как статический.

**1. На компьютере с проектом** (Mac) упакуйте код и отправьте на сервер:

```bash
cd ~/Desktop/ScreenSystem
git archive --format=tar.gz -o /tmp/signage.tar.gz HEAD
scp /tmp/signage.tar.gz ПОЛЬЗОВАТЕЛЬ@IP-СЕРВЕРА:~
```

Если репозиторий на GitHub публичный, можно вместо этого скачать скрипт прямо на сервере (код он скачает сам):
`wget -O install.sh https://raw.githubusercontent.com/SLEMSIK/signage/main/deploy/install.sh`.

**2. На сервере** (по SSH или в консоли Proxmox):

```bash
mkdir -p ~/signage && tar -xzf ~/signage.tar.gz -C ~/signage
sudo bash ~/signage/deploy/install.sh
```

Если вы вошли как `root`, `sudo` не нужен: `bash ~/signage/deploy/install.sh`.

Ответьте на вопросы. В скобках — значение по умолчанию, Enter его принимает. Через 10–20 минут скрипт покажет адрес админки. Журнал установки — `/var/log/signage-install.log`. Запускать скрипт повторно безопасно, так же меняются настройки и подключается SMB позже.

Ниже — то же самое по шагам вручную: на случай, если скрипт остановился с ошибкой или нужно понять, что он делает.

## Содержание

1. [Что подготовить заранее](#1-что-подготовить-заранее)
2. [Виртуальная машина в Proxmox](#2-виртуальная-машина-в-proxmox)
3. [Установка Debian](#3-установка-debian)
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
| Домен локальной сети (если есть) | `school.local` | там же; если домена нет — не нужен |
| Подсети, из которых открывают админку и где стоят экраны | `10.0.0.0/8` | там же |
| Файловый сервер и шара SMB | `//10.33.44.5/signage` | раздел 6 |
| Пользователь и пароль для шары | `signage` / `…` | раздел 6 |
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
| System | Machine | q35 |
| | Qemu Agent | ✅ |
| | SCSI Controller | VirtIO SCSI single |
| Disks | Bus | SCSI, ✅ Discard, ✅ IO thread |
| | Размер | **20 ГБ + объём медиатеки** (на диске хранится её копия для работы без SMB). Например, 20 + 50 = 70 ГБ |
| CPU | Cores / Type | 2 / host |
| Memory | | 4096 МБ (минимум 2048) |
| Network | Bridge / Model | мост в локальную сеть (обычно `vmbr0`) / VirtIO |

Запустите VM и откройте **Console**.

## 3. Установка Debian

В меню загрузки выберите **Install** (текстовый установщик; Graphical install тоже подойдёт). Дальше по шагам:

| Шаг установщика | Что выбрать |
|---|---|
| Language / Location / Keyboard | по желанию (русский язык допустим; ниже названия шагов — на английском) |
| **Configure the network** | если в сети есть DHCP, установщик возьмёт адрес сам — статический настроим в разделе 4.2. Чтобы задать адрес сразу: дождитесь автонастройки → **Go Back** → **Configure network manually** и введите IP `10.33.44.20/24`, шлюз, DNS |
| **Hostname** | `signage` |
| **Domain name** | домен локальной сети, если он есть (`school.local`). **Если домена нет — оставьте пустым.** Это не IP-адрес; Signage домен не нужен |
| **Root password** | **оставьте пустым** (дважды). Тогда root будет отключён, а пользователь из следующего шага получит `sudo` |
| Full name / Username / Password | ваш администратор, например `itadmin` |
| Clock | часовой пояс — Москва |
| **Partitioning** | Guided – use entire disk → выбранный диск → **All files in one partition** → Finish partitioning → Yes |
| **Package manager** | «Scan extra installation media» — No; **Use a network mirror — Yes** → Russian Federation → `deb.debian.org`; HTTP proxy — пусто, если нет прокси. ⚠ Без зеркала apt потом не найдёт пакеты (см. [Неполадки](#15-неполадки)) |
| Popularity contest | No |
| **Software selection** | ❌ Debian desktop environment, ❌ GNOME (и любые другие рабочие столы), ✅ **SSH server**, ✅ **standard system utilities** |
| GRUB | Yes → `/dev/sda` |

После **Installation complete** VM перезагрузится. Дальше удобнее работать по SSH с вашего компьютера:

```bash
ssh itadmin@<адрес-VM>
```

> Если вы всё же задали пароль root, `sudo` не установлен. Войдите `su -` (пароль root) и выполните
> `apt install -y sudo && usermod -aG sudo itadmin`, затем выйдите из SSH и подключитесь снова.

## 4. Первичная настройка системы

### 4.1. Обновления и базовые пакеты

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y qemu-guest-agent cifs-utils smbclient curl git ca-certificates openssl systemd-timesyncd ufw nano
sudo systemctl enable --now qemu-guest-agent
```

Разбивка «All files in one partition» уже отдала системе весь диск — проверьте:

```bash
df -h /
```

### 4.2. Статический IP

Если адрес задан в установщике вручную — пропустите этот раздел (проверьте: `ip -br addr`).

В Debian сеть настраивается в `/etc/network/interfaces` (netplan нет). Узнайте имя интерфейса:

```bash
ip -br addr
```

Обычно это `ens18`. Откройте файл:

```bash
sudo nano /etc/network/interfaces
```

Замените блок интерфейса (строки с `ens18`, где написано `dhcp`) на:

```
allow-hotplug ens18
iface ens18 inet static
    address 10.33.44.20/24
    gateway 10.33.44.1
```

DNS-серверы:

```bash
echo "nameserver 10.33.44.1" | sudo tee /etc/resolv.conf
```

(для домена добавьте строку `search school.local`).

Примените — **из консоли Proxmox**, а не по SSH: соединение оборвётся при смене адреса.

```bash
sudo systemctl restart networking
ip -br addr
ping -c 2 deb.debian.org
```

Если после перезапуска сети адрес не сменился — `sudo reboot`.

### 4.3. Точное время

Расписание и синхронный показ на экранах зависят от часов сервера.

```bash
sudo timedatectl set-ntp true
timedatectl
```

Должно быть `System clock synchronized: yes` и `NTP service: active` (синхронизация может занять минуту). Если в сети учреждения свой NTP-сервер, укажите его в `/etc/systemd/timesyncd.conf` (`NTP=10.33.44.1`) и выполните `sudo systemctl restart systemd-timesyncd`.

Часовой пояс самой системы на работу Signage не влияет (расписание считается в поясе из конфига), но для удобства чтения логов:

```bash
sudo timedatectl set-timezone Europe/Moscow
```

## 5. Установка Docker

Официальный репозиторий Docker для Debian (в стандартном репозитории Debian пакет `docker.io` старее и без compose-плагина нужной версии):

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
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
| `apt install` → «Невозможно найти пакет», `apt update` ругается на `cdrom://` | При установке не выбрано сетевое зеркало. От root: `echo "deb http://deb.debian.org/debian trixie main contrib non-free-firmware" > /etc/apt/sources.list`, затем ещё две строки через `>>`: `deb http://deb.debian.org/debian trixie-updates main contrib non-free-firmware` и `deb http://security.debian.org/debian-security trixie-security main contrib non-free-firmware`; потом `apt update` |
| `sudo: command not found` / «user is not in the sudoers file» | При установке задан пароль root: `su -`, затем `apt install -y sudo && usermod -aG sudo itadmin`, перелогиньтесь |
| `mount error(13): Permission denied` | Неверный логин/пароль шары или нет прав. Для доменной учётки задайте `SMB_DOMAIN`. Проверьте права на папку и шару (раздел 6.1) |
| `mount error(95): Operation not supported` | Не та версия протокола. Попробуйте `SMB_VERS=2.1` или `2.0` в `.env` и снова `sudo ./deploy/setup-smb.sh` |
| `mount error(112): Host is down` | Сервер SMB недоступен по сети или отключён SMB2/3 |
| В «Настройках» «Сетевой диск не смонтирован (видна метка .NOT-MOUNTED)» | Шара не смонтирована. `sudo mount /srv/signage-smb/share` и посмотрите ошибку; `journalctl -u signage-smb-remount -n 20` |
| «Каталог … недоступен для записи» | Шара смонтирована, но без прав записи для пользователя `signage` на файловом сервере |
| После перезагрузки DNS не работает | `/etc/resolv.conf` перезаписан DHCP-клиентом: проверьте, что в `/etc/network/interfaces` не осталось `dhcp` для интерфейса |
| Контейнер `unhealthy` или перезапускается | `docker compose logs --tail=100`. Частое: ошибка в `config.yaml` (сервер пишет, какое поле) |
| `config.yaml` — это папка | Docker создал её, потому что файла не было: `docker compose down && rm -r config/config.yaml`, затем раздел 9 |
| «Неверный логин или пароль» | Хэш вставлен не целиком или без кавычек; после правки конфига нужен `docker compose restart` |
| «Слишком много попыток» | 10 неудачных входов — блокировка на 5 минут |
| Страница отвечает «Доступ только из локальной сети» (403) | Ваш IP не входит в `allowedNetworks` |
| Порт 8080 занят | Укажите другой `PORT` в `.env` и в `publicUrl`; `docker compose up -d` |
| Видео без превью и длительности | В «Настройках» ffmpeg «нет» — пересоберите образ: `docker compose build --no-cache && docker compose up -d` |
| Экран снова показывает код | Экран удалён в админке или профиль браузера на OPS очищен — зарегистрируйте заново |
| На экране «кэш выкл» | `-ServerUrl` при установке киоска не совпадает с адресом в браузере (см. раздел 13) |
| Расписание срабатывает не вовремя | Часы сервера (раздел 4.3) и `server.timezone` в конфиге |
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

# обновление кода (из Git; при установке архивом — распакуйте новый архив поверх)
git pull && docker compose up -d --build

# обновление Node и системных пакетов внутри образа (без изменения кода)
docker compose build --pull && docker compose up -d

# обновление Docker и системы на сервере
sudo apt update && sudo apt full-upgrade -y

# хэш пароля для config.yaml
docker compose run --rm signage node packages/server/dist/cli/hash-password.js

# сетевой диск
mountpoint /srv/signage-smb/share
sudo ./deploy/setup-smb.sh              # после смены адреса/пароля SMB в .env
systemctl list-timers signage-smb-remount.timer

curl -s http://localhost:8080/health    # ok | degraded (работа без SMB) | down
```

Дальше: обновление, бэкапы и восстановление БД, отказ узла Proxmox — в [deploy.md](deploy.md).
