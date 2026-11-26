# Signage

Система digital signage для локальной сети учреждения: сервер с веб-админкой и плееры на экранах (Windows OPS + Edge в режиме киоска).

- **Медиатека:** изображения, видео (mp4/H.264, webm), HTML-файл и HTML-пакет в zip.
- **Плейлисты** с длительностью, вписыванием и переходом для каждого элемента.
- **Расписание** по дням недели и времени для экрана или группы; вне расписания — чёрный экран.
- **Ручные переключения:** плейлист или чёрный экран до следующей смены, на N часов или до отмены.
- **Группы экранов**, в том числе с синхронным показом.
- **Офлайн:** плееры играют из кэша, если сервер или сеть недоступны.
- **Работа без SMB:** приоритет у сетевого диска; если он недоступен, сервер отдаёт файлы из копии на диске VM, принимает загрузки туда и потом сам переносит их на SMB.
- **Прокси внешних данных** для HTML-виджетов (у экранов нет интернета).
- Роли `admin` и `operator`, журнал действий, бэкапы БД.

Полное техническое задание — [CLAUDE.md](CLAUDE.md).

## Установка

На сервере с Debian 12/13 или Ubuntu 22.04/24.04:

```bash
sudo bash deploy/install.sh
```

Скрипт поставит Docker и всё необходимое, спросит адрес, сетевой диск и пароли и запустит сервер. Как доставить код на сервер — в начале [docs/install-debian.md](docs/install-debian.md).

## Документация

- [docs/install-debian.md](docs/install-debian.md) — **установка на чистый Debian 13** шаг за шагом: VM в Proxmox, Docker, SMB, пользователи, первый запуск, проверка.
- [docs/install-ubuntu.md](docs/install-ubuntu.md) — то же для Ubuntu Server 24.04.
- [docs/deploy.md](docs/deploy.md) — эксплуатация: работа без SMB, обновление, бэкапы и восстановление, отказ узла Proxmox, безопасность.
- [kiosk/README.md](kiosk/README.md) — установка плеера на Windows.
- [docs/widget-example/index.html](docs/widget-example/index.html) — пример HTML-виджета: часы, погода, курс ЦБ.

## Пользователи и пароли

Пользователи задаются только в `config/config.yaml`, раздел `users` (логин, роль `admin` или `operator`, bcrypt-хэш пароля). Хэш выдаёт команда:

```bash
# на сервере (Docker)
docker compose run --rm signage node packages/server/dist/cli/hash-password.js
# при разработке
npm run hash-password
```

После правки конфига перезапустите сервер. При смене пароля старые сессии этого пользователя сразу перестают действовать.

## Разработка

Нужен Node.js 22.12+.

```bash
npm install
cp config/config.example.yaml config/config.yaml   # пути storage.* сделайте относительными, например ../data/media
npm run hash-password                              # хэш для users[].passwordHash
npm run build                                      # shared, admin, player, server
npm run dev                                        # сервер на http://localhost:8080 (перезапуск при изменениях)
```

- Админка с горячей перезагрузкой: `npm run dev:admin` → http://localhost:5173/admin/ (API проксируется на :8080).
- Плеер: `npm run dev:player` → http://localhost:5174/player/.
- Для превью и длительности видео нужны `ffmpeg` и `ffprobe` в `PATH` (или переменные `FFMPEG_PATH`, `FFPROBE_PATH`).

Перед коммитом:

```bash
npm run check   # lint + typecheck + тесты
```

## Структура

```
packages/
  shared/   общие типы и протокол WebSocket (zod)
  server/   Fastify: API, WS-хабы, планировщик, медиа, прокси, бэкапы
  admin/    React-админка (Vite)
  player/   плеер: vanilla TypeScript + Service Worker
kiosk/      PowerShell-скрипты для Windows-плееров
docs/       развёртывание и пример виджета
```
