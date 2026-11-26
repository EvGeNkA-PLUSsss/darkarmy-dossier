# 05. Модель данных

## Содержание

1. [Общая схема хранения](#общая-схема-хранения)
2. [SQLite: таблицы](#sqlite-таблицы)
3. [Индексы и прагмы](#индексы-и-прагмы)
4. [JSON-документы в таблице `documents`](#json-документы-в-таблице-documents)
5. [Файлы данных вне SQLite](#файлы-данных-вне-sqlite)
6. [Файлы проектов](#файлы-проектов)
7. [Миграции](#миграции)
8. [Экспорт и импорт метаданных](#экспорт-и-импорт-метаданных)
9. [Резервное копирование и восстановление](#резервное-копирование-и-восстановление)
10. [Практические запросы](#практические-запросы)
11. [См. также](#см-также)

---

## Общая схема хранения

```
DATA_DIR/                      (по умолчанию <repo>/data)
├── dossier.db                 SQLite: пользователи, проекты, журнал, телеметрия,
│   ├── dossier.db-wal          сессии, уведомления, JSON-документы
│   └── dossier.db-shm
├── ai-config.json             конфиг Darcus (модели, промпты, голос)
├── ocr-cache.json             кэш OCR/vision по SHA-1
├── embeddings.json            кэш эмбеддингов (до 50 000 чанков)
├── log.txt (+ .1…​.5)          JSON-логи, ротация при 10 МБ
├── attachments/               вложения чатов (файлы без расширений, имя = multer-filename)
├── ads/                       картинки рекламы
├── bug-reports/               скриншоты багов <uuid>.png|jpg|webp
├── tls/                       PFX и .cer для встроенного HTTPS
├── tmp/                       временные файлы multer (чистится при старте)
├── stt-<random>.webm          временные записи распознавания (удаляются после)
├── backup-pre-sqlite-<ISO>/   копия JSON перед миграцией в SQLite
├── backup-pre-docs-<ISO>/     копия JSON-документов перед миграцией
└── telemetry/                 исторический каталог (только для миграции)

PROJECTS_ROOT/
├── default/                   папка проекта «Основной»
│   └── .trash/                корзина проекта
├── <uuid>/                    папка каждого созданного проекта
└── …

BACKUP_DIR (по умолчанию <repo>/../backups)
└── 2026-11-25T12-00-00-000Z/
    ├── dossier.db
    ├── data/…                 копия DATA_DIR без db/tmp
    ├── projects/…             копия PROJECTS_ROOT (если не --no-projects)
    └── manifest.json
```

Важно: имя папки проекта — **`project.folder`**, а не `project.id`. При создании проекта
они совпадают (обе — UUID), но у проекта «Основной» `id: "default"`, `folder: "default"`.

---

## SQLite: таблицы

Инициализация — `src/storage.js` → `init({dir})`. Используется встроенный модуль
`node:sqlite` (`DatabaseSync`), внешние драйверы не нужны.

### `meta`

| Поле | Тип | Описание |
|---|---|---|
| `key` | TEXT PK | имя параметра |
| `value` | TEXT NOT NULL | значение (строкой) |

Ключи: `schema_version` (`2`), `json_migrated`, `json_migrated_at`, `docs_migrated`,
`docs_migrated_at`, `notifications_ready`.

### `users`

| Поле | Тип | Описание |
|---|---|---|
| `id` | TEXT PK | UUID |
| `username` | TEXT UNIQUE NOT NULL | логин (3–64) |
| `payload` | TEXT NOT NULL | JSON всего пользователя |

JSON пользователя:

```json
{ "id":"uuid","username":"admin","password":"$2b$10$…","role":"admin",
  "theme":"dark","mustChangePassword":true,"createdAt":"2026-11-25T…" }
```

`role` — роль сайта: `admin` или `member`. Хеш bcrypt (cost 10) лежит только в payload.

### `projects`

| Поле | Тип | Описание |
|---|---|---|
| `id` | TEXT PK | UUID (у «Основного» — `default`) |
| `payload` | TEXT NOT NULL | JSON проекта |

```json
{ "id":"uuid","name":"Маркетинг","folder":"uuid","creator":"admin",
  "members":[{"username":"admin","role":"creator"},
             {"username":"evgen","role":"editor"}],
  "createdAt":"…" }
```

`members[].role` ∈ `creator` / `editor` / `member`.

### `changes` (журнал)

| Поле | Тип | Описание |
|---|---|---|
| `id` | TEXT PK | UUID |
| `ts` | TEXT NOT NULL | ISO-время |
| `action` | TEXT | тип действия |
| `actor` | TEXT | кто (`user`) |
| `file` | TEXT | относительный путь |
| `project_id` | TEXT | проект |
| `payload` | TEXT NOT NULL | полный JSON записи |

JSON записи:

```json
{ "id":"uuid","timestamp":"2026-11-25T…","user":"admin","action":"edit",
  "file":"docs/a.md","projectId":"default","before":"…","after":"…",
  "from":"старый путь (для move/rename)","isDir":false,
  "target":"…","details":"…","reverted":false,
  "revertedAt":null,"revertedBy":null }
```

Значения `action`: `create`, `mkdir`, `edit`, `upload`, `delete`, `move`, `rename`,
`restore`, `trash-purge`, `revert`, `share-create`, `share-revoke`, `project-create`,
`project-update`, `project-delete`, `project-member-add`, `project-member-role`,
`project-member-remove`, `user-create`, `user-update`, `user-delete`, `user-register`,
`self-password-change`, `self-delete`, `punish-ban`, `punish-mute`, `unpunish`,
`invite-generate`, `invite-create`, `invite-delete`, `settings-update`, `backup`,
`admin-import`, `darcus-config-update`, `darcus-reindex`, `darcus-summarize`,
`subscription-activate`, `subscription-grant`, `subscription-revoke`,
`subscription-codes`, `voice-settings`, `voice-install`, `chat-project-delete`,
`edit`. Журнал **append-only**, полной перезаписи нет; хранится 5 000 последних записей
(`trimChanges` удаляет самые старые).

### `telemetry`

| Поле | Тип | Описание |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | порядковый номер |
| `username` | TEXT NOT NULL | пользователь |
| `ts` | TEXT NOT NULL | ISO-время |
| `payload` | TEXT NOT NULL | JSON события |

Типы событий: `login`, `logout`, `register`, `request` (каждый HTTP-запрос, кроме статики
и 304), `client-info`, `password-change`, `self-delete`, `chat-message-delete`,
`attach-upload`, `attach-access-denied`. Лимит — 2 000 событий на пользователя
(`trimTelemetry`).

### `sessions`

| Поле | Тип | Описание |
|---|---|---|
| `sid` | TEXT PK | идентификатор сессии |
| `sess` | TEXT NOT NULL | JSON сессии express-session |
| `expires` | INTEGER NOT NULL | время истечения (ms) |

Очистка просроченных — при каждом `get`, а также таймером каждые 15 минут.
Сессии переживают рестарт сервера (при стабильном `SESSION_SECRET`).

### `notifications`

| Поле | Тип | Описание |
|---|---|---|
| `id` | TEXT PK | UUID |
| `username` | TEXT NOT NULL | получатель |
| `type` | TEXT NOT NULL | `ticket`/`request`/`report`/`project`/`mention`/`bug` |
| `created_at` | TEXT NOT NULL | ISO |
| `read_at` | TEXT NULL | ISO прочтения |
| `payload` | TEXT NOT NULL | JSON уведомления |

JSON: `{id, username, type, title, body, link, projectId, createdAt, readAt}`.
Лимит — 200 на пользователя.

### `documents`

| Поле | Тип | Описание |
|---|---|---|
| `name` | TEXT PK | имя документа |
| `payload` | TEXT NOT NULL | JSON |
| `updated_at` | TEXT NOT NULL | ISO последней записи |

---

## Индексы и прагмы

```sql
PRAGMA journal_mode = WAL;     -- параллельное чтение при записи
PRAGMA synchronous = NORMAL;   -- компромисс скорость/надёжность
PRAGMA busy_timeout = 5000;    -- ждать блокировку до 5 с

CREATE INDEX idx_changes_ts        ON changes(ts DESC);
CREATE INDEX idx_changes_file      ON changes(file);
CREATE INDEX idx_changes_project   ON changes(project_id);
CREATE INDEX idx_telemetry_user_ts ON telemetry(username, ts DESC);
CREATE INDEX idx_sessions_expires  ON sessions(expires);
CREATE INDEX idx_notifications_user   ON notifications(username, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(username, read_at);
```

Следствия WAL:

- файл `dossier.db` на диске может быть меньше логического объёма — данные лежат в `-wal`;
- админ-дашборд показывает **логический** размер (`page_count × page_size`);
- нельзя копировать `dossier.db` «на горячую» без backup API и без `-wal` (см. ниже).

---

## JSON-документы в таблице `documents`

Перенесены из одноимённых JSON-файлов (`DOC_FILES` в `src/storage.js`). Полный список:

| `name` | Бывший файл | Структура |
|---|---|---|
| `settings` | `settings.json` | `{uploadLimitMB:50, generalChatMode:"everyone"\|"admins_only"}` |
| `invites` | `invites.json` | `{codes:[{code,note,createdBy,createdAt,usedBy,usedAt}]}` |
| `punishments` | `punishments.json` | `{items:[{id,type:"ban"\|"mute",username,reason,until,createdAt,createdBy}]}` |
| `requests` | `requests.json` | `{items:[{id,from,file,projectId,text,timestamp,status,closedBy?,closedAt?}]}` |
| `reports` | `reports.json` | `{items:[{id,from,reason,file,projectId,timestamp,status,resolvedBy?,resolvedAt?}]}` |
| `tickets` | `tickets.json` | `{tickets:[{id,from,subject,messages[],status,createdAt,acceptedBy?,closedBy?}]}` |
| `chat` | `chat.json` | `{messages:[{id,from,to:"general",text,attachments[],timestamp}]}` |
| `project-chats` | `project-chats.json` | `{chats:{<projectId>:{messages:[],tasks:[]}}}` |
| `attachments` | `attachments.json` | `{items:{<id>:{id,storedName,originalName,size,mime,kind,scope,uploadedBy,uploadedAt}}}` |
| `ads` | `ads.json` | `{slots:{…},images:[{id,filename,originalName,size,uploadedAt,enabled,allSlots}]}` |
| `subscriptions` | `subscriptions.json` | `{active:[{username,until,grantedBy,grantedAt,note}],codes:[{code,days,note,createdBy,createdAt,usedBy,usedAt}]}` |
| `shares` | `shares.json` | `{items:[{id,token,projectId,path,createdBy,createdAt,expiresAt,revoked,accessCount,lastAccessAt?,pinned?}]}` |
| `trash` | `trash.json` | `{items:[{id,projectId,originalPath,trashPath,isDir,deletedBy,deletedAt}]}` |
| `project-meta` | `project-meta.json` | `{projects:{<projectId>:{tags:{<path>:[…]},favorites:{<path>:true}}}}` |
| `darcus-chats` | `darcus-chats.json` | `{chats:{<username>:[{id,title,createdAt,updatedAt,messages[],context?,visionContext?}]}}` |
| `bugs` | — (создан позже) | `{items:[{id,user,description,page,createdAt,file,mime,editedAt?,editedBy?}]}` |

Особенности:

- `project-chats` хранит **и сообщения, и задачи** проекта; задача:
  `{id,text,done,status,order,assignee,priority,due,createdBy,createdAt,doneBy,doneAt}`.
- `attachments.items` — объект по `id`, а не массив (O(1) доступ).
- `ads.slots` по умолчанию: `topbar`, `sidebar-top`, `sidebar-bottom`, `chat-top`,
  `filebar`, `empty-viewer` — `{enabled, interval, note}`.
- `trash.items[].trashPath` — абсолютный путь к файлу в `.trash`; при переносе данных
  на другую машину эти пути нужно править.
- Документы читаются/пишутся целиком (`getDoc`/`setDoc`) в одной транзакции записи.
  Конкурентных частичных обновлений нет — это ограничение модели ❌.

---

## Файлы данных вне SQLite

| Файл | Формат | Кто пишет | Что при повреждении |
|---|---|---|---|
| `ai-config.json` | `DEFAULT_CONFIG` + merge | `darcus.saveAiConfig` | JSON-ошибка → используется `DEFAULT_CONFIG` |
| `ocr-cache.json` | `{items:{<sha1>:{text,description,boxes,analyzedAt,error?}}}` | `darcus.saveOcrCache` | чтение → `{items:{}}` (кэш теряется) |
| `embeddings.json` | `{model:"…",items:{<sha1>:{v:[…],t:"чанк",p:projectId,f:path}}}` | `saveEmbedCache` | чтение → пустой кэш |
| `log.txt` | JSON-строки (`{time,level,...,msg}`) | `logger` | ротация при 10 МБ, хранится 5 архивов |
| `attachments/<multer-filename>` | бинарный файл | multer + `saveAttachments` | метаданные в `documents`, файл без записи недоступен |
| `ads/<filename><ext>` | изображение | `/api/ads/upload` | запись в `documents.ads` |
| `bug-reports/<uuid>.<ext>` | изображение | `src/routes/bugs.js` | запись в `documents.bugs` |
| `tls/dossier.pfx` | PKCS#12 | администратор | HTTPS-порт не стартует |

Кэш эмбеддингов: ключ — SHA-1 **текста чанка** (не файла), поэтому правка файла
добавляет новые чанки, а старые остаются до вытеснения (лимит 50 000). Для удаления
чанков конкретного файла используется `invalidateFileCache(projectId, rel)`.
OCR-кэш: ключ — SHA-1 **содержимого файла**, поэтому `move`/`rename` его не сбрасывают.

---

## Файлы проектов

```
PROJECTS_ROOT/
└── <project.folder>/
    ├── документы, папки пользователя
    ├── attachments/ images/ …   (если пользователь так назвал папки)
    └── .trash/
        └── <trashId>__<исходное имя>
```

Правила:

- API работает только с относительными путями через `/`; `\` нормализуется, `..` и NUL
  запрещены (`safeJoin`), после `realpath` проверяется, что путь внутри корня проекта.
- Скрытые имена (`.…`) не показываются в дереве и не индексируются.
- Корзина — обычная папка `.trash` внутри проекта; её содержимое невидимо в дереве.
- Удаление проекта (`DELETE /api/projects/:projectId`, admin) удаляет папку целиком
  (`fs.rmSync recursive`), без корзины. Это необратимо ⚠️.

---

## Миграции

Все миграции идемпотентны и выполняются при старте.

### 1. JSON → SQLite (метаданные)

Условие: `meta.json_migrated !== "1"` и существуют `users.json`/`projects.json`/
`changes.json`/`data/telemetry/`.

Порядок:

1. Создаётся `data/backup-pre-sqlite-<timestamp>/` и копируются исходные JSON + `README.txt`.
2. В одной транзакции вставляются пользователи, проекты, записи журнала, телеметрия.
3. `trimChanges()` и `trimTelemetry()` приводят объёмы к лимитам.
4. `json_migrated=1`, `json_migrated_at=<ISO>`.
5. JSON **не удаляются** — остаются архивом.

### 2. JSON-документы → `documents`

Условие: `meta.docs_migrated !== "1"`.

1. Копия существующих файлов в `data/backup-pre-docs-<timestamp>/`.
2. Для каждого имени из `DOC_FILES`, если файла ещё нет в таблице — `INSERT OR IGNORE`.
3. `docs_migrated=1`, `docs_migrated_at=<ISO>`.

### 3. OCR-кэш: ключи `projectId::rel` → SHA-1

Выполняется при каждом старте (`migrateOcrCacheIfNeeded`), но работу делает только при
наличии старых ключей:

- ключ разбирается на `projectId` и `rel`;
- если проект/файл не найден, слишком большой или не читается — запись удаляется;
- иначе вычисляется SHA-1 и запись переносится под новый ключ.

### 4. Схема

`schema_version` сейчас `2`. При изменении схемы добавляйте `CREATE TABLE IF NOT EXISTS`
и запись новой версии — отдельного migration-runner нет.

---

## Экспорт и импорт метаданных

`GET /api/admin/export` отдаёт снимок:

```json
{ "app":"darkarmy-dossier","version":1,"exportedAt":"…",
  "users":[…],"projects":[…],
  "documents": { "settings":{…}, "invites":{…}, "…":"…" } }
```

Чего в снимке **нет**: журнала изменений, телеметрии, сессий, уведомлений, файлов проектов,
вложений, OCR/embedding-кэшей. Это «метаданные конфигурации», а не полный бэкап.

`POST /api/admin/import`:

```json
{ "confirm": "REPLACE", "mode": "replace", "snapshot": { … } }
```

- `confirm` обязателен и равен строке `REPLACE`;
- `mode` — `replace` (по умолчанию) или `merge`;
- проверки: `app === "darkarmy-dossier"`, `version === 1`, непустой список пользователей,
  наличие хотя бы одного `role: "admin"`, корректность `id`/`username` пользователей и
  `id` проектов;
- запись выполняется одной транзакцией; `replace` очищает `users`, `projects`, `documents`;
- ответ `{ok, mode, users, projects, documents}`; ошибки — `400` с текстом.

⚠️ Импорт **заменяет** пользователей: после `replace` ваша текущая сессия может стать
недействительной, если такого пользователя в снимке нет.

---

## Резервное копирование и восстановление

### Штатный бэкап

```bash
npm run backup                         # в ../backups, 7 копий, с проектами
node scripts/backup.js --keep 14       # хранить 14 копий
node scripts/backup.js --no-projects   # только метаданные
node scripts/backup.js --dest D:\backups --projects-root D:\Projects
```

Что делает `scripts/backup.js`:

1. Читает `.env` (явные переменные окружения приоритетнее).
2. `backup(db, dest/dossier.db)` — консистентная копия SQLite через backup API
   (безопасно при работающем сервере).
3. Копирует `DATA_DIR` (кроме `dossier.db*` и `tmp/`) в `dest/data`.
4. Копирует `PROJECTS_ROOT` в `dest/projects` (если не `--no-projects`).
5. Пишет `manifest.json` (`createdAt`, `dataDir`, `projectsRoot`, `node`) и удаляет
   старые копии сверх `--keep`.

### Восстановление

```bash
# 1. Остановить сервис
sudo systemctl stop darkarmy-dossier        # Linux
# Windows: Stop-ScheduledTask -TaskName "DarkArmy Dossier"

# 2. Сохранить текущее состояние (на всякий случай)
mv data data.broken-$(date +%s)

# 3. Развернуть бэкап
cp -a /opt/backups/<timestamp>/data ./data
cp -a /opt/backups/<timestamp>/projects/* /srv/darkarmy-projects/
cp /opt/backups/<timestamp>/dossier.db ./data/dossier.db

# 4. Запустить и проверить
sudo systemctl start darkarmy-dossier
curl -fsS http://127.0.0.1:7561/api/health
```

Проверка целостности (если установлен `sqlite3`):

```bash
sqlite3 data/dossier.db "PRAGMA integrity_check;"
sqlite3 data/dossier.db "SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM projects;"
```

Только SQLite без `sqlite3` CLI:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/dossier.db');console.log(db.prepare('PRAGMA integrity_check').get());db.close()"
```

Правила:

- нельзя копировать `dossier.db` при работающем сервере без `-wal`/`-shm` — получите
  несогласованный снимок; используйте `npm run backup` или остановите сервис;
- после восстановления проверьте `PROJECTS_ROOT` и права (`darkarmy:darkarmy`);
- раз в месяц обязательно прогоняйте восстановление на тестовой копии.

---

## Практические запросы

```bash
# Пользователи (без хешей)
node -e "const s=require('./src/storage');s.init({dir:'./data'});console.log(s.getUsers().map(u=>({u:u.username,r:u.role})));s.close()"

# Проекты и участники
node -e "const s=require('./src/storage');s.init({dir:'./data'});console.log(s.getProjects().map(p=>({id:p.id,name:p.name,members:p.members.length})));s.close()"

# Последние 20 записей журнала
node -e "const s=require('./src/storage');s.init({dir:'./data'});console.log(s.queryChanges({limit:20}));s.close()"

# Документ bugs (баг-репорты)
node -e "const s=require('./src/storage');s.init({dir:'./data'});console.log(JSON.stringify(s.getDoc('bugs',{items:[]}),null,2));s.close()"

# Статистика
node -e "const s=require('./src/storage');s.init({dir:'./data'});console.log(s.stats());s.close()"

# Список таблиц (sqlite3)
sqlite3 data/dossier.db ".tables"
```

---

## См. также

- [01-architecture.md](01-architecture.md) — как данные используются компонентами.
- [04-api.md](04-api.md) — маршруты, читающие и пишущие эти данные.
- [06-ai-darcus.md](06-ai-darcus.md) — `ai-config.json`, кэши OCR/embeddings.
- [08-security.md](08-security.md) — права на `data/` и секреты.
- [10-deployment-ubuntu.md](10-deployment-ubuntu.md) — бэкап и восстановление на сервере.
- [11-troubleshooting.md](11-troubleshooting.md) — «database is locked» и повреждения.
- [13-admin-guide.md](13-admin-guide.md) — экспорт/импорт и дашборд в UI.
