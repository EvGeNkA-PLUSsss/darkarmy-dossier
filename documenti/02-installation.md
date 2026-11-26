# 02. Установка

## Содержание

1. [Что понадобится](#что-понадобится)
2. [Установка на Windows: пошагово](#установка-на-windows-пошагово)
3. [Node.js 24](#nodejs-24)
4. [Ollama и модели](#ollama-и-модели)
5. [Python 3.10, Silero TTS и faster-whisper](#python-310-silero-tts-и-faster-whisper)
6. [Файл `.env`: все переменные](#файл-env-все-переменные)
7. [Первый запуск](#первый-запуск)
8. [HTTPS-сертификат для микрофона](#https-сертификат-для-микрофона)
9. [Доступ из локальной сети](#доступ-из-локальной-сети)
10. [Проверка установки](#проверка-установки)
11. [Установка на Linux/macOS (кратко)](#установка-на-linuxmacos-кратко)
12. [См. также](#см-также)

---

## Что понадобится

| Компонент | Версия | Обязателен | Назначение |
|---|---|---|---|
| Node.js | **20+**, рекомендуется **24 LTS** | да | сервер |
| npm | идёт с Node | да | зависимости |
| Ollama | актуальная | для Darcus | локальные модели |
| Python | **3.10–3.12** | для голоса | Silero TTS, faster-whisper |
| torch + numpy | CPU-сборка | для Silero | синтез речи |
| faster-whisper | актуальная | для STT | распознавание речи |
| ffmpeg | опционально | для STT | декодирование некоторых форматов |
| Каталог файлов | любой диск | да | `PROJECTS_ROOT` |

Минимальные требования: 2 ГБ RAM без ИИ; 8+ ГБ RAM при работе Ollama с 3–4B моделями;
место на диске — под проекты, кэш эмбеддингов и бэкапы.

---

## Установка на Windows: пошагово

```powershell
# 1. Каталог проекта
cd F:\DarkArmy\DarkArmyDossier

# 2. Зависимости (Express 5, multer, bcryptjs, office-парсеры)
npm install

# 3. Конфигурация
Copy-Item .env.example .env
notepad .env
```

В `.env` обязательно задайте:

```ini
NODE_ENV=production
SESSION_SECRET=<64 hex-символа>
PROJECTS_ROOT=F:/Проекты
BIND_HOST=127.0.0.1
TRUST_PROXY=false
```

Сгенерировать секрет:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Запуск:

```powershell
node --env-file=.env server.js
# или
npm start
# или двойной клик по start.bat (создаст .env, если его нет)
```

Альтернатива «в один клик»: `start.bat` проверяет наличие Node, создаёт `.env` со случайным
`SESSION_SECRET`, запускает `node --env-file=.env server.js` и не закрывает окно при ошибке.

---

## Node.js 24

1. Скачайте LTS-установщик с <https://nodejs.org> (Node 24.x).
2. Проверьте:

   ```powershell
   node -v      # v24.x.x
   npm -v
   ```

3. В проекте включён `"engines": { "node": ">=20" }`. Версии ниже 22 не подойдут
   для `node:sqlite` без флага — используйте 24.

Проверка синтаксиса и тестов после установки зависимостей:

```powershell
npm run check
npm test
```

---

## Ollama и модели

### Установка

```powershell
# Windows: установщик с https://ollama.com/download
ollama -v
ollama serve        # если сервис не запущен автоматически
```

По умолчанию Ollama слушает `http://localhost:11434`.

### Модели

```powershell
ollama pull gemma4:e4b          # чат (chatModel)
ollama pull qwen2.5vl:3b        # vision/OCR (visionModel)
ollama pull nomic-embed-text    # эмбеддинги (embedModel)
# опционально, реранкер:
ollama pull pdurugyan/qwen3-reranker-0.6b-q8_0:latest
```

Проверка:

```powershell
ollama list
curl http://localhost:11434/api/tags
```

### Привязка моделей

Модели задаются в двух местах (в порядке приоритета):

1. **Админка → Darcus** (`/api/darcus/config`, `PATCH`).
2. Файл `data/ai-config.json` (создаётся при первом запуске).

Актуальные значения в репозитории:

```json
{
  "ollama": {
    "url": "http://localhost:11434",
    "chatModel": "gemma4:e4b",
    "visionModel": "qwen2.5vl:3b",
    "embedModel": "nomic-embed-text",
    "rerankModel": "pdurugyan/qwen3-reranker-0.6b-q8_0:latest",
    "timeout": 180000,
    "numCtx": 12288,
    "temperature": 0.7,
    "enabled": true
  }
}
```

⚠️ После смены `embedModel` кэш `data/embeddings.json` очищается автоматически
(`ensureCacheModel`), после чего нужна переиндексация: админка → Darcus →
«Переиндексировать» (`POST /api/darcus/reindex`).

Подробно про модели и промпты — [06-ai-darcus.md](06-ai-darcus.md).

---

## Python 3.10, Silero TTS и faster-whisper

Голосовые функции опциональны: без них TTS идёт через браузер, STT — через Web Speech API.

### 1. Python

Установите Python **3.10+** (проверено на 3.10–3.12) и убедитесь, что `python` доступен в PATH:

```powershell
python --version
python -m pip --version
```

Если в системе несколько интерпретаторов, путь можно зафиксировать переменной `PYTHON_BIN`
(используется в `darcus.js` при запуске faster-whisper) или полем `pythonPath` в конфиге голоса.

### 2. Silero TTS v5.6 RU

```powershell
python -m pip install --upgrade torch numpy
python scripts\silero_tts_server.py --port 8765
```

Особенности:

- при первом запуске `torch.hub` скачивает модель Silero (`snakers4/silero-models`, `v5_6_ru`) —
  нужен интернет и несколько минут;
- сервер слушает только `127.0.0.1:8765`;
- эндпоинты: `POST /tts` (`{text, voice, format, language}` → `audio/wav`), `GET /health`;
- голоса: `aidar`, `baya`, `kseniya`, `xenia`, `eugene` (значение по умолчанию — `aidar`);
- текст обрезается до 2 000 символов на синтез.

Проверка:

```powershell
curl http://127.0.0.1:8765/health
# {"ok": true, "model": "silero-v5_6_ru", "sample_rate": 48000}
```

Автозапуск:

- при старте сервера `ensureSileroServer()` проверяет `http://127.0.0.1:8765/health` и, если
  сервис не отвечает, запускает `python scripts/silero_tts_server.py --port 8765` (detached);
- в админке (**Голос**) есть кнопка «Установить/запустить Silero» —
  `POST /api/admin/voice/install` с `{"target":"silero"}`.

### 3. faster-whisper (STT)

```powershell
python -m pip install --upgrade faster-whisper
```

Настройка:

- админка → **Голос** → движок `faster-whisper`, модель `base` (или `small`/`medium`), язык `ru`;
- либо `PATCH /api/admin/voice`:

  ```json
  { "whisper": { "engine": "faster-whisper", "model": "base", "language": "ru" } }
  ```

- кнопка «Установить Whisper (авто)» выполняет `python -m pip install --upgrade faster-whisper`
  и прописывает конфиг (`POST /api/admin/voice/install`, `{"target":"whisper"}`).

Как работает распознавание:

1. Браузер пишет webm/opus (`MediaRecorder`) и отправляет на `POST /api/darcus/transcribe`.
2. Сервер сохраняет временный `data/stt-<random>.webm` и запускает
   `python scripts/faster_whisper_stt.py <model> <file> ru`.
3. Скрипт печатает JSON `{"text":"…","language":"ru"}` в UTF-8
   (`PYTHONIOENCODING=utf-8`, `PYTHONUTF8=1`), сервер возвращает `{ok:true,text}`.
4. Hotwords и начальный prompt задаются переменными `STT_HOTWORDS`, `STT_INITIAL_PROMPT`
   (значения по умолчанию — в `darcus.js`), типичные ошибки исправляются регулярками
   (`ресират` → `реферат`, `дакумент` → `документ`, `даркус` → `Darcus` и т.д.).
5. Таймаут распознавания — 180 секунд.

### 4. whisper.cpp (альтернатива)

```ini
WHISPER_BIN=C:/tools/whisper/whisper-cli.exe
WHISPER_MODEL=C:/tools/whisper/models/ggml-base.bin
WHISPER_LANG=ru
```

Эти переменные попадают в `cfg.whisper` (`config.js`) и в дефолтный конфиг Darcus.
Используются, если `engine` не равен `faster-whisper`.

---

## Файл `.env`: все переменные

`.env` читается через `node --env-file=.env` (npm-скрипты `start:prod`, PM2, systemd
используют свои механизмы). Значения разбираются в `config.js`.

### Основные

| Переменная | По умолчанию | Обязательна | Описание |
|---|---|---|---|
| `NODE_ENV` | `development` | в production | `production` включает secure-cookie, HSTS, запрет приватных адресов Ollama, обязательный `SESSION_SECRET` |
| `PORT` | `7561` | нет | HTTP-порт |
| `BIND_HOST` | `127.0.0.1` | нет | адрес прослушивания; `0.0.0.0` — доступ из LAN |
| `SESSION_SECRET` | случайный (в dev) | **в production** | секрет подписи cookie; без него production не стартует |
| `PROJECTS_ROOT` | `F:/Проекты` | да (рекомендуется) | корень файлов проектов |
| `DATA_DIR` | `<repo>/data` | нет | метаданные (SQLite, JSON-кэши, логи, вложения) |
| `BACKUP_DIR` | `<repo>/../backups` | нет | каталог резервных копий |
| `TRUST_PROXY` | `false` | за прокси | `false` / `true` / число хопов / список IP-CIDR |
| `LOG_LEVEL` | `info` | нет | `trace|debug|info|warn|error` (pino) |
| `ADMIN_USERNAME` | `admin` | нет | логин создаваемого администратора |
| `ADMIN_PASSWORD` | пусто | нет | стартовый пароль администратора; пусто — случайный, печатается в консоль |
| `LOGIN_MAX_ATTEMPTS` | `10` | нет | попыток входа с IP/логина за 15 минут |
| `IMPORT_MAX_ATTEMPTS` | `2` | нет | попыток импорта метаданных за 5 минут |

### Darcus

| Переменная | По умолчанию | Описание |
|---|---|---|
| `DARCUS_ALLOWED_HOSTS` | пусто | список хостов Ollama через запятую. Пусто — проверка по `NODE_ENV`: в production приватные адреса запрещены |
| `TTS_URL` | пусто | URL TTS-сервера (например, `http://127.0.0.1:8765/tts`); пусто — браузерный синтез |
| `TTS_VOICE` | `default` | голос TTS (`aidar`, `baya`, …) |
| `TTS_FORMAT` | `wav` | формат аудио |
| `WHISPER_BIN` | пусто | путь к бинарю whisper.cpp либо строка `faster-whisper` |
| `WHISPER_MODEL` | пусто | путь к модели whisper.cpp |
| `WHISPER_LANG` | `ru` | язык распознавания |
| `PYTHON_BIN` | `python` | интерпретатор для faster-whisper и Silero (читается в `darcus.js` и `server.js`) |

### HTTPS (встроенный второй порт)

| Переменная | По умолчанию | Описание |
|---|---|---|
| `HTTPS_PORT` | пусто | включает HTTPS-сервер с тем же приложением (например, `7562`) |
| `HTTPS_PFX` | `data/tls/dossier.pfx` | путь к PFX-файлу |
| `HTTPS_PFX_PASS` | пусто | пароль PFX — **не храните в git** |

⚠️ Секреты (`SESSION_SECRET`, `HTTPS_PFX_PASS`, `ADMIN_PASSWORD`) в репозиторий не коммитятся:
`.gitignore` исключает `.env` и `data/`. В этой документации приведены только **имена**
переменных, без значений.

### Дополнительно (жёстко задано в коде)

| Параметр | Значение | Где |
|---|---|---|
| `limits.uploadDefaultMB` | 50 | `config.js` |
| `limits.uploadSubscribedMB` | 500 (по подписке; env `UPLOAD_SUBSCRIBED_MB`) | `config.js`, `server.js` |
| `limits.uploadMaxMB` | 100 000 (жёсткий лимит multer — 2 ГБ) | `config.js`, `server.js` |
| `limits.attachmentMaxBytes` | 25 МБ | `config.js` |
| `limits.jsonBodyMax` | `20mb` | `config.js` |
| `limits.editContentMax` | 5 МБ | `config.js` |
| `limits.darcusQueryMax` | 8 000 символов | `config.js` |
| `limits.darcusHistoryMax` | 12 сообщений | `config.js` |
| `limits.darcusAttachmentsMax` | 6 файлов | `config.js` |
| `limits.darcusAttachmentBytesMax` | 4 МБ на файл | `config.js` |
| `limits.trashRetentionDays` | 14 дней | `config.js` |
| `limits.logMaxEntries` | 5 000 (журнал) | `config.js` |
| `limits.logContentMax` | 32 КБ | `config.js` |
| `limits.logFileMaxBytes` | 10 МБ | `config.js` |
| `limits.telemetryMaxEvents` | 2 000 на пользователя | `config.js` |
| `limits.maxSsePerUser` | 5 | `config.js` |

---

## Первый запуск

Что происходит при старте (`startServer`):

1. Создаются каталоги `data/`, `PROJECTS_ROOT`, `data/tmp`, `data/attachments`, `data/ads`.
2. `storage.init()` создаёт/открывает `data/dossier.db`, включает WAL, применяет схему.
3. Выполняются идемпотентные миграции:
   - JSON (`users.json`, `projects.json`, `changes.json`, `data/telemetry/`) → SQLite
     с копией в `data/backup-pre-sqlite-<timestamp>/`;
   - JSON-документы (`invites.json`, `chat.json`, `tickets.json`, …) → таблица `documents`
     с копией в `data/backup-pre-docs-<timestamp>/`.
4. Очищается `data/tmp`.
5. Если пользователей нет — создаётся администратор (`ADMIN_USERNAME`, пароль из
   `ADMIN_PASSWORD` или случайный). Пароль печатается **только в консоль**.
6. Если проектов нет — создаётся проект «Основной» (`id: default`, папка `default`).
7. Через 1,5 с проверяется Silero и при необходимости запускается.
8. Через 20 с выполняется «мягкая» индексация эмбеддингов (не более 200 чанков).

Вывод в консоли:

```
DarkArmy Dossier: http://127.0.0.1:7561
Проекты: F:\Проекты
Лог: F:\DarkArmy\DarkArmyDossier\data\log.txt
```

Если `HTTPS_PORT` задан и PFX найден, дополнительно печатается строка HTTPS.

---

## HTTPS-сертификат для микрофона

Браузер разрешает `getUserMedia` только в secure context. Для локальной сети поднимите
встроенный HTTPS-порт (тот же Node-процесс, второй `https.createServer`).

### 1. Самоподписанный сертификат (PowerShell)

```powershell
$cert = New-SelfSignedCertificate -Subject "CN=DarkArmy Dossier LAN" `
  -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(2) `
  -TextExtension @("2.5.29.17={text}DNS=localhost&IPAddress=192.168.120.128")
$pwd = ConvertTo-SecureString -String "<ваш-пароль-PFX>" -Force -AsPlainText
New-Item -ItemType Directory -Force data\tls | Out-Null
Export-PfxCertificate -Cert $cert -FilePath data\tls\dossier.pfx -Password $pwd
Export-Certificate -Cert $cert -FilePath data\tls\darkarmy-dossier-lan.cer
```

Пароль PFX придумайте сами; он нужен только в `.env` (`HTTPS_PFX_PASS`), в документации
и в git его быть не должно.

### 2. Конфигурация

```ini
HTTPS_PORT=7562
HTTPS_PFX=data/tls/dossier.pfx
HTTPS_PFX_PASS=<пароль>
```

### 3. Использование

- Откройте `https://192.168.120.128:7562` и примите предупреждение сертификата,
  либо установите `.cer` в «Доверенные корневые центры» (Windows/Android/iOS).
- Разрешите TCP 7562 в брандмауэре (профиль Private).
- Для интернета этот порт не нужен: там HTTPS даёт reverse proxy
  ([10-deployment-ubuntu.md](10-deployment-ubuntu.md)).

⚠️ Если PFX не найден, HTTPS-порт не стартует — в лог пишется предупреждение
`HTTPS: PFX не найден — HTTPS-порт не запущен`.

---

## Доступ из локальной сети

1. `.env`: `BIND_HOST=0.0.0.0`.
2. Правило брандмауэра (PowerShell от администратора), ограниченное подсетью:

   ```powershell
   New-NetFirewallRule -DisplayName "DarkArmy Dossier (LAN 7561)" `
     -Direction Inbound -Protocol TCP -LocalPort 7561 -Action Allow `
     -Profile Private -RemoteAddress 192.168.120.0/24
   ```

3. Узнайте IP (`ipconfig`) и откройте `http://<IP>:7561` с другого устройства.

⚠️ Это HTTP без шифрования: только доверенная сеть. Публиковать `0.0.0.0` в интернет
нельзя — используйте reverse proxy с TLS.

---

## Проверка установки

```powershell
# 1. Health: 200 и все проверки true
curl http://127.0.0.1:7561/api/health
# {"status":"ok","uptimeSec":12,"checks":{"dataDir":true,"projectsRoot":true,"users":true,"db":true}}

# 2. Версия и build (для автообновления вкладок)
curl http://127.0.0.1:7561/api/version
# {"version":"1.1.0","build":"...","assets":"..."}

# 3. Вход (подставьте свой пароль)
curl -c cookies.txt -H "Content-Type: application/json" `
  -d '{"username":"admin","password":"<пароль>"}' http://127.0.0.1:7561/api/login

# 4. Текущий пользователь
curl -b cookies.txt http://127.0.0.1:7561/api/me

# 5. Список проектов
curl -b cookies.txt http://127.0.0.1:7561/api/projects

# 6. Darcus: связь с Ollama (нужна админ-сессия)
curl -b cookies.txt -X POST http://127.0.0.1:7561/api/darcus/test
# {"ok":true,"models":["gemma4:e4b","nomic-embed-text","qwen2.5vl:3b"]}
```

| Проверка | Ожидаемо |
|---|---|
| `/api/health` | `200`, `status: "ok"`; `503` и `status: "degraded"` — что-то из checks `false` |
| `/api/version` | `version: "1.1.0"`, непустой `build` |
| Вход | `{"user":{...},"theme":"dark"}` и cookie `sid` |
| Админка `/admin.html` | открывается, вкладка «Обзор» показывает БД, модели, бэкапы |
| Дерево файлов | `GET /api/tree?projectId=default` возвращает `tree` |
| Загрузка | файл появляется в `PROJECTS_ROOT/<folder>/` |
| Darcus | ответ стримится, внизу — «контекст израсходован на N%» |
| Голос | `/api/darcus/tts` возвращает `audio/wav`; микрофон работает на HTTPS/localhost |

---

## Установка на Linux/macOS (кратко)

```bash
sudo useradd -r -s /usr/sbin/nologin darkarmy
sudo mkdir -p /opt/darkarmy-dossier /srv/darkarmy-projects
sudo chown -R darkarmy:darkarmy /opt/darkarmy-dossier /srv/darkarmy-projects
cd /opt/darkarmy-dossier
sudo -u darkarmy npm ci --omit=dev
sudo -u darkarmy cp .env.example .env
sudo -u darkarmy nano .env          # SESSION_SECRET, PROJECTS_ROOT=/srv/darkarmy-projects
sudo -u darkarmy node --env-file=.env server.js
```

`PROJECTS_ROOT` по умолчанию `F:/Проекты` — на Linux это нужно обязательно переопределить.

Дальше: systemd, nginx, TLS, бэкапы — [10-deployment-ubuntu.md](10-deployment-ubuntu.md).

---

## См. также

- [README.md](README.md) — обзор и быстрый старт.
- [01-architecture.md](01-architecture.md) — как устроены компоненты.
- [04-api.md](04-api.md) — проверочные запросы и коды ответов.
- [05-data-model.md](05-data-model.md) — где лежат данные и как их восстановить.
- [06-ai-darcus.md](06-ai-darcus.md) — модели, `numCtx`, промпты, RAG.
- [08-security.md](08-security.md) — что обязательно сделать после установки.
- [09-desktop-mobile-pwa.md](09-desktop-mobile-pwa.md) — установка как приложения.
- [10-deployment-ubuntu.md](10-deployment-ubuntu.md) — production-развёртывание.
- [11-troubleshooting.md](11-troubleshooting.md) — если что-то не запустилось.
