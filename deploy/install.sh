#!/usr/bin/env bash
# =============================================================================
#  Signage — установка «всё сразу» (если у сервера есть интернет в рабочей сети)
#
#      sudo bash install.sh
#
#  Последовательно запускает:
#    1. prepare.sh   — пакеты, Node.js 22, PM2, код, сборка (нужен интернет);
#    2. configure.sh — адрес для экранов, SMB, пароли, запуск через PM2.
#       Сеть не меняется; чтобы задать статический адрес — запустите
#       configure.sh отдельно без параметра --skip-network.
#
#  Если в рабочей сети интернета нет — запускайте шаги по отдельности:
#  prepare.sh в сети с интернетом, затем configure.sh в рабочей сети.
#  Подробно: docs/install-debian.md
# =============================================================================
set -Eeuo pipefail

RAW_BASE="${SIGNAGE_RAW_BASE:-https://raw.githubusercontent.com/SLEMSIK/signage/main}"
INSTALL_DIR="${SIGNAGE_DIR:-/opt/signage}"

if [[ $EUID -ne 0 ]]; then
  echo "Запустите от root: sudo bash $0" >&2
  exit 1
fi

SCRIPT_DIR=""
if [[ -n ${BASH_SOURCE[0]-} && -f ${BASH_SOURCE[0]} ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

PREPARE="$SCRIPT_DIR/prepare.sh"
if [[ ! -f $PREPARE ]]; then
  # Скрипт скачан отдельно (wget install.sh) — берём prepare.sh из репозитория.
  PREPARE="$(mktemp --suffix=-prepare.sh)"
  echo "Скачиваю prepare.sh…"
  if command -v wget >/dev/null; then wget -qO "$PREPARE" "$RAW_BASE/deploy/prepare.sh"
  else curl -fsSL "$RAW_BASE/deploy/prepare.sh" -o "$PREPARE"; fi
fi

bash "$PREPARE" "$@"
bash "$INSTALL_DIR/deploy/configure.sh" --skip-network "$@"
