# 12. Разработка

## Содержание

1. [Принципы и стиль](#принципы-и-стиль)
2. [Структура кода](#структура-кода)
3. [npm-скрипты](#npm-скрипты)
4. [Как добавить API-маршрут](#как-добавить-api-маршрут)
5. [Как добавить страницу или элемент UI](#как-добавить-страницу-или-элемент-ui)
6. [Как добавить или изменить промпт Darcus](#как-добавить-или-изменить-промпт-darcus)
7. [Как добавить поле в хранилище](#как-добавить-поле-в-хранилище)
8. [Как добавить SSE-событие](#как-добавить-sse-событие)
9. [Тесты](#тесты)
10. [CI](#ci)
11. [Отладка](#отладка)
12. [Полезные команды](#полезные-команды)
13. [Карта файлов](#карта-файлов)
14. [См. также](#см-также)

---

## Принципы и стиль

| Правило | Комментарий |
|---|---|
| CommonJS (`require`/`module.exports`) | `"type": "commonjs"` в `package.json` |
| Node 20+, реально 24 | `node:sqlite`, `fetch`, `node:test` без зависимостей |
| Без сборки фронтенда | `public/*.js` подключаются `<script src>`, никаких бандлеров |
| Без CDN | библиотеки в `public/vendor`, CSP `script-src 'self'` |
| Русские комментарии и сообщения | UI и ошибки — по-русски |
| Точка с запятой, 2 пробела | как в существующем коде |
| Нет линтера/форматтера | ❌ ESLint/Prettier не настроены; стиль поддерживается вручную |
| Синхронный ФС в обработчиках | допустимо в текущей архитектуре, но помните про event loop |
| Ошибки — `{error: …}` | для `/api/*` всегда JSON |

`npm run check` — единственная автоматическая проверка синтаксиса (перечислены все
ключевые файлы). Добавили новый `.js` — добавьте его в `scripts.check`.

---

## Структура кода

```
server.js        Express-приложение, маршруты, middleware, SSE, старт
config.js        env → cfg (единственная точка чтения process.env)
darcus.js        Ollama, RAG, промпты, OCR, TTS/STT
logger.js        pino/fallback + access-log
extract-text.js  извлечение текста (docx/xlsx/pdf/pptx)
src/storage.js   SQLite: схема, миграции, документы, сессии, уведомления
src/util.js      safeJoin, пароли, rate-limit, отдача файлов
src/routes/      system.js, history.js, notifications.js, bugs.js
public/          SPA (index.html, app.js, admin.*, style.css, design.css, js/, vendor/)
scripts/         backup.js, silero_tts_server.py, faster_whisper_stt.py
deploy/          Caddyfile, nginx.conf, systemd, PM2, Windows-задачи
desktop/         Electron-обёртка
test/            node:test
data/            рабочее состояние (не в git)
```

Поток зависимости:

```
public/*  →  HTTP /api/*  →  server.js  →  { src/storage, src/util, darcus, fs }
                                   ↓
                             src/routes/*  (подключаются через app.use)
```

---

## npm-скрипты

| Скрипт | Что делает |
|---|---|
| `npm start` | `node server.js` (без `--env-file`, читает переменные процесса) |
| `npm run start:prod` | `node --env-file=.env server.js` |
| `npm test` | `node --test test/unit.test.js test/storage.test.js test/darcus.test.js test/ui.test.js test/api.test.js` |
| `npm run check` | `node --check` для server, darcus, config, logger, extract-text, src/*, routes, backup, PM2-конфиг, public JS |
| `npm run backup` | `node scripts/backup.js` |

Запуск отдельного теста:

```bash
node --test test/darcus.test.js
node --test --test-name-pattern="миграция" test/storage.test.js
```

---

## Как добавить API-маршрут

### 1. Выберите место

- общий маршрут, зависящий от `storage`/`darcus`/`fs` — `server.js`;
- админ-эксплуатация — `src/routes/system.js`;
- история файлов — `src/routes/history.js`;
- уведомления — `src/routes/notifications.js`;
- баги — `src/routes/bugs.js`;
- новая крупная группа — новый файл в `src/routes/` с фабрикой `module.exports = ({…deps}) => router`.

### 2. Шаблон для `server.js`

```js
app.post('/api/example', requireAuth, projectGuard('edit', 'body'), (req, res) => {
  const { projectId, path: rel } = req.body || {};
  if (!rel || typeof rel !== 'string')
    return res.status(400).json({ error: 'bad input' });

  let full;
  try { full = safeJoin(req.projectRoot, rel); }
  catch { return res.status(403).json({ error: 'forbidden' }); }

  try {
    // …работа…
    logChange({ user: req.user.username, action: 'example', file: rel, projectId });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

Обязательные элементы:

| Что | Зачем |
|---|---|
| `requireAuth` / `requireRole` / `requireSelfAdmin` | аутентификация и роль |
| `projectGuard(level, from)` | доступ к проекту (`from` = `body`/`query`/`params`) |
| `safeJoin` | защита путей |
| валидация типов и длины | не доверяйте телу |
| `logChange` | аудит (для изменяющих операций) |
| SSE (`sseSendTo`/`sseBroadcast`) | синхронизация UI |
| rate-limit | для дорогих операций |
| `try/catch` + `{error}` | предсказуемые ответы |

### 3. Шаблон роутера

```js
'use strict';
const express = require('express');

module.exports = function createExampleRouter(deps) {
  const { storage, requireAuth, logger } = deps;
  const router = express.Router();

  router.get('/api/example', requireAuth, (req, res) => {
    res.json({ ok: true });
  });

  return router;
};
```

Подключение в `server.js`:

```js
app.use(require('./src/routes/example')({ storage, requireAuth, logger }));
```

### 4. Обновите документацию и тесты

- добавьте маршрут в [04-api.md](04-api.md);
- добавьте тест в `test/api.test.js` (права, валидация, успешный путь);
- если добавили файл — в `npm run check`.

---

## Как добавить страницу или элемент UI

### Новая страница

1. Создайте `public/example.html`.
2. Подключите общие стили: `style.css`, `design.css`; скрипт — файлом
   (`<script src="js/example.js"></script>`), **не** инлайном: CSP запрещает
   inline-скрипты и `onclick`-атрибуты (`script-src-attr 'none'`).
3. Сервер отдаёт `public/` статикой — маршрут не нужен.
4. Если страница должна быть только для авторизованных — серверная проверка останется
   на API; в HTML добавьте редирект по `/api/me` (как в `admin.js`).

### Новая кнопка/модалка в SPA

1. Разметка — в `public/index.html` (все модалки вынесены из `#chatPanel`, не ломайте
   структуру `#layout`).
2. Иконка — `<svg class="ico"><use href="#i-name"/></svg>`; сам символ добавьте в
   SVG-спрайт в начале `index.html` (тест `ui.test.js` проверяет, что все `#i-*`
   объявлены).
3. Логика — в `public/app.js` (или отдельный модуль в `public/js/`, подключённый
   **до** `app.js`).
4. Модалки: используйте общий класс `.modal`/`.modal-inner`; доступность
   (`role="dialog"`, focus-trap, `Esc`) обеспечивает `js/modal-a11y.js`.
5. Диалоги подтверждения — `dlA`/`dlC`/`dlP` (обёртки над `ui-dialog.js`), не `alert`.

### Стили

- новые токены — в `design.css` (`:root`/`[data-theme]`), не хардкодьте цвета;
- адаптив — `@media (max-width: 900px)`, мобильные модалки — bottom-sheet;
- не добавляйте inline-стили, если можно классом.

### Проверка

```bash
npm run check
node --test test/ui.test.js
```

---

## Как добавить или изменить промпт Darcus

Промпты живут в двух местах, которые **нужно менять согласованно**:

1. `darcus.js` → `DEFAULT_PROMPTS` (значение по умолчанию и фолбэк);
2. `data/ai-config.json` → `prompts` (действующий конфиг конкретной инсталляции).

Шаги:

1. Добавьте ключ в `DEFAULT_PROMPTS`:

   ```js
   example: `Инструкция с подстановками: {query} и {context}`,
   ```

2. Используйте его в коде:

   ```js
   const prompt = applySubs(cfg.prompts.example, buildSubs({ query, context }));
   ```

3. Добавьте `textarea` в `public/admin.html` (секция `#tab-darcus`, форма
   `darcusPromptsForm`) — иначе админ не сможет отредактировать промпт.
4. Добавьте ключ в `data/ai-config.json` (или дайте `loadAiConfig` смержить дефолт —
   он добавляет отсутствующие ключи при чтении, но файл обновится только при сохранении).
5. Обновите [06-ai-darcus.md](06-ai-darcus.md).
6. Проверьте: `POST /api/darcus/test`, затем реальный запрос в чате.

Правила:

- плейсхолдеры только из `buildSubs` (иначе останутся `{…}` в тексте);
- для JSON-ответов (vision/summarize) требуйте «ТОЛЬКО JSON» и добавляйте терпимый парсер;
- не добавляйте в промпт секреты и токены;
- помните про бюджет: длинный `system` уменьшает контекст (см. [06-ai-darcus.md](06-ai-darcus.md)).

Стили ответа (`stylePresets`) меняются только файлом: `default`, `formal`, `friendly`,
`terse`, `code` — `{label, systemSuffix}`.

---

## Как добавить поле в хранилище

### JSON-документ (проще всего)

1. Прочитайте/запишите через `loadDoc('name', fallback)` / `saveDoc('name', data)`.
2. Добавьте поле с дефолтом при чтении:

   ```js
   const s = loadDoc('settings', {});
   if (s.newField === undefined) s.newField = defaultValue;
   ```

3. Опишите структуру в [05-data-model.md](05-data-model.md).

### Новая таблица SQLite

1. Добавьте `CREATE TABLE IF NOT EXISTS` и индексы в `storage.init`.
2. Увеличьте `SCHEMA_VERSION` и записывайте его в `meta`.
3. Добавьте функции доступа и экспортируйте их в `module.exports`.
4. Для существующих БД миграция должна быть идемпотентной (`IF NOT EXISTS`,
   `INSERT OR IGNORE`).
5. Если данные раньше лежали в JSON — добавьте миграцию (как `migrateFromJson`/
   `migrateDocsFromJson`) с резервной копией в `data/backup-pre-*`.
6. Добавьте тест в `test/storage.test.js` (миграция идемпотентна).

---

## Как добавить SSE-событие

1. На сервере: `sseSendTo([username], 'my-event', {…})` или `sseBroadcast('my-event', {…})`.
2. На клиенте (`public/app.js` → `connectSSE`):

   ```js
   evtSource.addEventListener('my-event', e => {
     const data = JSON.parse(e.data);
     // обновить UI точечно
   });
   ```

3. Добавьте событие в таблицу [04-api.md](04-api.md#sse-get-apievents).
4. Проверьте сценарий с двумя вкладками; учитывайте, что SSE только односторонний.

Ограничения: не отправляйте в broadcast персональные данные (правки файлов, приватные
сообщения) — только адресно.

---

## Тесты

### Что есть

| Файл | Покрытие |
|---|---|
| `test/unit.test.js` | `safeJoin` (кириллица, traversal, NUL), atomic JSON + `.bak`, пароли, `decodeUploadFilename`, `safeFileName` |
| `test/storage.test.js` | миграция JSON→SQLite, миграция документов, идемпотентность, журнал (фильтры/пагинация/update), телеметрия (батч/лимит/очистка), сессии |
| `test/darcus.test.js` | `isVisionModel`, `stripSpecialTokens`, `cleanGeneratedMarkdown`, `loadAiConfig`, `parseVisionJson` |
| `test/ui.test.js` | все SVG-иконки объявлены (`index.html`, `admin.html`), ключевые стили Darcus/OCR |
| `test/api.test.js` | health/version, доступ без авторизации, дашборд/бэкап, отдача `.shtml`/неизвестных/share как `text/plain`, `%` в именах, last-admin, права проекта, IDOR вложений, журнал, CSP, история версий, уведомления, `@упоминания`, стили Darcus, поиск, канбан, экспорт/импорт, баги, чаты Darcus, голос, перемещение между проектами |

### Как устроен API-тест

`test/api.test.js` перед загрузкой `server.js` выставляет переменные окружения на
временный каталог:

```js
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.PROJECTS_ROOT = path.join(tmp, 'projects');
process.env.BACKUP_DIR = path.join(tmp, 'backups');
process.env.SESSION_SECRET = '<тестовый-секрет>';
process.env.NODE_ENV = 'test';
```

Затем `const { app } = require('../server')` и `app.listen(0)` на случайном порту.
Клиент `makeClient()` хранит cookie и умеет `login/json/request`. В конце — закрытие
сервера и удаление временного каталога. **Реальные данные не затрагиваются.**

### Как писать тест

```js
test('мой маршрут: требует права', async () => {
  const member = makeClient();
  await member.login('member', 'MemberTest123!Pass');
  const { res } = await member.json('/api/example', { method: 'POST', body: '{}' });
  assert.equal(res.status, 403);
});
```

Правила:

- создавайте пользователей/проекты через API, не пишите в БД напрямую;
- проверяйте статус **и** тело;
- убирайте за собой файлы;
- не полагайтесь на порядок тестов (каждый должен быть независим).

### Playwright

В `package.json` **нет** Playwright ❌. Приёмочные прогоны (25/25 desktop+mobile)
делались вручную/скриптами и описаны в `docs/ACCEPTANCE.md`. Если нужны e2e:

```bash
npm i -D playwright
npx playwright install chromium
npx playwright test            # после добавления playwright.config.js
```

Минимальный сценарий: вход → создать проект → создать файл → сохранить → поиск →
открыть админку. Запускайте против временного `DATA_DIR`, а не против рабочих данных.

---

## CI

`.github/workflows/ci.yml`:

- триггеры: `push` в `main`, любой `pull_request`;
- матрица: `ubuntu-latest`, `windows-latest`;
- Node `24.x` с кэшем npm;
- шаги: `npm ci` → `npm run check` → `npm test` → `node scripts/backup.js --no-projects --dest ./test-backups`.

Что проверяется автоматически: синтаксис, тесты, работоспособность бэкапа на обеих ОС.
Чего нет: линтера, покрытия, e2e, сборки Electron, деплоя.

---

## Отладка

| Задача | Приём |
|---|---|
| Увидеть запросы | `data/log.txt` (access-log) или `LOG_LEVEL=debug` |
| Проверить API без браузера | `curl -b cookies.txt …` |
| Временно ослабить лимит | `LOGIN_MAX_ATTEMPTS=1000` в тестовом окружении |
| Быстрый старт на пустых данных | `DATA_DIR=./tmpdata PROJECTS_ROOT=./tmpproj node server.js` |
| Посмотреть конфиг | `node -e "console.log(require('./config'))"` |
| Посмотреть AI-конфиг | `node -e "console.log(require('./darcus').loadAiConfig())"` |
| Проверить Ollama | `curl localhost:11434/api/tags` |
| Найти утечку памяти | `node --inspect server.js`, Chrome DevTools → Memory |
| Профилировать | `node --prof server.js`, затем `node --prof-process isolate-*.log` |

Отладочные точки, которые стоит знать:

- `flushTelemetry()` — очередь телеметрии;
- `editSessions` — сессии совместного редактирования (в памяти, не экспортируется);
- `sseClients` — активные SSE-потоки;
- `darcus.loadAiConfig()` — мерж с дефолтами (частая причина «настройка не применилась»).

---

## Полезные команды

```bash
# синтаксис и тесты
npm run check
npm test
node --test test/api.test.js

# бэкап и проверка
npm run backup
node scripts/backup.js --no-projects --dest ./test-backups

# запуск с явным окружением
DATA_DIR=./tmpdata PROJECTS_ROOT=./tmpproj PORT=7600 node server.js

# локальный SQLite
node -e "const s=require('./src/storage');s.init({dir:'./data'});console.log(s.stats());s.close()"

# поиск по коду
grep -rn "projectGuard" server.js src/ | head
grep -rn "sseSendTo" server.js | wc -l

# git
git log --oneline -20
git diff --stat
```

---

## Карта файлов

| Файл | Строк (≈) | Что менять осторожно |
|---|---|---|
| `server.js` | 4 100 | порядок middleware, `projectGuard`, SSE, обработчик ошибок |
| `darcus.js` | 1 475 | промпты, парсинг JSON, таймауты |
| `src/storage.js` | 576 | схема и миграции (только идемпотентно) |
| `src/util.js` | 219 | `safeJoin`, allow-list MIME, пароли |
| `src/routes/system.js` | 124 | бэкап/импорт (деструктивные операции) |
| `src/routes/history.js` | 66 | права на историю |
| `src/routes/bugs.js` | 157 | скриншоты и лимиты |
| `public/app.js` | 5 600 | состояние `state`, SSE, редакторы, Darcus |
| `public/admin.js` | 1 327 | изоляция загрузки вкладок |
| `public/design.css` | — | токены и компоненты |
| `public/sw.js` | 60 | версия кэша (`VERSION`) |
| `test/api.test.js` | 641 | изоляция окружения (temp dirs) |

---

## См. также

- [01-architecture.md](01-architecture.md) — архитектура и слои.
- [04-api.md](04-api.md) — контракты, которые нельзя ломать.
- [05-data-model.md](05-data-model.md) — схема и миграции.
- [06-ai-darcus.md](06-ai-darcus.md) — промпты и параметры ИИ.
- [07-collaboration.md](07-collaboration.md) — SSE-редактор.
- [09-desktop-mobile-pwa.md](09-desktop-mobile-pwa.md) — PWA/Electron.
- [10-deployment-ubuntu.md](10-deployment-ubuntu.md) — обновление на сервере.
