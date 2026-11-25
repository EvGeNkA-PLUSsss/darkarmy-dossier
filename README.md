# DarkArmy Dossier

Командная работа с файлами: проекты и роли, предпросмотр и редактирование документов,
чаты и обращения, корзина и публичные ссылки, админ-панель и локальный ИИ-ассистент Darcus.

Работает локально без облаков: данные лежат на диске, ИИ — через локальную Ollama.

## Возможности

- **Проекты и доступ**: роли `creator` / `editor` / `member`, приглашения по кодам,
  баны и мьюты, журнал действий с откатом.
- **Файлы**: дерево, создание/переименование/перемещение, корзина на 14 дней, история версий с diff,
  предпросмотр Markdown, изображений, DOCX, XLSX, PDF, публичные share-ссылки с TTL.
- **Редактор**: Markdown с превью, тулбар, черновики в localStorage, автосохранение,
  совместное редактирование (SSE), печать.
- **Общение**: общий чат, чат проекта, поддержка (тикеты), вложения,
  запросы на изменение файлов и жалобы.
- **Поиск**: глобальный — файлы (имя/содержимое, keyword + семантика, OCR), проекты, сообщения общего и проектных чатов, задачи и люди; с учётом прав доступа и переходами в найденный объект.
- **Darcus AI**: чат со стримингом, RAG по проектам, веб/Вики, rewrite/translate/summarize,
  генерация документов, ACTION-блоки (создание/изменение файлов с подтверждением),
  OCR/vision, TTS (серверный или браузерный), STT через Whisper.
- **Задачи**: список в чате проекта и канбан-доска (todo/doing/done) с drag&drop, исполнителями и порядком.
- **Уведомления**: центр событий (тикеты, запросы, жалобы, добавление в проект, @упоминания) с badge и переходом к объекту.
- **Экспорт/импорт**: JSON-снимок метаданных (пользователи, проекты, документы) и восстановление с подтверждением.
- **Админка**: дашборд состояния (БД, размеры, бэкапы, модели Ollama), пользователи,
  приглашения, наказания, журнал, настройки, телеметрия, реклама, подписки, конфиг Darcus.

## Требования

- Node.js **20+** (проверено на 24);
- Windows/Linux/macOS; для ИИ — [Ollama](https://ollama.com) с моделями (см. ниже);
- каталог для файлов проектов (по умолчанию `F:/Проекты`).

## Быстрый старт

```bash
npm install
cp .env.example .env      # и заполнить SESSION_SECRET, PROJECTS_ROOT
npm start                 # http://127.0.0.1:7561
```

Первый запуск создаёт администратора `admin`:
- если задан `ADMIN_PASSWORD` — с этим паролем;
- иначе случайный пароль печатается **в консоль** (в лог-файл не пишется).
Смените пароль после первого входа.

### Обязательные переменные окружения

| Переменная | Назначение |
|---|---|
| `NODE_ENV` | `production` включает secure-cookie, HSTS и прочий прод-харденинг |
| `SESSION_SECRET` | секрет подписи сессий, обязателен в production |
| `PROJECTS_ROOT` | каталог с файлами проектов |
| `PORT`, `BIND_HOST` | адрес прослушивания (по умолчанию `127.0.0.1:7561`) |
| `DATA_DIR` | каталог метаданных (по умолчанию `./data`) |
| `TRUST_PROXY` | `false` / `true` / число хопов / список IP для reverse proxy |
| `ADMIN_PASSWORD` | стартовый пароль администратора (опционально) |

Полный список — в [`.env.example`](.env.example).

### Доступ из локальной сети (LAN)

По умолчанию сервер слушает только `127.0.0.1` — с других устройств он недоступен.
Чтобы открыть его в домашней/офисной сети:

1. В `.env` поставьте `BIND_HOST=0.0.0.0`.
2. Разрешите порт в брандмауэре Windows (PowerShell **от администратора**), ограничив
   доступ своей подсетью:

   ```powershell
   New-NetFirewallRule -DisplayName "DarkArmy Dossier (LAN 7561)" `
     -Direction Inbound -Protocol TCP -LocalPort 7561 -Action Allow `
     -Profile Private -RemoteAddress 192.168.120.0/24
   ```

3. Узнайте IP (`ipconfig`) и откройте `http://<IP>:7561` с другого устройства сети.

Важно: это **HTTP без шифрования**. Открывайте только в доверенной локальной сети и
не публикуйте `0.0.0.0` в интернет напрямую — для интернета используйте HTTPS
reverse proxy из [deploy/README.md](deploy/README.md). Если сеть помечена как
«Общественная» (Public), правило для Private-профиля не сработает — переключите
профиль сети или добавьте правило для Public осознанно.

## Darcus (локальный ИИ)

```bash
ollama pull gemma4:e4b          # чат и vision
ollama pull nomic-embed-text    # эмбеддинги для семантического поиска
```

Модели задаются в **Админка → Darcus** (или `data/ai-config.json`):
`chatModel`, `visionModel`, `embedModel`, `rerankModel`.
Vision-модель для OCR/анализа фото должна поддерживать изображения: `gemma4:e4b`,
`qwen2.5vl:3b`, `llava`, `minicpm-v`, `pixtral` и т.п. (проверяется по имени и
через `/api/show` Ollama). Для запросов с изображением Darcus использует компактный
промпт — так qwen2.5vl стабильно распознаёт текст.
Если embedding-модель недоступна, семантика деградирует до keyword-поиска (без падений).
Whisper и TTS включаются переменными `WHISPER_BIN`, `WHISPER_MODEL`, `TTS_URL`;
без них голосовой ввод отключается, а озвучка идёт через браузер.

## Данные и бэкапы

- **Метаданные**: SQLite `data/dossier.db` (пользователи, проекты, журнал изменений,
  телеметрия, сессии). При первом запуске данные из старых `data/*.json` автоматически
  переносятся в БД, JSON остаются архивом, а перед миграцией создаётся копия
  `data/backup-pre-sqlite-<дата>/`.
- **Прочие настройки** (инвайты, наказания, чаты, подписки, реклама, Darcus-конфиг)
  пока хранятся в JSON с атомарной записью и `.bak`.
- **Файлы проектов**: `PROJECTS_ROOT`.
- **Бэкап**: `npm run backup` — консистентная копия SQLite через backup API,
  JSON-архив и файлы проектов в `../backups/<дата>/` с ротацией (по умолчанию 7 копий).
  Параметры: `--keep 14`, `--no-projects`, `--dest D:\backups`.
- **Сессии** хранятся в SQLite и переживают перезапуск сервера (при стабильном `SESSION_SECRET`).

## Тесты

```bash
npm test     # node:test: юниты, миграция SQLite, API-матрица безопасности
npm run check
```

## Production

Пошаговая инструкция: [deploy/README.md](deploy/README.md).

Кратко:
1. `.env`: `NODE_ENV=production`, `SESSION_SECRET`, `PROJECTS_ROOT`, `BIND_HOST=127.0.0.1`, `TRUST_PROXY=1`.
2. HTTPS reverse proxy — готовые конфиги `deploy/Caddyfile` (автосертификаты) или `deploy/nginx.conf`.
3. Автозапуск — `deploy/install-task.ps1` (Windows), `deploy/darkarmy-dossier.service` (systemd) или `deploy/ecosystem.config.js` (PM2).
4. Ежедневный бэкап — `npm run backup` или `deploy/install-backup-task.ps1`.
## Безопасность

- Файлы проектов отдаются по allow-list: изображения/PDF — инлайн, HTML/JS/SVGZ/XML и
  неизвестные типы — как `text/plain` или `attachment`; SVG — с закрытым CSP.
- CSP без `unsafe-inline` для скриптов, все библиотеки вендорены в `public/vendor`.
- Сессии: httpOnly + SameSite=strict, secure в production; rate-limit по пользователю.
- Журнал изменений редактирует содержимое секретных файлов.
- Перед публикацией в интернет: смените пароль admin, закройте `data/` правами ОС,
  включите HTTPS, проверьте `TRUST_PROXY`.

## Структура

```
server.js          Express API (роуты, middleware, бизнес-логика)
src/storage.js     SQLite-слой: пользователи, проекты, документы, журнал, телеметрия, сессии, уведомления
src/util.js        общие утилиты: safeJoin, пароли, rate-limit, отдача файлов
src/routes/        вынесенные роутеры: system (админка/бэкап), history, notifications
darcus.js          Ollama, RAG, OCR/vision, TTS/STT, промпты
config.js          конфигурация из env
logger.js          логи и access-log с ротацией
extract-text.js    извлечение текста из файлов
scripts/backup.js  консистентный бэкап БД + данных + проектов
deploy/            production: Caddy/nginx, systemd, PM2, задачи Windows, гайд
public/            SPA без сборки: index.html, app.js, admin.js, style.css, vendor/
public/js/         модули фронтенда: search.js, history.js, notifications.js, ui-dialog.js, modal-a11y.js
test/              node:test: unit + storage + API
data/              SQLite-БД, JSON-архив, вложения (не коммитится)
```

## Документация

- [Аудит и план развития](docs/ROADMAP.md)
- [Приёмка production-готовности](docs/ACCEPTANCE.md)
- [Развёртывание](deploy/README.md)
- [.env.example](.env.example)

### Скриншоты

- [Основной интерфейс](docs/screenshots/desktop-main.png)
- [Админ-дашборд](docs/screenshots/admin-dashboard.png)
- [Мобильная версия](docs/screenshots/mobile-main.png)

## Лицензия

AGPL-3.0-only.
