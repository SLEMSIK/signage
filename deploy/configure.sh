#!/usr/bin/env bash
# =============================================================================
#  Signage — шаг 2 из 2: настройка и запуск (интернет НЕ нужен)
#
#  Запускается после prepare.sh, когда сервер уже в рабочей сети. В интернет
#  не обращается.
#
#      sudo bash /opt/signage/deploy/configure.sh
#
#  Что делает:
#    1. задаёт сети статический адрес (по умолчанию 10.33.44.20/24, шлюз 10.33.44.1,
#       DNS 10.33.44.5) и источник точного времени в локальной сети;
#    2. спрашивает адрес для экранов, сети доступа, сетевой диск SMB, логины и пароли;
#    3. монтирует SMB, запускает сервер через PM2 и проверяет, что он отвечает.
#
#  Запускайте из консоли Proxmox: если вы подключены по SSH к старому адресу,
#  соединение оборвётся при смене адреса.
#
#  Повторный запуск безопасен (можно поменять только пароли или SMB, а сеть оставить).
#  Параметры: --skip-network — не трогать настройки сети.
#  Журнал: /var/log/signage-install.log
# =============================================================================
set -Eeuo pipefail

INSTALL_DIR="${SIGNAGE_DIR:-/opt/signage}"
RUN_USER="${SIGNAGE_USER:-signage}"          # системный пользователь сервиса
DATA_DIR="/var/lib/signage"                  # БД, копия медиатеки, ~/.pm2
ETC_DIR="/etc/signage"
CONFIG_FILE="$ETC_DIR/config.yaml"
ENV_FILE="$ETC_DIR/signage.env"
SMB_ROOT_DEFAULT="/srv/signage-smb"
LOG_FILE="/var/log/signage-install.log"
ASSUME_YES=0
SKIP_NETWORK=0

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --skip-network) SKIP_NETWORK=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
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
printf '\n===== %s: Signage, шаг 2 — настройка =====\n' "$(date '+%F %T')"

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

printf '%sSignage, шаг 2 из 2 — настройка и запуск: %s (%s)%s\n' "$C_BOLD" "${PRETTY_NAME}" "$ARCH" "$C_RESET"
info "Код: $INSTALL_DIR · настройки: $ETC_DIR · данные: $DATA_DIR"
info "Журнал: $LOG_FILE"

export DEBIAN_FRONTEND=noninteractive
export NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false


# -----------------------------------------------------------------------------
step "Проверка подготовки"
# -----------------------------------------------------------------------------
[[ -f $INSTALL_DIR/packages/server/dist/index.js && -f $INSTALL_DIR/packages/admin/dist/index.html ]] \
  || die "Сервер не собран: сначала запустите шаг 1 (prepare.sh) в сети с интернетом"
id "$RUN_USER" >/dev/null 2>&1 || die "Нет пользователя $RUN_USER — сначала запустите шаг 1 (prepare.sh)"
command -v node >/dev/null && command -v pm2 >/dev/null || die "Нет Node.js или PM2 — сначала запустите шаг 1 (prepare.sh)"
install -m 0755 "$INSTALL_DIR/deploy/signage" /usr/local/bin/signage
install -d -m 0750 -o "$RUN_USER" -g "$RUN_USER" "$DATA_DIR" "$DATA_DIR/db" "$DATA_DIR/local-media"
install -d -m 0750 -o root -g "$RUN_USER" "$ETC_DIR"
ok "Node.js $(node -v), PM2 $(pm2 -v 2>/dev/null | tail -1), сборка на месте"
TZ_DEFAULT="${SIGNAGE_TIMEZONE:-Europe/Moscow}"

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

# -----------------------------------------------------------------------------
step "Сеть"
# -----------------------------------------------------------------------------
list_ifaces() { ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | sed 's/@.*//' | grep -vE '^(lo|docker[0-9]*|veth.*|br-.*|virbr.*)$' || true; }
iface_ipv4() { { ip -4 -o addr show dev "$1" 2>/dev/null | awk '{print $4; exit}'; } || true; }

# Записывает статический адрес для интерфейса (Debian: /etc/network/interfaces, Ubuntu: netplan)
write_static() {
  local iface="$1" cidr="$2" gw="$3" dns="$4"
  if [[ -f /etc/network/interfaces ]] && ! compgen -G "/etc/netplan/*.yaml" >/dev/null; then
    cp -a /etc/network/interfaces "/etc/network/interfaces.signage.$(date +%Y%m%d%H%M%S).bak"
    # Убираем прежние строки этого интерфейса (auto/allow-hotplug и блок iface…)
    awk -v ifc="$iface" '
      /^# Signage: статический адрес/ { next }
      $1=="auto" || $1 ~ /^allow-/ { keep=""; for (i=2;i<=NF;i++) if ($i!=ifc) keep=keep" "$i; if (keep=="") next; print $1 keep; skip=0; next }
      $1=="iface" { skip=($2==ifc) }
      $1=="source" || $1=="mapping" { skip=0 }
      !skip { print }
    ' /etc/network/interfaces > /etc/network/interfaces.new
    cat >> /etc/network/interfaces.new <<EOF

# Signage: статический адрес (записано configure.sh)
auto $iface
iface $iface inet static
    address $cidr
    gateway $gw
EOF
    cat -s /etc/network/interfaces.new > /etc/network/interfaces   # без лишних пустых строк
    rm -f /etc/network/interfaces.new
    NET_BACKEND=ifupdown
  else
    mkdir -p /etc/cloud/cloud.cfg.d
    echo 'network: {config: disabled}' > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg
    rm -f /etc/netplan/99-signage-static.yaml
    cat > /etc/netplan/99-signage.yaml <<EOF
# Signage: статический адрес (записано configure.sh)
network:
  version: 2
  ethernets:
    $iface:
      dhcp4: false
      dhcp6: false
      addresses: [$cidr]
      routes:
        - to: default
          via: $gw
      nameservers:
        addresses: [$dns]
EOF
    chmod 600 /etc/netplan/99-signage.yaml
    NET_BACKEND=netplan
  fi
}

# DNS: на Debian без resolvconf — /etc/resolv.conf; с systemd-resolved — drop-in
write_dns() {
  local dns="$1"
  if [[ -L /etc/resolv.conf ]] && readlink /etc/resolv.conf | grep -q systemd; then
    mkdir -p /etc/systemd/resolved.conf.d
    printf '[Resolve]\nDNS=%s\n' "$dns" > /etc/systemd/resolved.conf.d/signage-dns.conf
  else
    rm -f /etc/resolv.conf
    printf '# Записано configure.sh (Signage)\nnameserver %s\n' "$dns" > /etc/resolv.conf
  fi
}

apply_network() {
  local iface="$1"
  if [[ $NET_BACKEND == netplan ]]; then
    netplan apply
  else
    ip addr flush dev "$iface" || true
    ip route flush dev "$iface" 2>/dev/null || true
    ifdown --force "$iface" >/dev/null 2>&1 || true
    ifup "$iface" || systemctl restart networking
  fi
  if [[ -L /etc/resolv.conf ]] && readlink /etc/resolv.conf | grep -q systemd; then
    systemctl restart systemd-resolved || true
  fi
}

NET_IP=""
if [[ $SKIP_NETWORK -eq 1 ]]; then
  info "Сеть не меняется (--skip-network)"
else
  echo
  info "${C_BOLD}Сетевые интерфейсы сейчас:${C_RESET}"
  ip -br addr | grep -vE '^(lo|docker|veth|br-)' | sed 's/^/     /' || true
  mapfile -t IFACES < <(list_ifaces)
  [[ ${#IFACES[@]} -gt 0 ]] || die "Не найдено ни одного сетевого интерфейса"
  DEF_IFACE="${IFACES[0]}"
  [[ -n $(default_iface) ]] && DEF_IFACE="$(default_iface)"
  if ask_yn "Задать статический адрес в рабочей сети?" y; then
    ask "Интерфейс (${IFACES[*]})" "${SIGNAGE_IFACE:-$DEF_IFACE}"; NET_IF="$REPLY"
    ip link show "$NET_IF" >/dev/null 2>&1 || die "Нет интерфейса $NET_IF"
    while true; do
      ask "Адрес/маска" "${SIGNAGE_CIDR:-10.33.44.20/24}"; NET_CIDR="$REPLY"
      [[ $NET_CIDR =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] && break
      warn "Формат: 10.33.44.20/24"
    done
    ask "Шлюз" "${SIGNAGE_GATEWAY:-10.33.44.1}"; NET_GW="$REPLY"
    ask "DNS-сервер" "${SIGNAGE_DNS:-10.33.44.5}"; NET_DNS="$REPLY"
    NET_IP="${NET_CIDR%/*}"

    # По SSH через этот интерфейс смена адреса оборвёт соединение и сам скрипт.
    CUR_IF_IP="$(iface_ipv4 "$NET_IF")"; CUR_IF_IP="${CUR_IF_IP%/*}"
    if [[ -n ${SSH_CONNECTION-} ]] && [[ $(awk '{print $3}' <<< "$SSH_CONNECTION") == "$CUR_IF_IP" ]] && [[ $CUR_IF_IP != "$NET_IP" ]]; then
      warn "Вы подключены по SSH к $CUR_IF_IP — после смены адреса соединение оборвётся и скрипт прервётся."
      ask_yn "Всё равно продолжить? (лучше запустить из консоли Proxmox)" n || die "Запустите configure.sh из консоли Proxmox"
    fi

    write_static "$NET_IF" "$NET_CIDR" "$NET_GW" "$NET_DNS"
    write_dns "$NET_DNS"
    apply_network "$NET_IF"
    sleep 2
    ok "Интерфейс $NET_IF: $(iface_ipv4 "$NET_IF") (шлюз $NET_GW, DNS $NET_DNS) — сохранено и после перезагрузки"

    # Второй интерфейс с DHCP (например, временный «интернетный») может увести маршрут по умолчанию.
    for other in "${IFACES[@]}"; do
      [[ $other == "$NET_IF" ]] && continue
      if ip -4 route show default dev "$other" 2>/dev/null | grep -q .; then
        warn "У интерфейса $other тоже есть маршрут по умолчанию ($(iface_ipv4 "$other")). Если это временная сеть с интернетом —"
        info "     удалите это сетевое устройство у VM в Proxmox, иначе часть трафика пойдёт мимо шлюза $NET_GW."
      fi
    done

    if pings "$NET_GW"; then
      ok "Шлюз $NET_GW отвечает"
    else
      warn "Шлюз $NET_GW не отвечает. Проверьте в Proxmox, что сетевое устройство VM подключено к мосту (и VLAN) рабочей сети."
      ask_yn "Продолжить настройку?" y || die "Исправьте подключение VM к сети и запустите configure.sh снова"
    fi
  fi
fi

# Точное время: в рабочей сети интернета нет — берём время с локального сервера
echo
info "${C_BOLD}Точное время${C_RESET} нужно для расписания. Без интернета — с сервера в локальной сети"
info "(контроллер домена, роутер или файловый сервер)."
ask "NTP-сервер (пусто — не менять)" "${SIGNAGE_NTP:-${NET_DNS:-10.33.44.5}}"
if [[ -n $REPLY ]]; then
  mkdir -p /etc/systemd/timesyncd.conf.d
  printf '[Time]\nNTP=%s\n' "$REPLY" > /etc/systemd/timesyncd.conf.d/signage.conf
  systemctl restart systemd-timesyncd 2>/dev/null || true
  timedatectl set-ntp true >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do
    [[ $(timedatectl show -p NTPSynchronized --value 2>/dev/null) == yes ]] && break
    sleep 2
  done
  if [[ $(timedatectl show -p NTPSynchronized --value 2>/dev/null) == yes ]]; then
    ok "Время синхронизировано с $REPLY: $(date '+%F %T %Z')"
  else
    warn "Нет синхронизации с $REPLY (сейчас $(date '+%F %T %Z')). Если время неверное, расписание будет сбиваться:"
    info "     уточните адрес NTP у администратора и выполните: sudo bash $INSTALL_DIR/deploy/configure.sh --skip-network"
  fi
fi

# -----------------------------------------------------------------------------
step "Настройки"
# -----------------------------------------------------------------------------
# Значения от прежних установок — как подсказки по умолчанию.
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
  ask "IP-адрес сервера" "${SIGNAGE_IP:-${NET_IP:-$(primary_ip)}}"; SERVER_IP="$REPLY"
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
      SMB_HOST_DEF="$(env_get SMB_HOST)"
      ask "Адрес файлового сервера" "${SIGNAGE_SMB_HOST:-${SMB_HOST_DEF:-10.33.44.5}}"; SMB_HOST="$REPLY"
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

# Ротация журналов ставится на шаге 1 (нужен интернет)
pm2u jlist 2>/dev/null | grep -q '"name":"pm2-logrotate"' || warn "Ротация журналов PM2 не установлена (ставится в prepare.sh при наличии интернета)"

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
    signage update          — обновить из Git и перезапустить (нужен интернет)
    sudo bash $INSTALL_DIR/deploy/configure.sh — перенастроить (адрес, SMB, пароли)

  Журнал установки: $LOG_FILE
EOF
