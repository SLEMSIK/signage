#!/usr/bin/env bash
# =============================================================================
#  Signage — шаг 1 из 2: подготовка (нужен интернет)
#
#  Запускается, пока сервер в сети с выходом в интернет. Скачивает и собирает
#  всё необходимое; настройки и запуск — вторым скриптом configure.sh, который
#  работает уже без интернета.
#
#  Поддерживается: Debian 12/13, Ubuntu 22.04/24.04 (amd64, arm64).
#
#      sudo bash prepare.sh
#
#  Что делает:
#    1. проверяет сеть, чинит источники пакетов (cdrom) и DNS;
#    2. ставит пакеты, ffmpeg, Node.js 22 (NodeSource) и PM2;
#    3. создаёт системного пользователя signage, кладёт код в /opt/signage и собирает его;
#    4. включает автозапуск PM2 (служба pm2-signage) и ставит ротацию журналов.
#
#  Затем: переключите сервер в рабочую сеть и запустите
#      sudo bash /opt/signage/deploy/configure.sh
#
#  Повторный запуск безопасен. Журнал: /var/log/signage-install.log
# =============================================================================
set -Eeuo pipefail

REPO_URL_DEFAULT="https://github.com/SLEMSIK/signage.git"
INSTALL_DIR="${SIGNAGE_DIR:-/opt/signage}"
RUN_USER="${SIGNAGE_USER:-signage}"          # системный пользователь сервиса
DATA_DIR="/var/lib/signage"                  # БД, копия медиатеки, ~/.pm2
ETC_DIR="/etc/signage"
NODE_MAJOR=22
NODE_MIN="22.12.0"
LOG_FILE="/var/log/signage-install.log"
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
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
printf '\n===== %s: Signage, шаг 1 — подготовка =====\n' "$(date '+%F %T')"

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

printf '%sSignage, шаг 1 из 2 — подготовка: %s (%s)%s\n' "$C_BOLD" "${PRETTY_NAME}" "$ARCH" "$C_RESET"
info "Код: $INSTALL_DIR · настройки: $ETC_DIR · данные: $DATA_DIR"
info "Журнал: $LOG_FILE"

export DEBIAN_FRONTEND=noninteractive
export NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false

# Процессор: сборщик интерфейса (Vite/rolldown) и обработка картинок используют
# инструкции AVX/AVX2. В Proxmox по умолчанию тип процессора VM — урезанный
# x86-64-v2-AES без них, и сборка падает с «Illegal instruction».
CPU_HINT="В Proxmox: VM → Оборудование (Hardware) → Процессоры (Processors) → Тип (Type): host.
     Затем ВЫКЛЮЧИТЕ VM (Shutdown/Stop, не Reboot), включите снова и запустите этот скрипт ещё раз."
if [[ $ARCH == amd64 ]] && ! grep -qw avx2 /proc/cpuinfo; then
  printf '\n%s⚠ Процессор виртуальной машины не поддерживает инструкции AVX2.%s\n' "$C_YELLOW" "$C_RESET"
  info "Сборка Signage на таком процессоре падает с ошибкой «Illegal instruction»."
  info "$CPU_HINT"
  info "(Модель процессора сейчас: $(awk -F': ' '/model name/{print $2; exit}' /proc/cpuinfo))"
  ask_yn "Продолжить всё равно?" n || die "Остановлено: смените тип процессора VM и запустите скрипт снова"
fi
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

# Нет маршрута по умолчанию (адрес есть, шлюза нет) — пробуем временно получить
# адрес и шлюз по DHCP. Файлы настроек сети не меняются.
if [[ -z $IFACE || -z $GW ]]; then
  CAND="$({ ip -o link show up 2>/dev/null | awk -F': ' '{print $2}' | sed 's/@.*//' | grep -vE '^(lo|docker[0-9]*|veth.*|br-.*|virbr.*)$' | head -1; } || true)"
  if [[ -n $CAND ]]; then
    warn "Нет маршрута в интернет (шлюза по умолчанию)."
    if ask_yn "Получить адрес и шлюз по DHCP на интерфейсе $CAND (временно, до перезагрузки)?" y; then
      if command -v dhcpcd >/dev/null 2>&1; then
        dhcpcd -4 -1 -w -t 30 "$CAND" || true
      elif command -v dhclient >/dev/null 2>&1; then
        dhclient -4 -1 -v "$CAND" || true
      else
        warn "Нет DHCP-клиента (dhcpcd или dhclient)"
      fi
      sleep 2
      IFACE="$(default_iface)"
      GW="$(default_gw)"
      [[ -n $GW ]] && ok "Получено по DHCP: $(primary_ip), шлюз $GW"
    fi
  fi
fi
if [[ -z $IFACE || -z $GW ]]; then
  ip -br addr || true
  die "Нет сетевого маршрута по умолчанию: у сервера нет адреса или шлюза.
   Для этого шага нужна сеть с интернетом. В Proxmox проверьте: VM → Оборудование → Сетевое устройство
   (мост, VLAN Tag). Если в этой сети есть DHCP — в /etc/network/interfaces для интерфейса
   должно быть «iface ens18 inet dhcp», затем: ifdown ens18; ifup ens18"
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
BUILD_LOG="$(mktemp)"
if ! asuser npm run build --silent 2>&1 | tee "$BUILD_LOG"; then
  if grep -qiE 'illegal instruction|SIGILL' "$BUILD_LOG"; then
    rm -f "$BUILD_LOG"
    die "Сборка упала с «Illegal instruction»: процессор VM не поддерживает нужные инструкции (AVX/AVX2).
     $CPU_HINT"
  fi
  rm -f "$BUILD_LOG"
  die "Сборка не удалась — см. сообщения выше"
fi
rm -f "$BUILD_LOG"
install -m 0755 "$INSTALL_DIR/deploy/signage" /usr/local/bin/signage
ok "Собрано. Установлена команда управления: signage"

# -----------------------------------------------------------------------------
step "PM2: автозапуск и ротация журналов"
# -----------------------------------------------------------------------------
# Автозапуск после перезагрузки: systemd-служба pm2-<пользователь>
if ! systemctl is-enabled --quiet "pm2-$RUN_USER" 2>/dev/null; then
  env PATH="$PATH" pm2 startup systemd -u "$RUN_USER" --hp "$DATA_DIR" >/dev/null
  ok "Автозапуск: служба pm2-$RUN_USER"
else
  ok "Автозапуск уже включён: служба pm2-$RUN_USER"
fi
# Модуль ротации ставится из интернета — делаем это сейчас, пока он есть.
if ! pm2u jlist 2>/dev/null | grep -q '"name":"pm2-logrotate"'; then
  if pm2u install pm2-logrotate >/dev/null 2>&1; then
    pm2u set pm2-logrotate:max_size 20M >/dev/null
    pm2u set pm2-logrotate:retain 10 >/dev/null
    pm2u set pm2-logrotate:compress true >/dev/null
    ok "Ротация журналов: pm2-logrotate (20 МБ × 10 файлов)"
  else
    warn "Не удалось поставить pm2-logrotate — журналы будут расти без ограничения"
  fi
else
  ok "Ротация журналов уже настроена"
fi
pm2u save >/dev/null

# -----------------------------------------------------------------------------
# Готово
# -----------------------------------------------------------------------------
printf '\n%s%s=================================================================%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
printf '%s%s  Шаг 1 из 2 готов: всё скачано и собрано%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
printf '%s%s=================================================================%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
cat <<EOF

  Дальше:
   1. Переключите сервер в рабочую сеть (в Proxmox: VM → Оборудование → Сетевое
      устройство → мост рабочей сети; применяется сразу). Интернет больше не нужен.
   2. Из консоли Proxmox (не по SSH — адрес сменится) запустите:

        sudo bash $INSTALL_DIR/deploy/configure.sh

      Он задаст адрес, сетевой диск, пароли и запустит сервер.

  Журнал: $LOG_FILE
EOF
