#!/usr/bin/env bash
# =============================================================================
#  Signage — установка «под ключ» на чистый сервер (Node.js + PM2, без Docker)
#
#  Поддерживается: Debian 12/13, Ubuntu 22.04/24.04 (amd64, arm64).
#
#  Запуск (от root или через sudo):
#      sudo bash install.sh
#
#  Скрипт:
#    1. проверяет сеть и чинит то, что можно (источники пакетов только с cdrom, DNS);
#    2. ставит пакеты, синхронизацию времени, ffmpeg, Node.js 22 и PM2;
#    3. берёт код Signage (из папки рядом со скриптом или из Git) в /opt/signage и собирает его;
#    4. спрашивает адрес сервера, сетевой диск SMB, логины и пароли;
#    5. монтирует SMB, запускает сервер через PM2 (с автозапуском) и проверяет, что он работает.
#
#  Повторный запуск безопасен: уже установленное пропускается, настройки
#  можно оставить прежними. Журнал установки: /var/log/signage-install.log
#
#  Без вопросов (значения по умолчанию + переменные окружения SIGNAGE_*):
#      sudo SIGNAGE_ADMIN_PASSWORD='...' bash install.sh --yes
# =============================================================================
set -Eeuo pipefail

REPO_URL_DEFAULT="https://github.com/SLEMSIK/signage.git"
INSTALL_DIR="${SIGNAGE_DIR:-/opt/signage}"
RUN_USER="${SIGNAGE_USER:-signage}"          # системный пользователь сервиса
DATA_DIR="/var/lib/signage"                  # БД, копия медиатеки, ~/.pm2
ETC_DIR="/etc/signage"
CONFIG_FILE="$ETC_DIR/config.yaml"
ENV_FILE="$ETC_DIR/signage.env"
SMB_ROOT_DEFAULT="/srv/signage-smb"
NODE_MAJOR=22
NODE_MIN="22.12.0"
LOG_FILE="/var/log/signage-install.log"
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $arg (см. --help)" >&2; exit 1 ;;
  esac
done

# -----------------------------------------------------------------------------
# Вывод и вопросы
# -----------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\e[0m'; C_BOLD=$'\e[1m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_BLUE=$'\e[34m'
else
  C_RESET=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_BLUE=''
fi

STEP=0
step() { STEP=$((STEP + 1)); printf '\n%s== %d. %s ==%s\n' "$C_BOLD$C_BLUE" "$STEP" "$*" "$C_RESET"; }
info() { printf '   %s\n' "$*"; }
ok()   { printf '   %s✔ %s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '   %s⚠ %s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
die()  { printf '\n%s✖ %s%s\n' "$C_RED" "$*" "$C_RESET"; printf '   Журнал: %s\n' "$LOG_FILE"; exit 1; }

# Вопросы читаем с терминала, даже если скрипт пришёл через «curl | bash».
TTY=/dev/tty
have_tty() { [[ -r $TTY ]] && { : <"$TTY"; } 2>/dev/null; }

# ask "Вопрос" "по умолчанию" -> ответ в $REPLY
ask() {
  local q="$1" def="${2-}"
  if [[ $ASSUME_YES -eq 1 ]] || ! have_tty; then REPLY="$def"; return; fi
  if [[ -n $def ]]; then read -r -p "   $q [$def]: " REPLY <"$TTY" || true; else read -r -p "   $q: " REPLY <"$TTY" || true; fi
  REPLY="${REPLY:-$def}"
}

# ask_yn "Вопрос" y|n -> код возврата 0 = да
ask_yn() {
  local q="$1" def="${2:-y}" hint ans
  if [[ $ASSUME_YES -eq 1 ]] || ! have_tty; then [[ $def == y ]]; return; fi
  hint=$([[ $def == y ]] && echo "Д/н" || echo "д/Н")
  while true; do
    read -r -p "   $q [$hint]: " ans <"$TTY" || true
    ans="${ans:-$def}"
    case "${ans,,}" in
      y|yes|д|да) return 0 ;;
      n|no|н|нет) return 1 ;;
    esac
  done
}

# ask_secret "Вопрос" ПЕРЕМЕННАЯ_ОКРУЖЕНИЯ [min_len] [confirm] -> $REPLY
ask_secret() {
  local q="$1" envvar="$2" min="${3:-1}" confirm="${4:-1}" a b
  if [[ -n ${!envvar-} ]]; then REPLY="${!envvar}"; return; fi
  if [[ $ASSUME_YES -eq 1 ]] || ! have_tty; then die "Нужен ответ на «$q»: задайте переменную $envvar"; fi
  while true; do
    read -r -s -p "   $q: " a <"$TTY" || true; echo
    if [[ ${#a} -lt $min ]]; then warn "Не короче $min символов"; continue; fi
    if [[ $confirm -eq 1 ]]; then
      read -r -s -p "   Ещё раз: " b <"$TTY" || true; echo
      [[ $a == "$b" ]] || { warn "Не совпадает, попробуйте снова"; continue; }
    fi
    REPLY="$a"; return
  done
}

on_error() {
  local code=$? line=${1:-?}
  printf '\n%s✖ Ошибка (код %s) в строке %s.%s\n' "$C_RED" "$code" "$line" "$C_RESET"
  printf '   Подробности: %s\n   Скрипт можно запустить снова — сделанное повторно не выполняется.\n' "$LOG_FILE"
}
trap 'on_error $LINENO' ERR

# Команды от имени пользователя сервиса
asuser() { sudo -u "$RUN_USER" -H "$@"; }
pm2u()   { sudo -u "$RUN_USER" -H env PM2_HOME="$DATA_DIR/.pm2" pm2 "$@"; }

# -----------------------------------------------------------------------------
# 0. Предварительные проверки
# -----------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  echo "Запустите от root: sudo bash $0" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"
exec > >(tee -a "$LOG_FILE") 2>&1
printf '\n===== %s: установка Signage =====\n' "$(date '+%F %T')"

[[ -r /etc/os-release ]] || die "Не удалось определить ОС (/etc/os-release)"
# shellcheck disable=SC1091
. /etc/os-release
OS_ID="${ID:-}"
OS_CODENAME="${VERSION_CODENAME:-}"
case "$OS_ID" in
  debian|ubuntu) ;;
  *) die "Поддерживаются Debian и Ubuntu, а это: ${PRETTY_NAME:-неизвестно}" ;;
esac
[[ -n $OS_CODENAME ]] || die "Не удалось определить кодовое имя версии ОС"
ARCH="$(dpkg --print-architecture)"
case "$ARCH" in amd64|arm64) ;; *) die "Архитектура $ARCH не поддерживается (нужна amd64 или arm64)" ;; esac

# Пользователь, который запустил sudo (ему дадим права sudo, если их нет)
REAL_USER="${SUDO_USER:-}"
[[ $REAL_USER == root ]] && REAL_USER=""

printf '%sSignage: установка на %s (%s)%s\n' "$C_BOLD" "${PRETTY_NAME}" "$ARCH" "$C_RESET"
info "Код: $INSTALL_DIR · настройки: $ETC_DIR · данные: $DATA_DIR"
info "Журнал: $LOG_FILE"

export DEBIAN_FRONTEND=noninteractive
APT_OPTS=(-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

# -----------------------------------------------------------------------------
step "Источники пакетов"
# -----------------------------------------------------------------------------
# Если при установке ОС не выбрали сетевое зеркало, apt видит только cdrom.
if grep -qsE '^[[:space:]]*deb[[:space:]]+cdrom:' /etc/apt/sources.list; then
  sed -i -E 's/^([[:space:]]*deb[[:space:]]+cdrom:)/# \1/' /etc/apt/sources.list
  ok "Отключён источник cdrom (установочный диск)"
fi

has_network_source() {
  grep -rhsE '^[[:space:]]*(deb[[:space:]]|URIs:[[:space:]]).*https?://' \
    /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | grep -qvE 'nodesource|download\.docker\.com'
}

if has_network_source; then
  ok "Сетевые источники пакетов настроены"
else
  if [[ $OS_ID == debian ]]; then
    comps="main contrib non-free-firmware"
    [[ $OS_CODENAME == bullseye ]] && comps="main contrib non-free"
    cat > /etc/apt/sources.list <<EOF
# Записано установщиком Signage
deb http://deb.debian.org/debian $OS_CODENAME $comps
deb http://deb.debian.org/debian $OS_CODENAME-updates $comps
deb http://security.debian.org/debian-security $OS_CODENAME-security $comps
EOF
  else
    cat > /etc/apt/sources.list <<EOF
# Записано установщиком Signage
deb http://archive.ubuntu.com/ubuntu $OS_CODENAME main restricted universe
deb http://archive.ubuntu.com/ubuntu $OS_CODENAME-updates main restricted universe
deb http://security.ubuntu.com/ubuntu $OS_CODENAME-security main restricted universe
EOF
  fi
  ok "Прописаны сетевые источники пакетов ($OS_CODENAME)"
fi

# -----------------------------------------------------------------------------
step "Проверка сети"
# -----------------------------------------------------------------------------
CHECK_HOST=$([[ $OS_ID == debian ]] && echo deb.debian.org || echo archive.ubuntu.com)

# Все помощники, чей вывод присваивается переменным, не должны падать: при pipefail
# упавшая подстановка в присваивании оборвала бы скрипт.
default_iface() { { ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}'; } || true; }
default_gw()    { { ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="via"){print $(i+1); exit}}'; } || true; }
primary_ip()    { { ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'; } || true; }

resolves() { getent hosts "$1" >/dev/null 2>&1; }
pings()    { ping -c 1 -W 3 "$1" >/dev/null 2>&1; }

set_dns() {
  local dns="$1"
  if [[ -L /etc/resolv.conf ]] && readlink /etc/resolv.conf | grep -q systemd && command -v resolvectl >/dev/null; then
    mkdir -p /etc/systemd/resolved.conf.d
    printf '[Resolve]\nDNS=%s\n' "$dns" > /etc/systemd/resolved.conf.d/signage-dns.conf
    systemctl restart systemd-resolved
  else
    cp -a /etc/resolv.conf "/etc/resolv.conf.signage.bak" 2>/dev/null || true
    rm -f /etc/resolv.conf
    printf '# Записано установщиком Signage\nnameserver %s\n' "$dns" > /etc/resolv.conf
  fi
}

IFACE="$(default_iface)"
GW="$(default_gw)"
if [[ -z $IFACE || -z $GW ]]; then
  ip -br addr || true
  die "Нет сетевого маршрута по умолчанию: у сервера нет адреса или шлюза.
   Настройте сеть (адрес, маску, шлюз) — см. docs/install-debian.md, раздел 4.2 — и запустите скрипт снова.
   В Proxmox проверьте: VM → Оборудование → Сетевое устройство (мост, VLAN Tag)."
fi
info "Интерфейс $IFACE, адрес $(primary_ip), шлюз $GW"

if resolves "$CHECK_HOST"; then
  ok "Интернет и DNS работают"
else
  if pings 8.8.8.8 || pings 77.88.8.8; then
    warn "Интернет есть, но не работает DNS (имена не превращаются в адреса)"
    ask "DNS-сервер (DNS учреждения или публичный)" "${SIGNAGE_DNS:-8.8.8.8}"
    set_dns "$REPLY"
    sleep 1
    resolves "$CHECK_HOST" || die "DNS-сервер $REPLY не отвечает. Узнайте адрес DNS у сетевого администратора и запустите скрипт снова."
    ok "DNS исправлен: $REPLY"
  elif pings "$GW"; then
    die "Шлюз $GW доступен, но выхода в интернет нет.
   Сервер должен иметь доступ в интернет для установки. Если в учреждении прокси или выход закрыт —
   попросите сетевого администратора открыть доступ для $(primary_ip)."
  else
    die "Шлюз $GW не отвечает. Проверьте адрес/маску/шлюз и в Proxmox: VM → Оборудование → Сетевое устройство (мост, VLAN Tag)."
  fi
fi

# -----------------------------------------------------------------------------
step "Системные пакеты"
# -----------------------------------------------------------------------------
apt-get update -q || die "apt update не прошёл — см. сообщения выше"
# python3/make/g++ — на случай, если для нативного модуля нет готовой сборки
PKGS=(ca-certificates curl git gnupg openssl sudo iproute2 cifs-utils smbclient tzdata ffmpeg python3 make g++)
if ! systemctl is-active --quiet chrony 2>/dev/null && ! systemctl is-active --quiet ntp 2>/dev/null; then
  PKGS+=(systemd-timesyncd)
fi
VIRT="$(systemd-detect-virt 2>/dev/null || true)"
[[ $VIRT == kvm || $VIRT == qemu ]] && PKGS+=(qemu-guest-agent)
apt-get install "${APT_OPTS[@]}" --no-install-recommends "${PKGS[@]}"
if [[ $VIRT == kvm || $VIRT == qemu ]]; then
  systemctl enable --now qemu-guest-agent >/dev/null 2>&1 || true
fi
ok "Установлено: ${PKGS[*]}"

if [[ -n $REAL_USER ]] && ! id -nG "$REAL_USER" | grep -qw sudo; then
  usermod -aG sudo "$REAL_USER" && ok "Пользователю $REAL_USER выданы права sudo"
fi

# -----------------------------------------------------------------------------
step "Время"
# -----------------------------------------------------------------------------
TZ_DEFAULT="${SIGNAGE_TIMEZONE:-Europe/Moscow}"
timedatectl set-ntp true >/dev/null 2>&1 || warn "Не удалось включить NTP (timedatectl set-ntp true)"
if timedatectl list-timezones 2>/dev/null | grep -qx "$TZ_DEFAULT"; then
  timedatectl set-timezone "$TZ_DEFAULT" >/dev/null 2>&1 || true
fi
for _ in $(seq 1 10); do
  [[ $(timedatectl show -p NTPSynchronized --value 2>/dev/null) == yes ]] && break
  sleep 2
done
if [[ $(timedatectl show -p NTPSynchronized --value 2>/dev/null) == yes ]]; then
  ok "Часы синхронизированы: $(date '+%F %T %Z')"
else
  warn "Часы пока не синхронизированы ($(date '+%F %T %Z')). Если время неверное — расписание будет срабатывать не вовремя.
     Если в сети свой NTP-сервер: впишите NTP=<адрес> в /etc/systemd/timesyncd.conf и выполните systemctl restart systemd-timesyncd"
fi

# -----------------------------------------------------------------------------
step "Node.js $NODE_MAJOR и PM2"
# -----------------------------------------------------------------------------
node_ok() {
  local v
  v="$(node -v 2>/dev/null | sed 's/^v//' || true)"
  [[ -n $v ]] && [[ $(printf '%s\n%s\n' "$NODE_MIN" "$v" | sort -V | head -1) == "$NODE_MIN" ]] && [[ ${v%%.*} == "$NODE_MAJOR" ]]
}
if node_ok; then
  ok "Node.js уже установлен: $(node -v)"
else
  # Node.js из репозитория NodeSource: в Debian/Ubuntu штатная версия старее.
  # Пакет npm из репозитория ОС конфликтует с nodejs от NodeSource (там npm уже внутри).
  dpkg -s npm >/dev/null 2>&1 && apt-get remove -y -q npm || true
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/nodesource.asc
  chmod a+r /etc/apt/keyrings/nodesource.asc
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  cat > /etc/apt/preferences.d/nodesource <<'EOF'
# Signage: nodejs берём из NodeSource, а не из репозитория ОС
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
EOF
  apt-get update -q
  apt-get install "${APT_OPTS[@]}" nodejs
  node_ok || die "Не удалось установить Node.js $NODE_MAJOR (установлено: $(node -v 2>/dev/null || echo нет))"
  ok "Установлен Node.js $(node -v), npm $(npm -v)"
fi

if command -v pm2 >/dev/null 2>&1; then
  ok "PM2 уже установлен: $(pm2 -v 2>/dev/null | tail -1)"
else
  npm install -g pm2@7 --no-audit --no-fund --loglevel=error
  ok "Установлен PM2 $(pm2 -v 2>/dev/null | tail -1)"
fi

# Прежняя попытка установки через Docker могла занять порт.
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qE '^signage'; then
  warn "Запущен контейнер Signage от прежней установки через Docker — он займёт порт."
  if ask_yn "Остановить и удалить контейнер?" y; then
    docker ps -a --format '{{.Names}}' | grep -E '^signage' | xargs -r docker rm -f >/dev/null
    ok "Контейнер остановлен"
  fi
fi

# -----------------------------------------------------------------------------
step "Пользователь сервиса"
# -----------------------------------------------------------------------------
if id "$RUN_USER" >/dev/null 2>&1; then
  ok "Пользователь $RUN_USER уже есть"
else
  useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin --comment "Signage server" "$RUN_USER"
  ok "Создан системный пользователь $RUN_USER (без входа в систему)"
fi
install -d -m 0750 -o "$RUN_USER" -g "$RUN_USER" "$DATA_DIR" "$DATA_DIR/db" "$DATA_DIR/local-media"
install -d -m 0750 -o root -g "$RUN_USER" "$ETC_DIR"
ok "Данные: $DATA_DIR (БД, копия медиатеки)"

# -----------------------------------------------------------------------------
step "Код Signage"
# -----------------------------------------------------------------------------
SCRIPT_DIR=""
if [[ -n ${BASH_SOURCE[0]-} && -f ${BASH_SOURCE[0]} ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
SRC_DIR=""
if [[ -n $SCRIPT_DIR && -f $SCRIPT_DIR/../package.json && -d $SCRIPT_DIR/../packages/server ]]; then
  SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

if [[ -n $SRC_DIR && $SRC_DIR == "$INSTALL_DIR" ]]; then
  ok "Код уже в $INSTALL_DIR"
elif [[ -n $SRC_DIR ]]; then
  info "Копирую код из $SRC_DIR в $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  tar -C "$SRC_DIR" --exclude=./node_modules --exclude='./packages/*/node_modules' --exclude='./packages/*/dist' \
      --exclude=./data --exclude=./.env --exclude=./config/config.yaml -cf - . | tar -C "$INSTALL_DIR" -xf -
  ok "Код скопирован в $INSTALL_DIR"
elif [[ -d $INSTALL_DIR/.git ]]; then
  if ask_yn "Код уже есть в $INSTALL_DIR. Обновить из Git (git pull)?" y; then
    git -c safe.directory="$INSTALL_DIR" -C "$INSTALL_DIR" pull --ff-only || warn "git pull не удался — продолжаю с текущей версией кода"
  fi
  ok "Код в $INSTALL_DIR"
elif [[ -f $INSTALL_DIR/package.json ]]; then
  ok "Код уже в $INSTALL_DIR"
else
  ask "Адрес Git-репозитория" "${SIGNAGE_REPO:-$REPO_URL_DEFAULT}"
  REPO_URL="$REPLY"
  info "Клонирую $REPO_URL → $INSTALL_DIR"
  info "(для закрытого репозитория git спросит логин и токен GitHub вместо пароля)"
  if ! git clone "$REPO_URL" "$INSTALL_DIR" <"${TTY:-/dev/null}"; then
    die "Не удалось скачать код из $REPO_URL.
   Варианты: сделайте репозиторий доступным (логин + токен GitHub) или скопируйте проект на сервер
   (на компьютере разработчика: git archive --format=tar.gz -o signage.tar.gz HEAD; scp signage.tar.gz user@сервер:~),
   распакуйте: mkdir -p ~/signage && tar -xzf ~/signage.tar.gz -C ~/signage
   и запустите: sudo bash ~/signage/deploy/install.sh"
  fi
  ok "Код скачан"
fi
[[ -f $INSTALL_DIR/package.json && -d $INSTALL_DIR/packages/server ]] || die "В $INSTALL_DIR нет кода Signage — он скопирован не полностью"
chown -R "$RUN_USER:$RUN_USER" "$INSTALL_DIR"
cd "$INSTALL_DIR"

# -----------------------------------------------------------------------------
step "Сборка (5–10 минут при первом запуске)"
# -----------------------------------------------------------------------------
info "Устанавливаю зависимости (npm ci)…"
asuser npm ci --no-audit --no-fund --loglevel=error || die "npm ci не прошёл. Частая причина — нет доступа к registry.npmjs.org"
info "Собираю сервер, админку и плеер…"
asuser npm run build --silent || die "Сборка не удалась — см. сообщения выше"
install -m 0755 "$INSTALL_DIR/deploy/signage" /usr/local/bin/signage
ok "Собрано. Установлена команда управления: signage"

# -----------------------------------------------------------------------------
step "Настройки"
# -----------------------------------------------------------------------------
# Значения от прежней установки через Docker — как подсказки по умолчанию.
OLD_ENV="$INSTALL_DIR/.env"
env_get() {
  local f v
  for f in "$ENV_FILE" "$OLD_ENV"; do
    v="$({ grep -E "^$1=" "$f" 2>/dev/null | tail -1 | cut -d= -f2- | sed -E "s/^'(.*)'$/\1/"; } || true)"
    [[ -n $v ]] && { printf '%s' "$v"; return 0; }
  done
  return 0
}
config_port() { { awk '/^server:/{s=1;next} /^[^[:space:]#]/{s=0} s&&/^[[:space:]]+port:/{gsub(/[^0-9]/,"",$2); print $2; exit}' "$CONFIG_FILE" 2>/dev/null; } || true; }

RECONFIGURE=1
if [[ -f $ENV_FILE && -f $CONFIG_FILE ]]; then
  if ask_yn "Настройки уже есть ($ETC_DIR). Оставить их без изменений?" y; then RECONFIGURE=0; fi
fi

SMB_ENABLED=0
if [[ $RECONFIGURE -eq 1 ]]; then
  echo
  info "${C_BOLD}Адрес сервера${C_RESET} — по нему экраны и сотрудники будут открывать Signage."
  ask "IP-адрес сервера" "${SIGNAGE_IP:-$(primary_ip)}"; SERVER_IP="$REPLY"
  CUR_PORT="$(config_port)"
  ask "Порт" "${SIGNAGE_PORT:-${CUR_PORT:-8080}}"; PORT="${REPLY:-8080}"
  [[ $PORT =~ ^[0-9]+$ && $PORT -ge 1024 && $PORT -le 65535 ]] || die "Порт — число от 1024 до 65535 (сервер работает не от root)"
  PUBLIC_URL="http://$SERVER_IP:$PORT"

  echo
  info "${C_BOLD}Сети${C_RESET}, из которых разрешён доступ (остальным — 403). Через запятую."
  ask "Разрешённые сети" "${SIGNAGE_NETWORKS:-10.0.0.0/8,192.168.0.0/16,172.16.0.0/12}"; NETWORKS="$REPLY"

  ask "Часовой пояс расписания" "$TZ_DEFAULT"; TIMEZONE="$REPLY"
  timedatectl list-timezones 2>/dev/null | grep -qx "$TIMEZONE" || die "Неизвестный часовой пояс: $TIMEZONE"

  # ---- SMB ----
  echo
  info "${C_BOLD}Сетевой диск (SMB)${C_RESET} для медиатеки. Без него Signage работает с диска сервера;"
  info "подключить SMB можно позже, запустив этот скрипт снова."
  if ask_yn "Подключить сетевой диск сейчас?" y; then
    while true; do
      ask "Адрес файлового сервера" "${SIGNAGE_SMB_HOST:-$(env_get SMB_HOST)}"; SMB_HOST="$REPLY"
      ask "Имя шары" "${SIGNAGE_SMB_SHARE:-$(env_get SMB_SHARE)}"; SMB_SHARE="$REPLY"
      ask "Пользователь шары" "${SIGNAGE_SMB_USER:-$(env_get SMB_USER)}"; SMB_USER="$REPLY"
      ask_secret "Пароль шары" SIGNAGE_SMB_PASSWORD 1 0; SMB_PASSWORD="$REPLY"
      ask "Домен (пусто, если учётная запись не доменная)" "${SIGNAGE_SMB_DOMAIN-$(env_get SMB_DOMAIN)}"; SMB_DOMAIN="$REPLY"
      [[ -n $SMB_HOST && -n $SMB_SHARE && -n $SMB_USER ]] || { warn "Адрес, шара и пользователь обязательны"; continue; }
      if [[ $SMB_PASSWORD == *"'"* ]]; then warn "Пароль шары не должен содержать апостроф ('). Смените пароль на файловом сервере или введите другой."; continue; fi

      # Проверка доступа без пароля в командной строке
      AUTH="$(mktemp)"; chmod 600 "$AUTH"
      { echo "username = $SMB_USER"; echo "password = $SMB_PASSWORD"; [[ -n $SMB_DOMAIN ]] && echo "domain = $SMB_DOMAIN"; } > "$AUTH"
      SMB_VERS=""
      for v in SMB3 SMB2; do
        if smbclient "//$SMB_HOST/$SMB_SHARE" -A "$AUTH" -m "$v" -c 'ls' >/dev/null 2>&1; then
          SMB_VERS=$([[ $v == SMB3 ]] && echo 3.0 || echo 2.1); break
        fi
      done
      ERRTXT="$(smbclient "//$SMB_HOST/$SMB_SHARE" -A "$AUTH" -c 'ls' 2>&1 | tail -1 || true)"
      rm -f "$AUTH"
      if [[ -n $SMB_VERS ]]; then
        ok "Шара //$SMB_HOST/$SMB_SHARE доступна (протокол SMB $SMB_VERS)"
        SMB_ENABLED=1; break
      fi
      warn "Не удалось открыть //$SMB_HOST/$SMB_SHARE: $ERRTXT"
      if ! ask_yn "Ввести данные заново? (Нет — продолжить без SMB)" y; then break; fi
      [[ $ASSUME_YES -eq 1 ]] && break
    done
  fi

  # ---- пользователи ----
  echo
  info "${C_BOLD}Пользователи админки${C_RESET}. admin — всё; operator — контент, плейлисты, расписание."
  USERS=()   # элементы: login|role|password
  while true; do
    ask "Логин администратора" "${SIGNAGE_ADMIN_LOGIN:-admin}"; ADMIN_LOGIN="$REPLY"
    [[ $ADMIN_LOGIN =~ ^[A-Za-z0-9._-]+$ ]] && break
    warn "Только латиница, цифры, точка, дефис и подчёркивание"
  done
  ask_secret "Пароль для $ADMIN_LOGIN (не короче 8 символов)" SIGNAGE_ADMIN_PASSWORD 8 1
  USERS+=("$ADMIN_LOGIN|admin|$REPLY")
  if ask_yn "Создать пользователя-оператора?" "$([[ -n ${SIGNAGE_OPERATOR_PASSWORD-} ]] && echo y || echo n)"; then
    while true; do
      ask "Логин оператора" "${SIGNAGE_OPERATOR_LOGIN:-operator}"; OP_LOGIN="$REPLY"
      [[ $OP_LOGIN =~ ^[A-Za-z0-9._-]+$ && $OP_LOGIN != "$ADMIN_LOGIN" ]] && break
      warn "Логин должен отличаться от администратора; только латиница, цифры, . _ -"
    done
    ask_secret "Пароль для $OP_LOGIN (не короче 8 символов)" SIGNAGE_OPERATOR_PASSWORD 8 1
    USERS+=("$OP_LOGIN|operator|$REPLY")
  fi

  # ---- signage.env (параметры SMB) ----
  q() { printf "'%s'" "$1"; }   # значения в одинарных кавычках: $ и пробелы не раскрываются
  {
    echo "# Записано установщиком Signage $(date '+%F %T'). После правки: signage smb"
    if [[ $SMB_ENABLED -eq 1 ]]; then
      echo "SMB_HOST=$(q "$SMB_HOST")"
      echo "SMB_SHARE=$(q "$SMB_SHARE")"
      echo "SMB_USER=$(q "$SMB_USER")"
      echo "SMB_PASSWORD=$(q "$SMB_PASSWORD")"
      echo "SMB_DOMAIN=$(q "$SMB_DOMAIN")"
      echo "SMB_VERS=$SMB_VERS"
    else
      echo "# SMB не подключён. Чтобы подключить — запустите deploy/install.sh снова."
    fi
    echo "SMB_ROOT=$SMB_ROOT_DEFAULT"
    echo "SIGNAGE_USER=$RUN_USER"
  } > "$ENV_FILE"
  chown root:root "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "Записан $ENV_FILE"

  # ---- config.yaml ----
  hash_pw() { printf '%s' "$1" | node "$INSTALL_DIR/packages/server/dist/cli/hash-password.js"; }
  yq() { local s="${1//\\/\\\\}"; printf '"%s"' "${s//\"/\\\"}"; }   # строка в двойных кавычках YAML

  NET_YAML=""
  IFS=',' read -r -a NET_ARR <<< "$NETWORKS"
  for n in "${NET_ARR[@]}"; do
    n="$(echo "$n" | xargs)"; [[ -z $n ]] && continue
    NET_YAML+="${NET_YAML:+, }$(yq "$n")"
  done

  USERS_YAML=""
  for u in "${USERS[@]}"; do
    login="${u%%|*}"; rest="${u#*|}"; role="${rest%%|*}"; pw="${rest#*|}"
    h="$(hash_pw "$pw" || true)"
    [[ $h =~ ^\$2[aby]\$ ]] || die "Не удалось получить хэш пароля для $login"
    USERS_YAML+="  - login: $(yq "$login")"$'\n'"    role: $role"$'\n'"    passwordHash: $(yq "$h")"$'\n'
    ok "Пользователь $login ($role)"
  done

  SMB_MOUNT_PATH="$SMB_ROOT_DEFAULT/share"
  cat > "$CONFIG_FILE" <<EOF
# Конфигурация Signage. Записано установщиком $(date '+%F %T').
# Правка: signage config (откроет редактор и перезапустит сервер)
# Хэш пароля пользователя: signage hash-password

server:
  port: $PORT
  host: "0.0.0.0"
  publicUrl: $(yq "$PUBLIC_URL")
  timezone: $(yq "$TIMEZONE")
  sessionSecret: $(yq "$(openssl rand -hex 32)")
  allowedNetworks: [${NET_YAML}]
  trustProxy: false

users:
${USERS_YAML}
storage:
  mediaPath: $SMB_MOUNT_PATH
  dbPath: $DATA_DIR/db/signage.sqlite
  backupPath: $SMB_MOUNT_PATH/_backup
  backupTime: "03:30"
  backupKeep: 14
  localFallbackPath: $DATA_DIR/local-media
  localMirror: true
  localMinFreeMb: 2048
  maxUploadMb: 500
  maxUnzippedMb: 1000

proxy:
  allowlist:
    - "api.open-meteo.com"
    - "www.cbr-xml-daily.ru"
  cacheTtlSec: 300

player:
  heartbeatSec: 15
  offlineAfterSec: 45
  defaultImageDurationSec: 10
  defaultHtmlDurationSec: 30
EOF
  # Читает сервис (группа signage), меняет только root.
  chown "root:$RUN_USER" "$CONFIG_FILE"
  chmod 640 "$CONFIG_FILE"
  ok "Записан $CONFIG_FILE"
else
  PORT="$(config_port)"; PORT="${PORT:-8080}"
  [[ -n $(env_get SMB_HOST) ]] && SMB_ENABLED=1
  ok "Оставлены прежние настройки"
fi

# -----------------------------------------------------------------------------
step "Сетевой диск"
# -----------------------------------------------------------------------------
SMB_MOUNT="$SMB_ROOT_DEFAULT/share"
if [[ $SMB_ENABLED -eq 1 ]]; then
  SIGNAGE_ENV="$ENV_FILE" bash "$INSTALL_DIR/deploy/setup-smb.sh" || warn "setup-smb.sh завершился с ошибкой — Signage будет работать с диска сервера"
  if mountpoint -q "$SMB_MOUNT"; then ok "SMB смонтирован в $SMB_MOUNT"; else warn "SMB не смонтирован — таймер будет пробовать раз в минуту"; fi
else
  # Без SMB: пустая точка монтирования с меткой — сервер работает с диска VM.
  mkdir -p "$SMB_MOUNT"
  mountpoint -q "$SMB_MOUNT" || touch "$SMB_MOUNT/.NOT-MOUNTED"
  info "SMB не подключён: медиатека хранится на диске сервера ($DATA_DIR/local-media)"
fi

# -----------------------------------------------------------------------------
step "Запуск через PM2"
# -----------------------------------------------------------------------------
# Автозапуск после перезагрузки: systemd-служба pm2-<пользователь>
if ! systemctl is-enabled --quiet "pm2-$RUN_USER" 2>/dev/null; then
  env PATH="$PATH" pm2 startup systemd -u "$RUN_USER" --hp "$DATA_DIR" >/dev/null
  ok "Автозапуск: служба pm2-$RUN_USER"
fi
pm2u startOrRestart "$INSTALL_DIR/deploy/ecosystem.config.cjs" --update-env >/dev/null
pm2u save >/dev/null
ok "Процесс signage запущен"

# Ротация журналов PM2, чтобы они не съели диск
if ! pm2u jlist 2>/dev/null | grep -q '"name":"pm2-logrotate"'; then
  if pm2u install pm2-logrotate >/dev/null 2>&1; then
    pm2u set pm2-logrotate:max_size 20M >/dev/null
    pm2u set pm2-logrotate:retain 10 >/dev/null
    pm2u set pm2-logrotate:compress true >/dev/null
    pm2u save >/dev/null
    ok "Ротация журналов: pm2-logrotate (20 МБ × 10 файлов)"
  else
    warn "Не удалось поставить pm2-logrotate — журналы будут расти; поставьте позже: sudo -u $RUN_USER -H env PM2_HOME=$DATA_DIR/.pm2 pm2 install pm2-logrotate"
  fi
fi

info "Жду, пока сервер ответит…"
HEALTH=""
for _ in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  if [[ $code == 200 || $code == 503 ]]; then HEALTH="$(curl -s "http://127.0.0.1:$PORT/health" || true)"; break; fi
  sleep 3
done
if [[ -z $HEALTH ]]; then
  pm2u logs signage --lines 40 --nostream || true
  die "Сервер не ответил за 2 минуты — смотрите журнал выше (signage logs)"
fi
case "$HEALTH" in
  *'"status":"ok"'*) ok "Сервер работает" ;;
  *'"status":"degraded"'*) ok "Сервер работает (сетевой диск недоступен — используется диск сервера)" ;;
  *) warn "Сервер отвечает, но с проблемой: $HEALTH" ;;
esac

# Брандмауэр: если ufw включён — открываем порт Signage
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null && ok "ufw: открыт порт $PORT/tcp"
fi

# -----------------------------------------------------------------------------
step "Статический IP"
# -----------------------------------------------------------------------------
# Закрепляем текущий адрес, чтобы он не сменился после перезагрузки.
# Применяется при следующей загрузке — текущее соединение не обрывается.
CUR_IP="$(primary_ip)"
CUR_PREFIX="$(ip -4 -o addr show dev "$IFACE" | awk -v ip="$CUR_IP" '{split($4,a,"/"); if(a[1]==ip){print a[2]; exit}}')"
CUR_DNS="$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null || true)"
[[ $CUR_DNS == 127.0.0.53 ]] && CUR_DNS="$(resolvectl dns "$IFACE" 2>/dev/null | awk '{print $NF}' || true)"
CUR_DNS="${CUR_DNS:-$GW}"

if [[ -f /etc/network/interfaces ]] && grep -qE "^[[:space:]]*iface[[:space:]]+${IFACE}[[:space:]]+inet[[:space:]]+dhcp" /etc/network/interfaces; then
  warn "Адрес $CUR_IP получен по DHCP и может смениться после перезагрузки (экраны потеряют сервер)."
  if ask_yn "Закрепить $CUR_IP/$CUR_PREFIX (шлюз $GW, DNS $CUR_DNS) как статический?" n; then
    cp -a /etc/network/interfaces "/etc/network/interfaces.signage.bak"
    sed -i -E "s/^([[:space:]]*iface[[:space:]]+${IFACE}[[:space:]]+inet[[:space:]]+)dhcp/\1static\n    address $CUR_IP\/$CUR_PREFIX\n    gateway $GW/" /etc/network/interfaces
    if [[ ! -L /etc/resolv.conf ]]; then printf 'nameserver %s\n' "$CUR_DNS" > /etc/resolv.conf; fi
    ok "Статический адрес прописан в /etc/network/interfaces (резервная копия: interfaces.signage.bak). Вступит в силу после перезагрузки."
    info "Попросите сетевого администратора исключить $CUR_IP из пула DHCP, чтобы адрес не выдали другому устройству."
  fi
elif compgen -G "/etc/netplan/*.yaml" >/dev/null && grep -qsE 'dhcp4:[[:space:]]*(true|yes)' /etc/netplan/*.yaml; then
  warn "Адрес $CUR_IP получен по DHCP и может смениться после перезагрузки (экраны потеряют сервер)."
  if ask_yn "Закрепить $CUR_IP/$CUR_PREFIX (шлюз $GW, DNS $CUR_DNS) как статический?" n; then
    mkdir -p /etc/cloud/cloud.cfg.d
    echo 'network: {config: disabled}' > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg
    cat > /etc/netplan/99-signage-static.yaml <<EOF
# Записано установщиком Signage: статический адрес
network:
  version: 2
  ethernets:
    $IFACE:
      dhcp4: false
      addresses: [$CUR_IP/$CUR_PREFIX]
      routes:
        - to: default
          via: $GW
      nameservers:
        addresses: [$CUR_DNS]
EOF
    chmod 600 /etc/netplan/99-signage-static.yaml
    ok "Статический адрес прописан в /etc/netplan/99-signage-static.yaml. Вступит в силу после перезагрузки."
    info "Попросите сетевого администратора исключить $CUR_IP из пула DHCP."
  fi
else
  ok "Адрес $CUR_IP задан статически"
fi

# -----------------------------------------------------------------------------
# Итог
# -----------------------------------------------------------------------------
URL="$({ grep -E '^[[:space:]]*publicUrl:' "$CONFIG_FILE" 2>/dev/null | head -1 | sed -E 's/.*publicUrl:[[:space:]]*"?([^"]+)"?.*/\1/'; } || true)"
URL="${URL:-http://$(primary_ip):$PORT}"
printf '\n%s%s=================================================================%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
printf '%s%s  Signage установлен%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
printf '%s%s=================================================================%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
cat <<EOF

  Админка:   $URL/admin/
  Плеер:     $URL/player/

  Дальше:
   1. Откройте админку с компьютера в локальной сети и войдите.
   2. «Настройки» — проверьте сетевой диск, ffmpeg и время сервера.
   3. Экраны (Windows OPS) — папка kiosk, от администратора:
        powershell -ExecutionPolicy Bypass -File .\\install.ps1 -ServerUrl $URL -KioskUser signage
      Подробно: $INSTALL_DIR/kiosk/README.md

  Управление сервером:
    signage status | health | logs | restart
    signage config          — изменить настройки (/etc/signage/config.yaml)
    signage hash-password   — хэш пароля для нового пользователя
    signage update          — обновить из Git и перезапустить
    sudo bash $INSTALL_DIR/deploy/install.sh — перенастроить (адрес, SMB, пароли)

  Журнал установки: $LOG_FILE
EOF
