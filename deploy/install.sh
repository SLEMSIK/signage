#!/usr/bin/env bash
# =============================================================================
#  Signage — установка «под ключ» на чистый сервер
#
#  Поддерживается: Debian 12/13, Ubuntu 22.04/24.04 (amd64, arm64).
#
#  Запуск (от root или через sudo):
#      sudo bash install.sh
#
#  Скрипт:
#    1. проверяет сеть и чинит то, что можно (источники пакетов только с cdrom, DNS);
#    2. ставит нужные пакеты, синхронизацию времени и Docker;
#    3. берёт код Signage (из папки рядом со скриптом или из Git) в /opt/signage;
#    4. спрашивает адрес сервера, сетевой диск SMB, логины и пароли;
#    5. монтирует SMB, собирает и запускает сервер, проверяет, что он работает.
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
LOG_FILE="/var/log/signage-install.log"
CONTAINER_UID=1000   # пользователь node внутри контейнера
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

# Пользователь, который запустил sudo (ему дадим права на docker)
REAL_USER="${SUDO_USER:-}"
[[ $REAL_USER == root ]] && REAL_USER=""

printf '%sSignage: установка на %s (%s)%s\n' "$C_BOLD" "${PRETTY_NAME}" "$ARCH" "$C_RESET"
info "Каталог установки: $INSTALL_DIR"
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
    /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | grep -qv 'download.docker.com'
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
   Сервер должен иметь доступ в интернет для установки. Если в учреждении прокси — сообщите его адрес
   администратору сервера; если выход закрыт — попросите сетевого администратора открыть его для $(primary_ip)."
  else
    die "Шлюз $GW не отвечает. Проверьте адрес/маску/шлюз и в Proxmox: VM → Оборудование → Сетевое устройство (мост, VLAN Tag)."
  fi
fi

# -----------------------------------------------------------------------------
step "Системные пакеты"
# -----------------------------------------------------------------------------
apt-get update -q || die "apt update не прошёл — см. сообщения выше"
PKGS=(ca-certificates curl git gnupg openssl sudo iproute2 cifs-utils smbclient tzdata)
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
step "Docker"
# -----------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker уже установлен: $(docker --version | sed 's/,.*//'), $(docker compose version --short 2>/dev/null || true)"
else
  # Пакеты Docker из репозитория ОС конфликтуют с официальными.
  for p in docker.io docker-doc docker-compose podman-docker containerd runc; do
    dpkg -s "$p" >/dev/null 2>&1 && apt-get remove -y -q "$p" || true
  done
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$OS_ID $OS_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install "${APT_OPTS[@]}" docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  ok "Установлен $(docker --version | sed 's/,.*//')"
fi
systemctl enable --now docker >/dev/null
if [[ -n $REAL_USER ]] && ! id -nG "$REAL_USER" | grep -qw docker; then
  usermod -aG docker "$REAL_USER"
  ok "Пользователь $REAL_USER добавлен в группу docker (вступит в силу после повторного входа)"
fi

# -----------------------------------------------------------------------------
step "Код Signage"
# -----------------------------------------------------------------------------
SCRIPT_DIR=""
if [[ -n ${BASH_SOURCE[0]-} && -f ${BASH_SOURCE[0]} ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
SRC_DIR=""
if [[ -n $SCRIPT_DIR && -f $SCRIPT_DIR/../docker-compose.yml && -d $SCRIPT_DIR/../packages ]]; then
  SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

if [[ -n $SRC_DIR && $SRC_DIR == "$INSTALL_DIR" ]]; then
  ok "Код уже в $INSTALL_DIR"
elif [[ -n $SRC_DIR ]]; then
  info "Копирую код из $SRC_DIR в $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  # Локальные настройки в каталоге установки не трогаем.
  tar -C "$SRC_DIR" --exclude=./node_modules --exclude='./packages/*/node_modules' --exclude='./packages/*/dist' \
      --exclude=./data --exclude=./.env --exclude=./config/config.yaml -cf - . | tar -C "$INSTALL_DIR" -xf -
  ok "Код скопирован в $INSTALL_DIR"
elif [[ -d $INSTALL_DIR/.git ]]; then
  if ask_yn "Код уже есть в $INSTALL_DIR. Обновить из Git (git pull)?" y; then
    git -C "$INSTALL_DIR" pull --ff-only || warn "git pull не удался — продолжаю с текущей версией кода"
  fi
  ok "Код в $INSTALL_DIR"
elif [[ -f $INSTALL_DIR/docker-compose.yml ]]; then
  ok "Код уже в $INSTALL_DIR"
else
  ask "Адрес Git-репозитория" "${SIGNAGE_REPO:-$REPO_URL_DEFAULT}"
  REPO_URL="$REPLY"
  info "Клонирую $REPO_URL → $INSTALL_DIR"
  info "(для закрытого репозитория git спросит логин и токен GitHub вместо пароля)"
  if ! git clone "$REPO_URL" "$INSTALL_DIR" <"${TTY:-/dev/null}"; then
    die "Не удалось скачать код из $REPO_URL.
   Варианты: сделайте репозиторий доступным (логин + токен GitHub) или скопируйте проект на сервер
   (на компьютере разработчика: git archive --format=tar.gz -o signage.tar.gz HEAD; scp signage.tar.gz user@сервер:/tmp/),
   распакуйте: mkdir -p /tmp/signage && tar -xzf /tmp/signage.tar.gz -C /tmp/signage
   и запустите: sudo bash /tmp/signage/deploy/install.sh"
  fi
  ok "Код скачан"
fi
[[ -f $INSTALL_DIR/docker-compose.yml ]] || die "В $INSTALL_DIR нет docker-compose.yml — код скопирован не полностью"
[[ -n $REAL_USER ]] && chown -R "$REAL_USER": "$INSTALL_DIR" 2>/dev/null || true
cd "$INSTALL_DIR"

# -----------------------------------------------------------------------------
step "Настройки"
# -----------------------------------------------------------------------------
ENV_FILE="$INSTALL_DIR/.env"
CONFIG_FILE="$INSTALL_DIR/config/config.yaml"

# Docker создаёт папку на месте отсутствующего файла — исправляем последствия.
[[ -d $CONFIG_FILE ]] && rmdir "$CONFIG_FILE" 2>/dev/null || true

RECONFIGURE=1
if [[ -f $ENV_FILE && -f $CONFIG_FILE ]]; then
  if ask_yn "Настройки уже есть. Оставить их без изменений?" y; then RECONFIGURE=0; fi
fi

env_get() { { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | sed -E "s/^'(.*)'$/\1/"; } || true; }

SMB_ENABLED=0
if [[ $RECONFIGURE -eq 1 ]]; then
  echo
  info "${C_BOLD}Адрес сервера${C_RESET} — по нему экраны и сотрудники будут открывать Signage."
  ask "IP-адрес сервера" "${SIGNAGE_IP:-$(primary_ip)}"; SERVER_IP="$REPLY"
  ask "Порт" "${SIGNAGE_PORT:-8080}"; PORT="$REPLY"
  [[ $PORT =~ ^[0-9]+$ ]] || die "Порт должен быть числом"
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
      ask "Домен (пусто, если учётная запись не доменная)" "${SIGNAGE_SMB_DOMAIN-}"; SMB_DOMAIN="$REPLY"
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

  # ---- .env ----
  q() { printf "'%s'" "$1"; }   # значения в одинарных кавычках: $ и пробелы не раскрываются
  {
    echo "# Записано установщиком Signage $(date '+%F %T')"
    echo "PORT=$PORT"
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
    echo "SMB_ROOT=/srv/signage-smb"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  # docker compose читает .env от имени того, кто его запускает
  [[ -n $REAL_USER ]] && chown "$REAL_USER": "$ENV_FILE"
  ok "Записан $ENV_FILE"
else
  PORT="$(env_get PORT)"; PORT="${PORT:-8080}"
  [[ -n $(env_get SMB_HOST) ]] && SMB_ENABLED=1
  ok "Оставлены прежние настройки"
fi

# -----------------------------------------------------------------------------
step "Сетевой диск"
# -----------------------------------------------------------------------------
SMB_MOUNT=/srv/signage-smb/share
if [[ $SMB_ENABLED -eq 1 ]]; then
  bash "$INSTALL_DIR/deploy/setup-smb.sh" || warn "setup-smb.sh завершился с ошибкой — Signage будет работать с диска сервера"
  if mountpoint -q "$SMB_MOUNT"; then ok "SMB смонтирован в $SMB_MOUNT"; else warn "SMB не смонтирован — таймер будет пробовать раз в минуту"; fi
else
  # Без SMB: пустая точка монтирования с меткой — сервер работает с диска VM.
  mkdir -p "$SMB_MOUNT"
  mountpoint -q "$SMB_MOUNT" || touch "$SMB_MOUNT/.NOT-MOUNTED"
  info "SMB не подключён: медиатека хранится на диске сервера"
fi

# -----------------------------------------------------------------------------
step "Сборка образа (5–15 минут при первом запуске)"
# -----------------------------------------------------------------------------
docker compose build --pull || die "Сборка образа не удалась. Частая причина — нет доступа к registry.npmjs.org или docker.io"
ok "Образ собран"

# -----------------------------------------------------------------------------
if [[ $RECONFIGURE -eq 1 ]]; then
  step "Конфиг сервера"
  hash_pw() { printf '%s' "$1" | docker run --rm -i --entrypoint node signage:latest packages/server/dist/cli/hash-password.js; }
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

  mkdir -p "$(dirname "$CONFIG_FILE")"
  cat > "$CONFIG_FILE" <<EOF
# Конфигурация Signage. Записано установщиком $(date '+%F %T').
# После правки: cd $INSTALL_DIR && docker compose restart
# Пароль пользователя: docker compose run --rm signage node packages/server/dist/cli/hash-password.js

server:
  port: 8080                        # порт внутри контейнера; внешний — PORT в .env
  publicUrl: $(yq "$PUBLIC_URL")
  timezone: $(yq "$TIMEZONE")
  sessionSecret: $(yq "$(openssl rand -hex 32)")
  allowedNetworks: [${NET_YAML}]
  trustProxy: false

users:
${USERS_YAML}
storage:
  mediaPath: /data/smb/share
  dbPath: /data/db/signage.sqlite
  backupPath: /data/smb/share/_backup
  backupTime: "03:30"
  backupKeep: 14
  localFallbackPath: /data/local-media
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
  # Читать конфиг должен пользователь node (uid 1000) внутри контейнера; остальным — нет.
  chown "root:$CONTAINER_UID" "$CONFIG_FILE"
  chmod 640 "$CONFIG_FILE"
  ok "Записан $CONFIG_FILE"
fi

# -----------------------------------------------------------------------------
step "Запуск"
# -----------------------------------------------------------------------------
docker compose up -d --remove-orphans
info "Жду, пока сервер ответит…"
HEALTH=""
for _ in $(seq 1 60); do
  HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  [[ -n $HEALTH ]] && break
  # 503 тоже ответ: сервер жив, но, например, нет ни SMB, ни места на диске
  if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q 503; then
    HEALTH="$(curl -s "http://127.0.0.1:$PORT/health")"; break
  fi
  sleep 3
done
if [[ -z $HEALTH ]]; then
  docker compose logs --tail=40 || true
  die "Сервер не ответил за 3 минуты — смотрите логи выше (docker compose logs)"
fi
case "$HEALTH" in
  *'"status":"ok"'*) ok "Сервер работает" ;;
  *'"status":"degraded"'*) ok "Сервер работает (сетевой диск недоступен — используется диск сервера)" ;;
  *) warn "Сервер отвечает, но с проблемой: $HEALTH" ;;
esac

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

  Управление (в $INSTALL_DIR):
    docker compose ps | logs -f | restart
    sudo bash deploy/install.sh     — изменить настройки или обновить

  Журнал установки: $LOG_FILE
EOF
if [[ -n $REAL_USER ]]; then
  printf '\n  %s: выйдите и войдите снова, чтобы команды docker работали без sudo.\n' "$REAL_USER"
fi
