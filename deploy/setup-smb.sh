#!/usr/bin/env bash
# Монтирование сетевого диска SMB на хосте (VM) для Signage.
#
#   cd /opt/signage && sudo ./deploy/setup-smb.sh
#
# Что делает:
#   - сохраняет учётные данные в /etc/signage-smb.cred (права 600);
#   - создаёт точку монтирования $SMB_ROOT/share с меткой .NOT-MOUNTED
#     (метка видна только когда шара НЕ смонтирована — сервер так понимает,
#     что смотрит на пустой каталог диска VM, а не на SMB);
#   - добавляет строку в /etc/fstab с nofail: VM загружается и без SMB;
#   - ставит таймер signage-smb-remount: раз в минуту, если шара не
#     смонтирована, пытается смонтировать её снова;
#   - пробует смонтировать сразу.
#
# Параметры берутся из .env (SMB_HOST, SMB_SHARE, SMB_USER, SMB_PASSWORD,
# SMB_DOMAIN, SMB_VERS, SMB_ROOT). Скрипт можно запускать повторно — например,
# после смены адреса SMB в .env.
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ $EUID -ne 0 ]]; then
  echo "Запустите через sudo: sudo $0" >&2
  exit 1
fi
if [[ ! -f .env ]]; then
  echo "Нет файла .env — скопируйте .env.example в .env и заполните" >&2
  exit 1
fi
if ! command -v mount.cifs >/dev/null; then
  echo "Не установлен cifs-utils: sudo apt install -y cifs-utils" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${SMB_HOST:?SMB_HOST не задан в .env}"
: "${SMB_SHARE:?SMB_SHARE не задан в .env}"
: "${SMB_USER:?SMB_USER не задан в .env}"
: "${SMB_PASSWORD:?SMB_PASSWORD не задан в .env}"
SMB_VERS="${SMB_VERS:-3.0}"
SMB_ROOT="${SMB_ROOT:-/srv/signage-smb}"
SMB_DOMAIN="${SMB_DOMAIN:-}"
MOUNT="$SMB_ROOT/share"
CRED=/etc/signage-smb.cred
UID_GID=1000   # пользователь node в контейнере

# 1. Учётные данные
umask 077
{
  echo "username=$SMB_USER"
  echo "password=$SMB_PASSWORD"
  [[ -n "$SMB_DOMAIN" ]] && echo "domain=$SMB_DOMAIN"
} > "$CRED"
chmod 600 "$CRED"
umask 022

# 2. Точка монтирования с меткой
mkdir -p "$MOUNT"
chmod 755 "$SMB_ROOT"
if mountpoint -q "$MOUNT"; then
  echo "Шара уже смонтирована в $MOUNT — отмонтирую, чтобы обновить метку и параметры"
  umount "$MOUNT" || umount -l "$MOUNT"
fi
touch "$MOUNT/.NOT-MOUNTED"
chmod 755 "$MOUNT"
chmod 644 "$MOUNT/.NOT-MOUNTED"

# 3. /etc/fstab
OPTS="credentials=$CRED,vers=$SMB_VERS,uid=$UID_GID,gid=$UID_GID,file_mode=0664,dir_mode=0775,soft,nobrl,_netdev,nofail,x-systemd.mount-timeout=20"
# В fstab пробел в имени шары записывается как \040
DEVICE="//$SMB_HOST/$SMB_SHARE"
DEVICE="${DEVICE// /\\040}"
LINE="$DEVICE $MOUNT cifs $OPTS 0 0"
cp /etc/fstab /etc/fstab.signage.bak
grep -v ' # signage-smb$' /etc/fstab > /etc/fstab.tmp || true
echo "$LINE # signage-smb" >> /etc/fstab.tmp
mv /etc/fstab.tmp /etc/fstab
systemctl daemon-reload

# 4. Таймер перемонтирования
cat > /etc/systemd/system/signage-smb-remount.service <<UNIT
[Unit]
Description=Signage: mount SMB share if it is not mounted
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'mountpoint -q "$MOUNT" || mount "$MOUNT"'
UNIT

cat > /etc/systemd/system/signage-smb-remount.timer <<UNIT
[Unit]
Description=Signage: retry SMB mount every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now signage-smb-remount.timer >/dev/null

# Старый таймер из прежней версии документации больше не нужен.
if systemctl list-unit-files signage-ensure.timer >/dev/null 2>&1 && systemctl is-enabled signage-ensure.timer >/dev/null 2>&1; then
  systemctl disable --now signage-ensure.timer >/dev/null || true
  echo "Отключён старый таймер signage-ensure.timer (контейнер теперь стартует и без SMB)"
fi

# 5. Пробуем смонтировать
if mount "$MOUNT" 2>/tmp/signage-mount.err; then
  echo "SMB смонтирован: //$SMB_HOST/$SMB_SHARE → $MOUNT"
  ls -la "$MOUNT" | head -5
else
  echo "Не удалось смонтировать сейчас: $(cat /tmp/signage-mount.err)"
  echo "Сервер будет работать с диска VM; таймер попробует снова через минуту."
fi
echo
echo "Проверка: mountpoint $MOUNT && systemctl list-timers signage-smb-remount.timer"
