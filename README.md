# DarkArmy Dossier

Командная работа с файлами: проекты и роли, предпросмотр и редактирование документов,
чаты и обращения, корзина и публичные ссылки, админ-панель и локальный ИИ-ассистент Darcus.

Работает локально без облаков: данные лежат на диске, ИИ — через локальную Ollama.

## Возможности

- **Проекты и доступ**: роли `creator` / `editor` / `member`, приглашения по кодам,
  баны и мьюты, журнал действий с откатом.
- **Файлы**: дерево, создание/переименование/перемещение, корзина на 14 дней,
  предпросмотр Markdown, изображений, DOCX, XLSX, PDF, публичные share-ссылки с TTL.
- **Редактор**: Markdown с превью, тулбар, черновики в localStorage, автосохранение,
  совместное редактирование (SSE), печать.
- **Общение**: общий чат, чат проекта с задачами, поддержка (тикеты), вложения,
  запросы на изменение файлов и жалобы.
- **Поиск**: по имени и содержимому, гибридный (keyword + семантика), OCR-текст картинок.
- **Darcus AI**: чат со стримингом, RAG по проектам, веб/Вики, rewrite/translate/summarize,
  генерация документов, ACTION-блоки (создание/изменение файлов с подтверждением),
  OCR/vision, TTS (серверный или браузерный), STT через Whisper.
- **Админка**: пользователи, приглашения, наказания, журнал, настройки, телеметрия,
  реклама, подписки, конфиг Darcus.

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

## Darcus (локальный ИИ)

```bash
ollama pull gemma4:e4b          # чат и vision
ollama pull nomic-embed-text    # эмбеддинги для семантического поиска
```

Модели задаются в **Админка → Darcus** (или `data/ai-config.json`):
`chatModel`, `visionModel`, `embedModel`, `rerankModel`.
Если embedding-модель недоступна, семантика деградирует до keyword-поиска (без падений).
Whisper и TTS включаются переменными `WHISPER_BIN`, `WHISPER_MODEL`, `TTS_URL`;
без них голосовой ввод отключается, а озвучка идёт через браузер.

## Данные и бэкапы

- Метаданные: `data/*.json` (пользователи, проекты, чаты, журнал, телеметрия).
- Файлы проектов: `PROJECTS_ROOT`.
- Запись JSON атомарная (`tmp` → `fsync` → `rename`), перед перезаписью создаётся `.bak`;
  при повреждении файла данные восстанавливаются из `.bak`, иначе сервер падает явно,
  а не стартует с пустой базой.
- Бэкап: копируйте `data/` и `PROJECTS_ROOT`. Пример для Windows:
  `powershell -File scripts/backup.ps1` (см. `scripts/`).

## Тесты

```bash
npm test     # node:test: юнит-тесты + API-матрица безопасности
npm run check
```

## Production

1. Заполнить `.env`: `NODE_ENV=production`, `SESSION_SECRET`, `PROJECTS_ROOT`.
2. Поставить reverse proxy с HTTPS (Caddy/nginx) и проксировать на `127.0.0.1:7561`.
3. Задать `TRUST_PROXY=1` (или адрес прокси), включить автозапуск (NSSM/PM2/systemd).
4. Настроить ежедневный бэкап `data/` и `PROJECTS_ROOT`.

Пример Caddy:

```
dossier.example.com {
    reverse_proxy 127.0.0.1:7561
}
```

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
darcus.js          Ollama, RAG, OCR/vision, TTS/STT, промпты
config.js          конфигурация из env
logger.js          логи и access-log с ротацией
extract-text.js    извлечение текста из файлов
public/            SPA без сборки: index.html, app.js, admin.js, style.css, vendor/
test/              node:test: unit + API
data/              метаданные (не коммитится)
```

## Документация

- [Аудит и план развития](../DARKARMY_ROADMAP.md)
- [.env.example](.env.example)

## Лицензия

AGPL-3.0-only.
