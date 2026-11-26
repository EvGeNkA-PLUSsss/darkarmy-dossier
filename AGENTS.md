# AGENTS.md — инструкции для ИИ-агентов

Этот файл — точка входа для любых coding-агентов (Claude Code, Codex, Cursor, Copilot, DSH и др.).
Читайте его перед изменениями. Полная документация — в [`documenti/`](documenti/README.md).

## Что это за проект

**DarkArmy Dossier** — self-hosted веб-приложение для командной работы с файлами:
проекты и роли, дерево файлов, редактор Markdown, чаты, задачи/канбан, совместное
редактирование через SSE, админ-панель, телеметрия, подписки, баги, реклама и
ИИ-ассистент **Darcus** (Ollama + RAG + OCR/vision + TTS/STT).

- Node.js **20+** (проверено на 24), CommonJS, Express 5.
- SQLite через встроенный `node:sqlite` (`DatabaseSync`, WAL), файл `data/dossier.db`.
- Frontend — vanilla JS SPA без сборки: `public/index.html`, `public/app.js`,
  `public/style.css`, `public/design.css`, `public/js/*`.
- Real-time — SSE (`/api/events`), WebSocket нет.
- AI — локальная Ollama (`darcus.js`), инструкции — `ai-knowledge/`.

## Быстрые команды

```bash
npm install
npm start                 # http://127.0.0.1:7561
npm test                  # node:test, 50 тестов
npm run check             # синтаксис всех JS-файлов
npm run backup            # консистентный бэкап БД/данных
```

Перед PR обязательно: `npm run check && npm test`.
CI — GitHub Actions: `.github/workflows/test.yml` (Windows + Ubuntu).

## Карта репозитория

| Путь | Назначение |
|---|---|
| `server.js` | HTTP/HTTPS, все основные API, SSE, upload, проекты, Darcus-роуты |
| `darcus.js` | Ollama, RAG (файлы + `ai-knowledge`), OCR/vision, TTS/STT, ACTION, генерация документов |
| `config.js` | конфигурация из `.env`, лимиты (включая 500 МБ для подписки) |
| `src/storage.js` | SQLite-схема, миграции, сессии, телеметрия, документы |
| `src/routes/*.js` | системные/история/уведомления/баги |
| `public/app.js` | SPA: проекты, редактор, чаты, Darcus, офлайн, PWA, хоткеи |
| `public/admin.js`, `admin.html` | админ-панель |
| `public/sw.js`, `manifest.webmanifest` | PWA и офлайн-оболочка |
| `ai-knowledge/` | RAG-инструкции для Darcus (не удалять) |
| `site/` | лендинг GitHub Pages |
| `release/` | собранные APK/EXE |
| `android/`, `desktop/` | исходники мобильного/Windows-приложения |
| `deploy/` | systemd, nginx, Caddy, установка Ubuntu, бесплатный домен |
| `documenti/` | полная документация (16 файлов) |
| `test/` | node:test: unit, storage, darcus, ui, api |

## Правила разработки

1. **Малые изменения.** Один PR — одна логическая задача. Не смешивайте рефакторинг и фичи.
2. **Сначала воспроизведите баг**, затем фиксите; добавляйте регрессионный тест, если возможно.
3. **Не ломайте API.** Клиенты (SPA, APK, PWA) используют существующие поля; новые добавляйте,
   старые не удаляйте без миграции.
4. **Безопасность:** любой путь — через `safeJoin`; права — через `projectGuard`;
   не доверяйте клиентским путям/ID; лимиты и rate-limit — на сервере.
5. **Секреты:** никогда не коммитьте `.env`, `data/`, `backups/`, `*.pfx`, `*.key`,
   `android/debug.keystore`. В коде — только имена переменных.
6. **Файлы UTF-8.** На Windows не переписывайте исходники через PowerShell
   `Get-Content/Set-Content` — можно получить mojibake. Используйте edit/write инструменты.
7. **CLI-ссылки в UI** должны открываться через существующие обработчики, не инжектить HTML.
8. **Darcus ACTION** — только через `<<<ACTION>>>…<<<END ACTION>>>`; новые типы добавляйте
   одновременно в `darcus.js` (промпт), `AI_ACTION_TYPES` и `runAiAction` в `public/app.js`.
9. **Офлайн.** Любые новые данные, нужные для просмотра, добавляйте в `syncOfflineData()`
   и не разрешайте мутации в `state.offline`.
10. **Мобильный UI.** Проверяйте минимум 320/360/390 px; не добавляйте фиксированную ширину
    без `max-width`/`min-width:0`.

## Darcus: как расширять

- Системные/пользовательские промпты — `DEFAULT_PROMPTS` в `darcus.js` и `data/ai-config.json`
  (файл данных, не коммитится; дефолт — в коде).
- RAG по инструкциям — `ai-knowledge/*.md`; поиск `searchInstructions()`, статистика
  `getKnowledgeStats()`, API `GET /api/darcus/knowledge`.
- Модели/параметры — `data/ai-config.json`, админка → Darcus.
- Для больших документов используйте `generate_doc`, а не `create` с огромным content.
- Не выводите содержимое создаваемого файла в чат.

## Тесты и проверки

- `test/api.test.js` — матрица доступа/безопасности к API.
- `test/storage.test.js` — SQLite и миграции.
- `test/darcus.test.js` — промпты/vision/RAG.
- `test/ui.test.js` — SVG-иконки, ключевые элементы HTML.
- `test/unit.test.js` — утилиты.
- E2E вручную: Playwright/`webapp-testing`, логин, проект, файл, Darcus, офлайн, мобильные ширины.

## Деплой

- Ubuntu: `deploy/install-ubuntu.sh`, `deploy/nginx.conf`, systemd unit.
- HTTPS: Let's Encrypt; бесплатный домен — `deploy/free-domain.md`.
- Не публикуйте `7561` напрямую; только reverse proxy.
- Бэкап: `npm run backup` (БД + данные + projects).

## Git/PR

- Ветка от `main`, осмысленные коммиты.
- В PR: что изменилось, как проверить, скриншоты для UI, риски.
- Не пушить секреты и бинарники без необходимости (APK/EXE — только в `release/`).
- После изменений сервера перезапустите процесс; статичные JS/CSS браузер обновит
  автоматически через `/api/version` (или Ctrl+F5).

## Полезные ссылки

- [Архитектура](documenti/01-architecture.md)
- [API](documenti/04-api.md)
- [Darcus](documenti/06-ai-darcus.md)
- [Совместная работа](documenti/07-collaboration.md)
- [PWA/APK/EXE](documenti/09-desktop-mobile-pwa.md)
- [Разработка](documenti/12-development.md)
- [Баги](documenti/11-troubleshooting.md)
