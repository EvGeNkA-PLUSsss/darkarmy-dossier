# 04. API

## Содержание

1. [Общие соглашения](#общие-соглашения)
2. [Аутентификация и сессии](#аутентификация-и-сессии)
3. [Коды ошибок](#коды-ошибки)
4. [Rate limit](#rate-limit)
5. [Служебные маршруты](#служебные-маршруты)
6. [Аккаунт и подписка](#аккаунт-и-подписка)
7. [Проекты и участники](#проекты-и-участники)
8. [Файлы и папки](#файлы-и-папки)
9. [Загрузка, вложения, share](#загрузка-вложения-share)
10. [Совместное редактирование](#совместное-редактирование)
11. [Поиск](#поиск)
12. [История версий](#история-версий)
13. [Чаты и поддержка](#чаты-и-поддержка)
14. [Задачи](#задачи)
15. [Запросы и жалобы](#запросы-и-жалобы)
16. [Уведомления](#уведомления)
17. [Darcus (ИИ)](#darcus-ии)
18. [Админ-панель и эксплуатация](#админ-панель-и-эксплуатация)
19. [Реклама](#реклама)
20. [Подписки (админ)](#подписки-админ)
21. [Баг-репорты](#баг-репорты)
22. [SSE: `GET /api/events`](#sse-get-apievents)
23. [См. также](#см-также)

---

## Общие соглашения

| Свойство | Значение |
|---|---|
| Базовый URL | `http://127.0.0.1:7561` (или ваш домен) |
| Формат | JSON (`Content-Type: application/json`), кроме загрузок (multipart) и файлов |
| Кодировка | UTF-8 |
| Cookie | `sid` (httpOnly, SameSite=strict, `secure` в production, срок 7 дней) |
| Версионирование API | нет (пути стабильны в рамках 1.x) |
| Ошибки | `{ "error": "<код или текст>" }` + соответствующий HTTP-статус |
| CSRF-токены | **не используются** ❌ — защита строится на `SameSite=strict` + `httpOnly` |
| CORS | не настроен: API предполагает same-origin |

Пример запроса с cookie:

```bash
curl -c cookies.txt -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<пароль>"}' \
  http://127.0.0.1:7561/api/login

curl -b cookies.txt http://127.0.0.1:7561/api/me
```

Middleware, общие для всех `/api/*`:

1. `express.json({limit:'20mb'})`, `express.urlencoded`.
2. `express-session` с SQLite-store.
3. Загрузка `req.user` из сессии + проверка бана (забаненный получает `403 banned`
   и сессия уничтожается).
4. Access-log (кроме статики и 304) + телеметрия.
5. Security-заголовки: `X-Content-Type-Options`, `X-Frame-Options: DENY`,
   `Referrer-Policy`, `Permissions-Policy`, `COOP`, `CORP`, `X-Robots-Tag`,
   `Strict-Transport-Security` (в production), CSP для HTML.

---

## Аутентификация и сессии

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| `POST` | `/api/login` | публично | вход по логину/паролю |
| `POST` | `/api/register` | публично | регистрация по инвайт-коду |
| `POST` | `/api/logout` | любой | выход, уничтожение сессии |
| `GET` | `/api/me` | любой | текущий пользователь или `null` |

### `POST /api/login`

```json
{ "username": "admin", "password": "<пароль>" }
```

Ответ `200`:

```json
{ "user": { "id": "uuid", "username": "admin", "role": "admin" }, "theme": "dark" }
```

| Статус | Причина |
|---|---|
| `400` | не переданы логин или пароль (`{"error":"missing"}`) |
| `401` | неверная пара (`{"error":"invalid"}`) |
| `403` | бан: `{"error":"banned","reason":"…","until":"ISO или null"}` |
| `429` | превышен лимит попыток |

Особенности: при несуществующем пользователе всё равно выполняется bcrypt-сравнение
с фиктивным хешем (защита от тайминг-атак), затем `session.regenerate`.

### `POST /api/register`

```json
{ "username": "evgen", "password": "<пароль>", "inviteCode": "ABCD2345XY" }
```

Успех `200`: `{ "user": {...}, "theme": "dark" }` (сессия создаётся сразу).

| Статус | Причина |
|---|---|
| `400` | пустые поля / неверный логин / слабый пароль (текст ошибки) |
| `404` | код не найден |
| `409` | код использован или логин занят |
| `429` | >15 попыток регистрации в час |

### `GET /api/me`

```json
{ "user": { "id":"…", "username":"evgen", "role":"member" }, "theme": "dark", "muted": false }
```

Неавторизованный: `{ "user": null }` (200).

### `POST /api/logout`

Ответ: `{ "ok": true }`, cookie `sid` очищается.

---

## Коды ошибок

| HTTP | `error` | Когда |
|---|---|---|
| 400 | `missing`, `bad input`, `bad path`, `bad theme`, `bad mode`, `bad limit`, `bad role`, русский текст | неверные параметры |
| 401 | `unauthorized` | нет сессии |
| 401 | `invalid` | неверный пароль при входе |
| 403 | `forbidden` | нет прав (роль/проект/чужой объект) |
| 403 | `banned` | активный бан |
| 403 | `muted` | мьют, попытка писать в общий чат |
| 403 | `chat-disabled` | общий чат только для администраторов |
| 403 | `subscription-required` | нужна подписка для Darcus |
| 404 | `not found`, `project not found`, `user not found`, `file not found` | объект не существует |
| 409 | `Код уже использован`, `Логин занят`, `Уже в проекте`, `Папка уже существует`, `На исходном месте уже есть файл` | конфликт |
| 410 | `session ended` | сессия редактирования завершена |
| 413 | `Слишком большой файл/запрос`, `too big`, `too long` | превышен лимит |
| 429 | текст лимита | rate-limit |
| 500 | `internal error` / текст | внутренняя ошибка |
| 502 | ошибка модели | Darcus вернул пустой документ/не смог обработать изображение |
| 503 | `degraded` (только `/api/health`) | не все проверки прошли |

Общий обработчик ошибок (`app.use((err,…))`) для `/api/*` возвращает
`{error, code}`; `413`/`400` маппятся в человекочитаемые строки.

---

## Rate limit

Ключ лимита — `u:<username>` для авторизованных, иначе `ip:<ip>`.

| Лимитер | Окно | Максимум | Где |
|---|---|---|---|
| `rateLimitLogin` | 15 мин | `LOGIN_MAX_ATTEMPTS` (10) | `/api/login` |
| `rateLimitRegister` | 60 мин | 15 | `/api/register` |
| `rateLimitDarcus` | 60 с | 20 | `/api/darcus/*`, `/api/admin/voice`-тесты, config |
| `rateLimitExpensive` | 60 с | 30 | `/api/search*` |
| `rateLimitUpload` | 60 с | 30 | `/api/upload` |
| `rateLimitTranscribe` | 60 с | 10 | `/api/darcus/transcribe` |
| `rateLimitBug` | 60 с | 6 | `POST /api/bugs` |
| `rateLimitShareAccess` | 60 с | 60 | `GET /s/:token` |
| `rateLimitBackup` | 60 с | 3 | `POST /api/admin/backup` |
| `rateLimitImport` | 5 мин | `IMPORT_MAX_ATTEMPTS` (2) | `POST /api/admin/import` |

---

## Служебные маршруты

| Метод | Путь | Доступ | Ответ |
|---|---|---|---|
| `GET` | `/api/health` | публично | `{status, uptimeSec, checks{dataDir,projectsRoot,users,db}}`, 200/503 |
| `GET` | `/api/version` | публично | `{version, build, assets}` (no-store) |
| `GET` | `/files/:projectId/*filePath` | auth + чтение проекта | файл по allow-list |
| `GET` | `/s/:token` | публично | файл по share-ссылке |
| `GET` | `/` и статика | публично | SPA (`public/`) |

`/api/health`:

```json
{ "status": "ok", "uptimeSec": 3600,
  "checks": { "dataDir": true, "projectsRoot": true, "users": true, "db": true } }
```

Если хоть одна проверка `false` — `503` и `status: "degraded"` (используется мониторингом).

---

## Аккаунт и подписка

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| `PATCH` | `/api/account/theme` | auth | `{theme:"dark"\|"light"}` | `{ok:true}` |
| `POST` | `/api/account/password` | auth | `{current,next}` | `{ok:true}` |
| `DELETE` | `/api/account` | auth | `{password}` | `{ok:true}` |
| `POST` | `/api/telemetry/client` | auth | объект клиентских данных | `{ok:true}` |
| `GET` | `/api/me/subscription` | auth | — | `{active,until,grantedBy,forceAdmin}` |
| `POST` | `/api/me/subscription/activate` | auth | `{code}` | `{ok:true,until}` |

`POST /api/telemetry/client` принимает: `screen, viewport, lang, langs, tz, tzOffset,
platform, referrer, ua, cores, memory, touch, online, connType, downlink, rtt,
colorScheme, reducedMotion, dnt, cookies, pwa`. Все строки обрезаются до 200 символов.

`DELETE /api/account`:
- `400` — нет пароля или попытка удалить последнего администратора;
- `401` — неверный пароль;
- успех — сессия уничтожается.

---

## Проекты и участники

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| `GET` | `/api/projects` | auth | список доступных проектов |
| `POST` | `/api/projects` | auth | создать проект |
| `GET` | `/api/projects/:projectId` | чтение | проект с участниками |
| `PATCH` | `/api/projects/:projectId` | управление | переименовать |
| `DELETE` | `/api/projects/:projectId` | **admin** | удалить проект и папку |
| `POST` | `/api/projects/:projectId/members` | управление | добавить участника |
| `PATCH` | `/api/projects/:projectId/members/:username` | управление | сменить роль |
| `DELETE` | `/api/projects/:projectId/members/:username` | управление | удалить участника |
| `GET` | `/api/projects/:projectId/activity` | управление | журнал проекта |
| `GET` | `/api/projects/:projectId/meta` | чтение | теги и избранное |
| `POST` | `/api/projects/:projectId/favorite` | чтение | переключить избранное |
| `POST` | `/api/projects/:projectId/tags` | чтение | задать теги |

`GET /api/projects`:

```json
{ "projects": [
  { "id":"default","name":"Основной","creator":"admin","createdAt":"…",
    "myRole":"admin","membersCount":2 } ] }
```

`POST /api/projects` — `{name}` (до 100 символов). Ответ:
`{ "ok": true, "project": { "id":"uuid","name":"…","creator":"…" } }`.
Папка проекта — `PROJECTS_ROOT/<id>`.

`POST /api/projects/:projectId/members` — `{username, role}` где role ∈
`member|editor|creator`. Побочные эффекты: SSE `project-update` участнику и уведомление
«Вас добавили в проект».

`GET /api/projects/:projectId/activity?limit=50` — `{entries:[…]}` (без `before/after`).

`POST …/favorite` — `{path}`, ответ `{ok:true, favorite:boolean}`.
`POST …/tags` — `{path, tags:[…]}` (до 8 тегов, каждый до 40 символов), ответ `{ok:true,tags}`.

Права:

| Уровень | Кто |
|---|---|
| чтение | участник проекта или admin сайта |
| редактирование | `editor`, `creator` или admin сайта |
| управление | `creator` или admin сайта |

---

## Файлы и папки

Все маршруты требуют `projectId` (body/query/path) и проверяются `projectGuard`.

| Метод | Путь | Право | Тело/Query | Ответ |
|---|---|---|---|---|
| `GET` | `/api/tree` | чтение | `?projectId` | `{tree:[…]}` |
| `GET` | `/api/raw` | чтение | `?projectId&path` | `text/plain` |
| `POST` | `/api/create` | edit | `{projectId,dir,name}` | `{ok,path,existed?}` |
| `POST` | `/api/mkdir` | edit | `{projectId,dir,name}` | `{ok,path}` |
| `POST` | `/api/rename` | edit | `{projectId,path,newName}` | `{ok,path}` |
| `POST` | `/api/write` | edit | `{projectId,file,content}` | `{ok,path}` |
| `DELETE` | `/api/delete` | edit | `?projectId&path` | `{ok,trashId}` |
| `POST` | `/api/move` | edit | `{projectId,from,to,targetProjectId?}` | `{ok,path,projectId,projectName,movedToProject}` |
| `GET` | `/api/resolve` | чтение | `?projectId&from&name` | `{path}` |
| `GET` | `/api/trash` | чтение | `?projectId` | `{items,retentionDays}` |
| `POST` | `/api/trash/:id/restore` | edit | — | `{ok:true}` |
| `DELETE` | `/api/trash/:id` | edit | — | `{ok:true}` |

Дерево (`GET /api/tree`):

```json
{ "tree": [
  { "name":"docs","path":"docs","isDir":true,"children":[
      { "name":"readme.md","path":"docs/readme.md","isDir":false } ] },
  { "name":"заметка.md","path":"заметка.md","isDir":false } ] }
```

Сортировка: папки раньше файлов, внутри — по имени. Скрытые (`.…`) элементы исключены.

Создание файла:
- имя без `.md` дополняется; недопустимые символы `<>:"|?*` и управляющие заменяются на `_`;
- если файл существует — `{ok:true, path, existed:true}` (не ошибка);
- содержимое нового файла — `# <Имя>\n\n`.

`POST /api/write` — только текстовые расширения (см. `TEXT_EXT` в `src/util.js`),
контент до 5 МБ; пишет файл и запись `edit` в журнал. Используется Darcus.

Перемещение:
- `targetProjectId` позволяет перенести в другой проект (нужно право edit на оба);
- при коллизии имени добавляется ` (1)`, ` (2)`;
- перемещение корня проекта запрещено (`400`);
- ссылки в Markdown обновляются автоматически (до 3 000 файлов).

`DELETE /api/delete` — soft-delete: файл/папка переименовывается в
`PROJECTS_ROOT/<folder>/.trash/<trashId>__<name>`, метаданные — в документ `trash`.
`GET /api/trash` попутно чистит записи старше 14 дней и удаляет их с диска.

`GET /api/resolve` ищет файл по имени: сначала в `from` и типовых подпапках
(`attachments`, `_attachments`, `images`, `files`, `Вложения`, `att`), затем рекурсивно
до 6 уровней. Ответ `{path}` или `404`.

---

## Загрузка, вложения, share

### `POST /api/upload`

`multipart/form-data`: `file` (обязательно), `dir` (папка назначения), `projectId`.

Ответ: `{ "ok": true, "path": "docs/отчёт.docx" }`.

| Статус | Причина |
|---|---|
| `400` | файл не получен / ошибка multer |
| `403` | нет права edit / плохой путь |
| `413` | превышен лимит участника (текст: «Файл X МБ превышает лимит N МБ.») или жёсткий лимит 2 ГБ |
| `429` | >30 загрузок в минуту |

### `POST /api/chat/attach`

`multipart/form-data`: `file`, `scope` (`general` | `project:<id>` | `ticket:<id>`).

Ответ:

```json
{ "id":"uuid","name":"схема.png","size":12345,
  "kind":"image","mime":"image/png","url":"/api/chat/attach/uuid" }
```

Ограничения: 25 МБ; запрещены `exe,bat,cmd,sh,ps1,vbs,jar,msi,app,dll,scr,com,pif,hta,cpl`;
хранится до 5 000 вложений (старые удаляются вместе с файлами).

### `GET /api/chat/attach/:id`

Отдаёт файл, если пользователь: администратор, владелец, участник области
`project:<id>` или участник тикета `ticket:<id>` (для `general` — любой авторизованный).
Content-Type вычисляется по расширению (не по клиентскому MIME); изображения инлайн,
остальное — attachment; CSP `default-src 'none'`.

### `POST /api/projects/:projectId/attach-file`

Копирует вложение чата в проект: `{attachmentId, dir}`. Разрешено владельцу вложения,
участнику того же проекта (scope `project:<id>`) или админу. Ответ `{ok,path}`.

### Share-ссылки

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| `GET` | `/api/shares` | auth | — | `{items}` (свои; админ — все) |
| `POST` | `/api/shares` | чтение проекта | `{projectId,path,expiresInDays}` | `{ok,share,url}` |
| `DELETE` | `/api/shares/:id` | автор или админ | — | `{ok:true}` |
| `GET` | `/s/:token` | публично | — | файл / `404` / `410` |

`POST /api/shares` возвращает:

```json
{ "ok": true,
  "share": { "id":"…","token":"…","projectId":"…","path":"docs/a.pdf",
             "createdBy":"admin","createdAt":"…","expiresAt":"…","revoked":false,"accessCount":0 },
  "url": "/s/<token>" }
```

`expiresInDays` зажимается в 0…365; `0` — бессрочно. `GET /s/:token`:
`404` — нет/отозвана, `410` — истекла, иначе файл и инкремент `accessCount`.

---

## Совместное редактирование

| Метод | Путь | Право | Тело | Ответ |
|---|---|---|---|---|
| `POST` | `/api/edit/join` | edit | `{projectId,file,clientId}` | `{baseline,content,users,devices}` |
| `POST` | `/api/edit/change` | edit | `{projectId,file,content,clientId}` | `{ok:true}` |
| `POST` | `/api/edit/save` | edit | `{projectId,file,content,clientId}` | `{ok:true}` |
| `POST` | `/api/edit/leave` | edit | `{projectId,file,clientId}` | `{ok:true}` |

- `file` — только текстовые расширения (`md, markdown, txt, js, json, css, html, xml, csv, log,
  yml, yaml, ts, sh, env, ini, conf`).
- `content` — до 5 МБ.
- `clientId` — до 80 символов; различает вкладки/устройства одного пользователя.
- `join` создаёт сессию с baseline (текущее содержимое) и регистрирует `clientId`;
- `change` обновляет `content`, планирует запись через 500 мс и рассылает `edit-change`;
- `save` немедленно пишет файл, добавляет запись `edit` в журнал, снимает `clientId`
  и рассылает `edit-saved`; при отсутствии участников сессия удаляется;
- `leave` снимает `clientId`; если участников нет — сохраняет актуальный `content`
  (не baseline) и удаляет сессию.

Ошибки: `400` нет файла/плохой ввод, `403` нет прав, `404` файл не найден,
`410` сессия завершена, `413` слишком большой контент.

Подробно — [07-collaboration.md](07-collaboration.md).

---

## Поиск

| Метод | Путь | Доступ | Query | Ответ |
|---|---|---|---|---|
| `GET` | `/api/search` | чтение проекта | `?projectId&q` | `{results,query}` |
| `GET` | `/api/search-all` | auth | `?q` | `{results,query}` (до 150) |
| `GET` | `/api/search/entities` | auth | `?q` | `{query,projects,messages,tasks,users}` |

Элемент `results`:

```json
{ "path":"docs/report.md","name":"report.md","type":"file",
  "kwScore":0.7,"semScore":0.62,"score":0.81,
  "matchType":"content|name|both|image|semantic",
  "snippet":"…фрагмент…" }
```

`q` короче 2 символов → пустой результат. Учитываются права на проекты.
`/api/search-all` дополнительно возвращает `projectId` и `projectName`.

`/api/search/entities` — `projects[{id,name}]`, `messages[{chat,messageId,from,projectId,
projectName,text,timestamp}]`, `tasks[{taskId,projectId,projectName,text,done}]`,
`users[{username}]`.

---

## История версий

| Метод | Путь | Доступ | Query | Ответ |
|---|---|---|---|---|
| `GET` | `/api/files/:projectId/history` | чтение проекта | `?path&limit&offset` | `{path,entries,total,limit,offset}` |
| `GET` | `/api/files/:projectId/history/:changeId` | чтение проекта | — | `{version}` |
| `GET` | `/api/files/:projectId/history/:changeId/download` | чтение проекта | `?side=before\|after` | `text/plain` вложение |

`limit` 1…200 (по умолчанию 50), `offset` 0…100000. Список не содержит `before/after`.
`version` содержит `{id,timestamp,user,action,file,before,after,truncated}`.
Скачивание отдаёт `404`, если содержимой стороны нет.

Админский журнал:

| Метод | Путь | Доступ | Query |
|---|---|---|---|
| `GET` | `/api/changes` | **admin** | `?file&projectId&days&limit&offset&full=1` |
| `POST` | `/api/revert/:id` | **admin** | — |

`GET /api/changes` → `{entries,total,limit,offset}`; `full=1` включает `before/after`.
`POST /api/revert/:id` → `{ok:true}`; `400`, если запись уже откатана, содержимое
отредактировано/обрезано или тип не поддерживает откат.

---

## Чаты и поддержка

### Общий чат

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| `GET` | `/api/chat/general` | auth | — | `{messages}` (последние 300) |
| `POST` | `/api/chat/send` | auth, не мьют | `{text,attachments[]}` | `{ok,message}` |
| `DELETE` | `/api/chat/message/:id` | автор или admin | — | `{ok:true}` |

Сообщение: `{id,from,to:"general",text,attachments,timestamp}`. Текст до 4 000 символов,
вложений до 10. Сервер хранит 1 000 последних. SSE-событие `chat` / `chat-delete`.
При `generalChatMode = admins_only` обычный участник получает `403 chat-disabled`.

### Чат проекта

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| `GET` | `/api/chat/project/:projectId` | чтение | — | `{messages,tasks,project}` |
| `POST` | `/api/chat/project/:projectId/send` | чтение | `{text,attachments[]}` | `{ok,message}` |
| `DELETE` | `/api/chat/project/:projectId/message/:id` | автор/создатель/admin | — | `{ok:true}` |

Хранится до 3 000 сообщений; отдаются последние 300 сообщений и 100 задач.
SSE: `chat-project`, `chat-project-delete`, `project-task`.

### Поддержка (тикеты)

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| `GET` | `/api/tickets` | auth | — | `{tickets}` (свои; админ — все) |
| `POST` | `/api/tickets` | auth | `{text}` | `{ok,ticket}` |
| `GET` | `/api/tickets/:id` | автор или admin | — | `{ticket}` |
| `POST` | `/api/tickets/:id/messages` | автор или admin | `{text,attachments[]}` | `{ok,message}` |
| `POST` | `/api/tickets/:id/accept` | **admin** | — | `{ok,ticket}` |
| `POST` | `/api/tickets/:id/close` | **admin** | — | `{ok,ticket}` |

Тикет: `{id,from,subject,messages[],status,createdAt,acceptedBy?,closedBy?}`.
Сообщение: `{id,from,role:"user"|"support"|"system",text,attachments,timestamp}`.
Ответы в закрытый тикет — `400`.

---

## Задачи

| Метод | Путь | Право | Тело | Ответ |
|---|---|---|---|---|
| `GET` | `/api/projects/:projectId/tasks` | чтение | — | `{tasks}` |
| `POST` | `/api/projects/:projectId/tasks` | чтение | `{text,status?,assignee?,priority?,due?}` | `{ok,task}` |
| `PATCH` | `/api/projects/:projectId/tasks/:taskId` | чтение | `{text?,status?,done?,order?,assignee?,priority?,due?}` | `{ok,task}` |
| `DELETE` | `/api/projects/:projectId/tasks/:taskId` | автор/создатель/admin | — | `{ok:true}` |

Задача:

```json
{ "id":"uuid","text":"Проверить отчёт","done":false,"status":"todo",
  "order":0,"assignee":"evgen","priority":"normal","due":"2026-11-30",
  "createdBy":"admin","createdAt":"…","doneBy":null,"doneAt":null }
```

- `status` ∈ `todo|doing|done`; `priority` ∈ `low|normal|high`; `due` — `YYYY-MM-DD`.
- `{done:true}` без `status` поддерживается для совместимости (`done` → `done`, иначе `todo`).
- Максимум 500 задач на проект; SSE-событие `project-task` c `op: add|update|delete`.

---

## Запросы и жалобы

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| `GET` | `/api/requests` | **admin** | — | `{items}` (новые сверху) |
| `POST` | `/api/requests` | чтение проекта | `{projectId,text,file}` | `{ok,item}` |
| `POST` | `/api/requests/:id/close` | **admin** | — | `{ok:true}` |
| `POST` | `/api/reports` | чтение проекта | `{projectId,reason,file}` | `{ok:true}` |
| `GET` | `/api/reports` | **admin** | — | `{items}` |
| `POST` | `/api/reports/:id/resolve` | **admin** | — | `{ok:true}` |

Запрос: `{id,from,file,projectId,text,timestamp,status:"open"|"closed"}`.
Жалоба: `{id,from,reason,file,projectId,timestamp,status:"open"|"resolved"}`.
Оба требуют, чтобы файл существовал в проекте (`400 Файл не найден` иначе).
Админы получают SSE `request`/`report` и уведомления.

---

## Уведомления

| Метод | Путь | Доступ | Query/Тело | Ответ |
|---|---|---|---|---|
| `GET` | `/api/notifications` | auth | `?limit=30&unread=1` | `{items,unread}` |
| `GET` | `/api/notifications/unread-count` | auth | — | `{unread}` |
| `POST` | `/api/notifications/read-all` | auth | — | `{ok,changed}` |
| `POST` | `/api/notifications/:id/read` | auth | — | `{ok,notification}` |
| `DELETE` | `/api/notifications` | auth | — | `{ok:true}` |

Уведомление:

```json
{ "id":"uuid","username":"evgen","type":"mention|ticket|request|report|project|bug",
  "title":"Вас упомянули в чате","body":"admin: …","link":"chat:general",
  "projectId":null,"createdAt":"…","readAt":null }
```

`limit` 1…100. Хранится до 200 на пользователя.

---

## Darcus (ИИ)

### Конфигурация и диагностика

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| `GET` | `/api/darcus/styles` | auth | — | `{presets:{key:{label}}}` |
| `GET` | `/api/darcus/capabilities` | auth | — | `{stt,sttEngine,tts,ttsMode,lang}` |
| `GET` | `/api/darcus/config` | **admin** | — | полный `ai-config` |
| `PATCH` | `/api/darcus/config` | **admin** | `{ollama?,prompts?,search?,ocr?}` | `{ok,config}` |
| `POST` | `/api/darcus/test` | **admin** | — | `{ok,models[]|error}` |
| `GET` | `/api/darcus/models` | **admin** | — | `{ok,models:[{name,size}]}` |
| `POST` | `/api/darcus/reindex` | **admin** | — | `{ok,indexed,skipped,errors,total,model}` |

`PATCH /api/darcus/config` валидирует URL Ollama (`validateOllamaUrl`): только `http/https`,
запрещены `169.254.169.254` и `metadata.google.internal`, в production — приватные адреса,
если не задан `DARCUS_ALLOWED_HOSTS`.

### Чат

`POST /api/darcus/chat` — стриминговый ответ (Content-Type `text/event-stream`).

Запрос:

```json
{ "query": "сделай реферат по отчёту",
  "history": [ { "role": "user", "content": "…" } ],
  "projectId": "default",
  "chatId": "uuid или null",
  "attachments": [ { "name":"a.png","kind":"image","mime":"image/png",
                     "size":1234,"data":"<base64>","thumb":"data:image/png;base64,…" } ],
  "editingFile": "docs/report.md",
  "stylePreset": "formal",
  "voiceMode": false }
```

Ответ — поток SSE-блоков:

```
event: chunk
data: {"text":"Часть ответа"}

event: done
data: {"sources":[…],"web":[…],"wiki":[…],"context":{"used":1234,"limit":12288,"percent":10,"remaining":11054,"nearLimit":false}}

event: error
data: {"error":"…"}
```

Ошибки до открытия потока: `400 Пустой запрос`, `403 subscription-required`,
`413 Слишком длинный запрос`/`Вложение слишком большое`, `429`.

### Rewrite / summarize / generate

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| `POST` | `/api/darcus/rewrite` | auth + подписка | `{mode,text,file?,projectId?,lang?}` | `{ok,text}` |
| `POST` | `/api/darcus/summarize` | auth + подписка | `{projectId,path}` | `{ok,item,cached?}` |
| `POST` | `/api/darcus/generate-doc` | auth + подписка | `{prompt,template?,projectId,dir?,name}` | `{ok,path}` |

- `mode` ∈ `rephrase|shorten|fix|translate`; `text` до 8 000 символов.
- `summarize` → `{tldr,points[],entities[],analyzedAt}`; кэш 24 часа по SHA-1;
  `413` для файлов >20 МБ, `400` для неподдерживаемых форматов или пустого текста.
- `generate-doc` требует право edit в проекте; имя нормализуется, при коллизии — ` (1)`;
  `502`, если модель вернула пустой документ.

### TTS / STT / изображения

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| `POST` | `/api/darcus/tts` | auth | `{text,voice?,format?}` | аудио (`audio/wav` и др.) |
| `POST` | `/api/darcus/transcribe` | auth | raw `audio/*` до 10 МБ | `{ok,text}` |
| `GET` | `/api/darcus/image-info` | чтение проекта | `?projectId&path` | `{item}` или `{item:null}` |
| `POST` | `/api/darcus/image-analyze` | auth + подписка | `{projectId,path}` | `{ok,item}` |

- `tts`: текст до 5 000 символов, кэш `private, max-age=3600`; `500`, если TTS не настроен.
- `transcribe`: `Content-Type: audio/webm` (или `application/octet-stream`), до 10 МБ,
  10 запросов/мин; `400 no audio`, `500` при ошибке движка.
- `image-analyze`: PNG/JPG/GIF/WEBP/BMP; результат `{text,description,boxes[],analyzedAt}`,
  кэшируется по SHA-1; `502`, если модель не смогла обработать.

### Чаты Darcus

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| `GET` | `/api/darcus/chats` | auth | — | `{chats}` (без сообщений) |
| `POST` | `/api/darcus/chats` | auth | — | `{chat}` или `{chat,reused:true}` |
| `GET` | `/api/darcus/chats/:id` | auth | — | `{chat}` |
| `PATCH` | `/api/darcus/chats/:id` | auth | `{title}` | `{ok,chat}` |
| `DELETE` | `/api/darcus/chats/:id` | auth | — | `{ok:true}` |
| `DELETE` | `/api/darcus/chats` | auth | — | `{ok,removed}` |

Чат: `{id,title,createdAt,updatedAt,messages[],context?,visionContext?}`.
Хранится до 200 сообщений на чат; первый вопрос становится заголовком (до 60 символов).
Пустой «Новый чат» не дублируется.

### Голос (админ)

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| `GET` | `/api/admin/voice` | **admin** | — | `{whisper,tts,sileroHealthy,sileroPid}` |
| `PATCH` | `/api/admin/voice` | **admin** | `{whisper?,tts?}` | `{ok,whisper,tts}` |
| `POST` | `/api/admin/voice/install` | **admin** | `{target:"whisper"\|"silero"}` | `{ok,target,log}` |

`PATCH` принимает для whisper: `engine,binaryPath,modelPath,model,pythonPath,language`;
для tts: `url,voice,format`. `install/whisper` выполняет `pip install faster-whisper`,
`install/silero` проверяет `:8765/health` и при необходимости запускает Python-сервер.

---

## Админ-панель и эксплуатация

| Метод | Путь | Доступ | Тело/Query | Ответ |
|---|---|---|---|---|
| `GET` | `/api/admin/dashboard` | **admin** | — | состояние системы |
| `POST` | `/api/admin/backup` | **admin** | `{projects?:true}` | `{ok,output,backups}` |
| `GET` | `/api/admin/export` | **admin** | — | JSON-снимок (attachment) |
| `POST` | `/api/admin/import` | **admin** | `{confirm:"REPLACE",mode,snapshot}` | `{ok,mode,users,projects,documents}` |
| `GET` | `/api/telemetry` | **admin** | — | `{users:[{username,events,lastSeen,lastClient}]}` |
| `GET` | `/api/telemetry/:username` | **admin** | — | `{telemetry:{events,firstSeen,lastSeen}}` |
| `POST` | `/api/telemetry/:username/clear` | **admin** | — | `{ok:true}` |
| `GET` | `/api/users` | **admin** | — | `{users}` (без хешей) |
| `POST` | `/api/users` | **admin** | `{username,password,role}` | `{user}` |
| `PATCH` | `/api/users/:id` | **admin** | `{role?,password?}` | `{ok:true}` |
| `DELETE` | `/api/users/:id` | **admin** | — | `{ok:true}` |
| `GET` | `/api/invites` | **admin** | — | `{items}` |
| `POST` | `/api/invites/generate` | **admin** | `{count,note}` | `{ok,created}` |
| `POST` | `/api/invites` | **admin** | `{code,note}` | `{ok,entry}` |
| `DELETE` | `/api/invites/:code` | **admin** | — | `{ok:true}` |
| `GET` | `/api/punishments` | **admin** | — | `{items}` |
| `GET` | `/api/punishments/:username` | **admin** | — | `{items,active,banned,muted}` |
| `POST` | `/api/punishments` | **admin** | `{username,type,reason,duration}` | `{ok,item}` |
| `DELETE` | `/api/punishments/:id` | **admin** | — | `{ok:true}` |
| `GET` | `/api/settings` | auth | — | `{uploadLimitMB,generalChatMode}` |
| `PATCH` | `/api/settings` | **admin** | `{uploadLimitMB?,generalChatMode?}` | `{ok,settings}` |

`/api/admin/dashboard`:

```json
{ "status":"ok","env":"production","node":"v24.x","uptimeSec":123,
  "storage":{"dbFile":"…","sizeBytes":1234567,"users":2,"projects":6,"changes":106,
             "telemetry":5067,"notifications":12,"documents":15,"sessions":3,
             "schemaVersion":2,"jsonMigratedAt":"…"},
  "sizes":{"db":…,"log":…,"embeddings":…,"ocrCache":…,"attachments":…,"projects":…,"backups":…},
  "backups":[{"name":"2026-11-25T…","sizeBytes":…,"createdAt":"…","withProjects":true}],
  "ai":{"reachable":true,"error":null,"url":"http://localhost:11434",
        "models":[{"role":"Чат","key":"chatModel","name":"gemma4:e4b","required":true,"installed":true}]} }
```

Правила:
- `POST /api/admin/backup` запускает `scripts/backup.js --dest <BACKUP_DIR>` (`--no-projects`,
  если `projects !== true`); таймаут 180 с; `500` с текстом ошибки.
- `POST /api/admin/import` требует `confirm: "REPLACE"`; проверяет `app`, `version`,
  наличие администратора и корректность записей; `400` с текстом.
- `POST /api/punishments`: `duration` — миллисекунды строкой или `forever`;
  нельзя наказать себя; при бане активные SSE-сессии пользователя получают `banned` и рвутся.
- `PATCH /api/users/:id`: нельзя снять роль с последнего администратора.
- `DELETE /api/users/:id`: нельзя удалить себя и последнего администратора.
- `GET /api/settings`: для администратора `uploadLimitMB: null` (лимит не применяется).
- `PATCH /api/settings`: `uploadLimitMB` 1…100000; `generalChatMode` ∈ `everyone|admins_only`.

---

## Реклама

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| `GET` | `/api/ads/serve` | auth | — | `{slots,images,distribution}` |
| `GET` | `/api/ads/admin/list` | **admin** | — | то же |
| `POST` | `/api/ads/upload` | **admin** | multipart `file` | `{ok,image}` |
| `PATCH` | `/api/ads/images/:id` | **admin** | `{enabled?,allSlots?}` | `{ok,image}` |
| `DELETE` | `/api/ads/images/:id` | **admin** | — | `{ok:true}` |
| `PATCH` | `/api/ads/slots` | **admin** | `{slots:{name:{enabled,interval}}}` | `{ok,slots}` |
| `GET` | `/api/ads/file/:filename` | auth | — | изображение |

Слоты по умолчанию: `topbar`, `sidebar-top`, `sidebar-bottom`, `chat-top`, `filebar`,
`empty-viewer`. Картинки: PNG/JPG/GIF/WEBP/SVG до 5 МБ, до 5 000 штук; распределение —
round-robin по включённым слотам, `allSlots` дублирует картинку во все слоты.

---

## Подписки (админ)

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| `GET` | `/api/subscriptions` | **admin** | — | `{active,codes}` |
| `POST` | `/api/subscriptions` | **admin** | `{username,days,note?}` | `{ok:true}` |
| `DELETE` | `/api/subscriptions/:username` | **admin** | — | `{ok:true}` |
| `POST` | `/api/subscriptions/codes/generate` | **admin** | `{count,days,note?}` | `{ok,created}` |
| `DELETE` | `/api/subscriptions/codes/:code` | **admin** | — | `{ok:true}` |

Код имеет вид `DAI-XXXXXXXXXX`; `days` ≥ 1 (по умолчанию 30); `count` 1…50.

---

## Баг-репорты

| Метод | Путь | Доступ | Тело | Ответ |
|---|---|---|---|---|
| `POST` | `/api/bugs` | auth | `{description,page,screenshot?}` | `{ok,id}` |
| `GET` | `/api/bugs` | **admin** | — | `{items,total}` |
| `GET` | `/api/bugs/:id/screenshot` | **admin** | — | изображение (no-store) |
| `PATCH` | `/api/bugs/:id` | **admin** | `{description?,page?,screenshot?}` | `{ok,item}` |
| `DELETE` | `/api/bugs/:id` | **admin** | — | `{ok:true}` |

`screenshot` — data URL `data:image/(png|jpeg|webp);base64,…` до 3 МБ.
Элемент списка: `{id,user,description,page,createdAt,hasScreenshot,screenshotUrl}`.
Лимит отправки — 6/мин; хранится до 300 записей.

---

## SSE: `GET /api/events`

| Свойство | Значение |
|---|---|
| Доступ | auth |
| Заголовки ответа | `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no` |
| Начало | `retry: 3000`, затем `event: hello` `{user}` |
| Heartbeat | комментарий `: ping` каждые 25 с |
| Лимит | 5 потоков на пользователя (старые закрываются) |

События:

| `event` | `data` | Когда |
|---|---|---|
| `hello` | `{user}` | установка соединения |
| `banned` | `{}` | пользователя забанили (поток закрывается) |
| `chat` | `{message}` | новое сообщение общего чата |
| `chat-delete` | `{messageId}` | удалено сообщение общего чата |
| `chat-project` | `{projectId,message}` | сообщение проектного чата |
| `chat-project-delete` | `{projectId,messageId}` | удалено сообщение проекта |
| `project-task` | `{projectId,task?,taskId?,op}` | `op` = `add`/`update`/`delete` |
| `edit-change` | `{key,projectId,file,content,from,fromClientId}` | правка в совместной сессии |
| `edit-users` | `{key,projectId,file,users,devices}` | состав редакторов изменился |
| `edit-saved` | `{key,projectId,file,by}` | файл сохранён |
| `notification` | `{notification}` | новое уведомление |
| `request` | `{item}` | новый запрос на изменение (админам) |
| `report` | `{item}` | новая жалоба (админам) |
| `ticket-new` | `{ticket}` | новый тикет (админам) |
| `ticket-message` | `{ticketId,message}` | сообщение в тикете |
| `ticket-status` | `{ticketId,status}` | смена статуса тикета |
| `project-update` | `{projectId}` | состав/роль проекта изменились |

Формат кадра:

```
event: edit-users
data: {"key":"default::docs/a.md","projectId":"default","file":"docs/a.md","users":["admin"],"devices":1}

```

Клиент (`public/app.js`) пересоздаёт `EventSource` через 5 секунд, если поток закрыт.

---

## См. также

- [03-user-guide.md](03-user-guide.md) — те же функции глазами пользователя.
- [05-data-model.md](05-data-model.md) — что именно хранится в БД.
- [06-ai-darcus.md](06-ai-darcus.md) — параметры Darcus и промпты.
- [07-collaboration.md](07-collaboration.md) — `edit/*` и SSE-события.
- [08-security.md](08-security.md) — права, лимиты, CSRF/сессии.
- [13-admin-guide.md](13-admin-guide.md) — админские маршруты в интерфейсе.
- [11-troubleshooting.md](11-troubleshooting.md) — ошибки API на практике.

---

## Новые маршруты (2026-11-26)

| Метод | Маршрут | Доступ | Описание |
|---|---|---|---|
| GET | `/api/darcus/knowledge` | requireAuth | статистика RAG-инструкций `{knowledge:{files,chunks,docs},admin}` |
| PATCH | `/api/bugs/:id` | requireSelfAdmin | редактирование описания/скриншота бага; body `{description?, page?, screenshot?}` |

ACTION-типы клиента: `open` (`path`), `task` (`text`, `assignee?`, `priority?`, `due?`, `status?`),
`search` (`query`). Остальные (`create`, `edit`, `mkdir`, `delete`, `move`, `rename`,
`generate_doc`) — как раньше.

Офлайн-режим: клиент наполняет Cache Storage `da-offline-v1` через `/api/projects`,
`/api/tree`, `/api/projects/:id/tasks` и `/files/:project/:path`; серверных изменений нет.
