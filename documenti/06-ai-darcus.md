# 06. Darcus: ИИ-подсистема

## Содержание

1. [Что такое Darcus](#что-такое-darcus)
2. [Модели Ollama](#модели-ollama)
3. [Параметры генерации](#параметры-генерации)
4. [Конфигурация: `data/ai-config.json` и админка](#конфигурация-dataai-configjson-и-админка)
5. [Системные промпты](#системные-промпты)
6. [Подстановки в промптах](#подстановки-в-промптах)
7. [RAG: как собирается контекст](#rag-как-собирается-контекст)
8. [Веб и Википедия](#веб-и-википедия)
9. [Vision и OCR](#vision-и-ocr)
10. [ACTION-протокол](#action-протокол)
11. [Генерация документов](#генерация-документов)
12. [Суммаризация](#суммаризация)
13. [Голос: TTS и STT](#голос-tts-и-stt)
14. [Индексация и кэши](#индексация-и-кэши)
15. [Лимиты](#лимиты)
16. [Troubleshooting Darcus](#troubleshooting-darcus)
17. [См. также](#см-также)

---

## Что такое Darcus

Darcus — слой `darcus.js` (≈1 475 строк) плюс маршруты `/api/darcus/*` в `server.js`.
Он не хранит собственной БД: конфиг — `data/ai-config.json`, кэши — JSON-файлы,
чаты — документ `darcus-chats` в SQLite.

Возможности:

| Возможность | Реализация |
|---|---|
| Чат со стримингом | `POST /api/darcus/chat` → `ollamaChatStream` → SSE `chunk/done/error` |
| Контекст из файлов | `ragSearch` (keyword + embeddings + rerank) |
| Интернет и Википедия | `ddgSearch` (DuckDuckGo HTML), `wikiSearch` (ru.wikipedia.org API) |
| OCR/vision | `ocrImage`, `describeImage` через vision-модель |
| Генерация документов | `POST /api/darcus/generate-doc` |
| Rewrite/translate | `POST /api/darcus/rewrite` (4 режима) |
| Суммаризация | `POST /api/darcus/summarize` |
| TTS | `ttsSynthesize` → Silero HTTP |
| STT | `transcribeAudio` → faster-whisper / whisper.cpp |
| Действия с файлами | ACTION-блок в ответе → клиент выполняет через обычные API |

Что Darcus **не** делает:

- не имеет доступа к файлам вне доступных пользователю проектов (список проектов
  вычисляется на сервере по правам);
- не исполняет ACTION сам — это делает браузер после подтверждения (или в режиме «⚡ Авто»);
- не хранит память между чатами, кроме `visionContext` внутри одного чата;
- не обучается и не дообучается (нет fine-tune, нет векторной БД — только JSON-кэш).

---

## Модели Ollama

| Роль | Ключ конфига | Значение в репозитории | Обязательна |
|---|---|---|---|
| Чат | `chatModel` | `gemma4:e4b` | да |
| Vision/OCR | `visionModel` | `qwen2.5vl:3b` | нет (без неё нет OCR) |
| Эмбеддинги | `embedModel` | `nomic-embed-text` | нет (без неё поиск keyword-only) |
| Реранкер | `rerankModel` | `pdurugyan/qwen3-reranker-0.6b-q8_0:latest` | нет (иначе лексический реранк) |

Установка:

```bash
ollama pull gemma4:e4b
ollama pull qwen2.5vl:3b
ollama pull nomic-embed-text
ollama pull pdurugyan/qwen3-reranker-0.6b-q8_0:latest
```

Проверка списка из приложения: **Админка → Darcus → «Загрузить модели»**
(`GET /api/darcus/models`), там же «Проверить связь» (`POST /api/darcus/test`).

### Как выбирается vision-модель

`isVisionModel(name)` (синхронно, по имени) возвращает `true` для:

- `qwen*.vl` вариантов (`qwen2.5vl`, `qwen25vl`, `qwen3-vl` и т.п.);
- `*vision*`, `llava`, `bakllava`, `qwen-vl`, `qwen2-vl`, `qwen2.5-vl`;
- `gemma3*`, `gemma4*`, `minicpm-v`, `moondream`, `pixtral`, `internvl`, `granite-vision`.

Если имя не подошло, выполняется асинхронная проверка `isVisionModelAsync`:
`POST <ollama>/api/show` с `{model}` и проверка `capabilities.includes("vision")`.
Результат кэшируется в `visionCapsCache` на время жизни процесса.

### Смена модели

После смены `embedModel` кэш `embeddings.json` очищается (`ensureCacheModel`), требуется
переиндексация. После смены `chatModel`/`visionModel` переиндексация не нужна.
Если vision-модель не поддерживает изображения, OCR вернёт ошибку
`Модель "…" не является vision-моделью`, а не «пустой» результат.

---

## Параметры генерации

`ollamaChat` и `ollamaChatStream` передают в Ollama:

```json
{ "model": "<chatModel>", "messages": [...], "stream": true,
  "options": { "temperature": 0.7, "num_ctx": 12288 } }
```

| Параметр | Где | Смысл | Рекомендации |
|---|---|---|---|
| `numCtx` | конфиг + админка | размер окна контекста (`num_ctx`) | 8192 для 8 ГБ RAM; 12288 — текущее значение; 16384+ требует памяти |
| `temperature` | конфиг | креативность | 0.7 для чата, 0.1–0.2 для OCR/vision/суммаризации, 0.8 для генерации документов |
| `timeout` | конфиг | таймаут запроса, мс | 180 000 по умолчанию |
| `numPredict` | опция вызова | ограничение длины ответа | используется точечно (не в UI) |
| `enabled` | конфиг | флаг «ИИ включён» | UI-переключателя нет; читается кодом |

Особенности реализации:

- **Один повтор** при транзиентной ошибке (`socket hang up`, `ECONNRESET`, `ECONNREFUSED`,
  `EPIPE`, `ETIMEDOUT`, `timeout`) через 800 мс — только если поток ещё ничего не отдал.
- При закрытии вкладки сервер уничтожает HTTP-запрос к Ollama (`res.on('close')`),
  чтобы не держать GPU и сокет.
- Служебные токены шаблонов (`<|img|>`, `<|file|…|>`, `<|endoftext|>`) вырезаются
  функцией `stripSpecialTokens`.
- Ошибка «Модель вернула пустой ответ» — если после очистки строка пустая.

### Бюджет промпта

```
maxPromptChars = max(6000, numCtx × 2)          // при 12288 → 24 576 символов
budget = maxPromptChars − systemPrompt − query − 1200
context   ← 45 % бюджета
history   ← 25 %
attachments ← 30 %
```

Всё, что не влезло, обрезается с пометкой
`…(<часть> сокращено из-за лимита контекста)`. Индикатор в UI считает
`used = ceil((promptChars + answer.length) / 3.2)` и `percent = used / numCtx`.

---

## Конфигурация: `data/ai-config.json` и админка

Файл создаётся при первом запуске из `DEFAULT_CONFIG` и при чтении **мержится** с дефолтами
(недостающие ключи добавляются, лишние сохраняются).

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
  },
  "prompts": { "system": "…", "chat": "…", "…": "…" },
  "search": { "maxContextChunks": 10, "maxChunkChars": 1000, "webResults": 10, "wikiResults": 10 },
  "ocr": { "autoOnUpload": true, "maxFileMB": 2 },
  "stylePresets": { "default": { "label": "По умолчанию", "systemSuffix": "" } },
  "whisper": { "engine": "faster-whisper", "model": "base", "language": "ru" },
  "tts": { "url": "http://127.0.0.1:8765/tts", "voice": "aidar", "format": "wav" }
}
```

Изменение через админку (`PATCH /api/darcus/config`) принимает четыре секции:
`ollama`, `prompts`, `search`, `ocr`. Голос меняется отдельно (`PATCH /api/admin/voice`).
`stylePresets` через API не редактируются — только файлом.

Правила редактирования файла:

1. Остановите сервер или будьте готовы к перезапуску (конфиг читается на каждый запрос,
   так что изменения применяются сразу — перезапуск не обязателен).
2. Сохраняйте валидный JSON (UTF-8, без комментариев и висячих запятых).
3. Храните резервную копию: `Copy-Item data/ai-config.json data/ai-config.backup.json`.
4. При битом JSON Darcus молча перейдёт на `DEFAULT_CONFIG` — правки «исчезнут».
5. `prompts` мержатся по ключам: удалить промпт из файла нельзя, можно заменить на пустую
   строку (это сломает соответствующую функцию).

Проверка URL Ollama при сохранении (`validateOllamaUrl`):

- разрешены только `http:`/`https:`;
- всегда блокируются `169.254.169.254` и `metadata.google.internal`;
- если задан `DARCUS_ALLOWED_HOSTS` — хост должен совпасть или быть поддоменом;
- в production приватные адреса (`localhost`, `127.0.0.1`, `10.*`, `192.168.*`,
  `172.16–31.*`, `*.local`) запрещены без `DARCUS_ALLOWED_HOSTS`.

---

## Системные промпты

Полный список ключей `prompts`:

| Ключ | Назначение | Используется в |
|---|---|---|
| `system` | главный системный промпт Darcus + правила ACTION | `/api/darcus/chat` |
| `chat` | шаблон пользовательского сообщения (вложения, контекст, история, вопрос) | `/api/darcus/chat` |
| `rephrase` | перефразирование | `/api/darcus/rewrite` (`mode=rephrase`) |
| `shorten` | сокращение | `mode=shorten` |
| `fix` | орфография/пунктуация | `mode=fix` |
| `translate` | перевод (подстановка `{lang}`) | `mode=translate` |
| `generate_doc` | генерация Markdown-документа | `/api/darcus/generate-doc` |
| `generate_doc_system` | системная роль генератора документов | там же |
| `vision_chat` | компактный промпт для чата с изображением | `/api/darcus/chat` при наличии картинок |
| `summarize` | JSON-суммаризация | `/api/darcus/summarize` |
| `ocr` | «распознай весь текст» | `ocrImage` |
| `vision` | JSON `{description,text,boxes}` | `describeImage` |
| `template_readme` | шаблон README | `generate-doc` с `template=readme` |
| `template_meeting` | протокол встречи | `template=meeting` |
| `template_checklist` | чек-лист | `template=checklist` |
| `template_report` | отчёт | `template=report` |
| `template_note` | заметка | `template=note` |

Поверх `system` всегда добавляются два блока из кода (`darcus.js`):

1. **`QUALITY_PROMPT`** — «сначала суть, потом детали», не выдумывать факты, Markdown.
2. **`FILE_PROMPT`** — «создавай файлы, а не текст в чате»: для больших объёмов использовать
   ACTION, в чате — короткое подтверждение и путь.

В голосовом режиме добавляется блок «ГОЛОСОВОЙ РЕЖИМ (КРИТИЧНО)»: 1–3 предложения,
без списков/таблиц/кода/эмодзи.

Ключевые требования к `system` (в текущей редакции):

- отвечать по-русски, если не попросили иначе;
- Markdown-формат;
- при изображении — полный OCR и включение текста в ответ;
- ACTION-блок: маркеры `<<<ACTION>>> … <<<END ACTION>>>`, один блок = одно действие;
- типы: `create`, `edit`, `mkdir`, `delete`, `move`, `rename`, `generate_doc`;
- `path` — относительно корня проекта, без имени проекта, без `..`, без ведущего `/`;
- `content` — полное содержимое; для больших документов — `generate_doc` с `prompt`;
- не дублировать содержимое файла в тексте ответа;
- не оборачивать ACTION в ``` ```.

✅ `generate_doc` поддерживается клиентским парсером (`AI_ACTION_TYPES` в `public/app.js`)
и выполняется через `POST /api/darcus/generate-doc`. Если в `data/ai-config.json` текст
`system` короче, правило всё равно добавляется runtime-промптом `FILE_PROMPT` в
`darcus.js`, поэтому генерация больших документов доступна из чата. Дополнительно
клиент страхует случай «модель сказала, что создала файл, но ACTION не вернула»:
`autoCreateFileFromQuery()` вызывает генератор документов и показывает честную плашку.

---

## Подстановки в промптах

`buildSubs` + `applySubs` заменяют `{key}`; неизвестные ключи остаются как есть.

| Плейсхолдер | Значение |
|---|---|
| `{username}` | логин |
| `{role}` | роль сайта |
| `{project}` | имя проекта |
| `{file}` | редактируемый файл |
| `{date}` | дата `ru-RU` |
| `{time}` | время `ЧЧ:ММ` |
| `{lang}` | язык перевода |
| `{mode}` | режим (`chat`, `ocr`, `vision`, `summarize`, `generate_doc`) |
| `{context}` | собранный контекст (RAG + web + файлы) |
| `{query}` | вопрос пользователя |
| `{history}` | история диалога |
| `{attachments}` | текст приложенных файлов |
| `{text}` | текст для rewrite/summarize |
| `{prompt}` | описание документа |
| `{template}` | текст шаблона |

---

## RAG: как собирается контекст

`ragSearch(projects, query, opts)`:

### 1. Keyword-поиск

- `extractTerms`: нижний регистр, очистка от не-букв, слова длиной ≥3, максимум 12;
- обход проектов до глубины 8, файлы >20 МБ пропускаются;
- текст извлекается `extract-text.js` (md/txt напрямую, docx — mammoth, xlsx — SheetJS,
  pdf/pptx — officeparser);
- изображения ищутся по `ocr-cache.json` (ключ SHA-1);
- чанки режутся по строкам до `maxChunkChars` (1 000 символов);
- скор чанка — число вхождений терминов (изображения получают `×2`);
- берётся `maxChunks × 3` лучших.

### 2. Семантический поиск

- `ollamaEmbed` через `POST /api/embeddings` (текст обрезается до 8 000 символов);
- косинусное сходство с чанками кэша, `minScore = 0.35`;
- фильтр по `projectId` доступных проектов, топ `maxChunks × 3`.

### 3. Объединение и реранк

```
score = kwScore × 0.4 + semScore × 0.6      // нормированные 0..1
```

- кандидаты (до `max(3×maxChunks, 30)`) передаются в реранкер:
  - `rerankWithModel` — если задан `rerankModel`: модель оценивает каждый фрагмент 0–10,
    итог `0.65 × rerank + 0.35 × исходный`;
  - иначе `lexicalRerank` — IDF-взвешивание терминов, итог `0.6 × rerank + 0.4 × исходный`;
- финально остаётся `maxChunks` (10 по умолчанию).

В промпт контекст попадает как:

```
[1] Основной / docs/report.md
<фрагмент до 700 символов>

---

[2] …
```

В ответе `sources` — до 8 источников с `projectId`, `projectName`, `path`, `kind`.

### Ограничения RAG

- нет ANN-индекса: перебор всех чанков в памяти (до 50 000) на каждый запрос;
- индекс не обновляется сам при внешних изменениях файлов (только через
  `refreshEmbedIndex` после API-операций и ручную переиндексацию);
- OCR запускается только при загрузке через API, при `autoOnUpload: false` — по кнопке;
- кэш чанков не удаляется при удалении файла, если файл удалён в обход API.

---

## Веб и Википедия

| Источник | Реализация | Лимит |
|---|---|---|
| DuckDuckGo | `https://html.duckduckgo.com/html/?q=…`, парсинг `a.result__a` | `search.webResults` (10) |
| Википедия (ru) | `action=opensearch` | `search.wikiResults` (10) |

- Запросы идут без API-ключей, таймауты 9 с и 8 с.
- `0` в конфиге отключает источник.
- В промпт попадают заголовки и URL (интернет) / заголовки, сниппеты и URL (Википедия).
- В ответе — `web` (до 4) и `wiki` (до 2).
- ⚠️ Содержимое внешних страниц **не загружается**, передаются только выдача и ссылки.

---

## Vision и OCR

### Поток

```
Изображение (из вложения чата или ссылки в открытом .md)
  → base64 (data URL очищается)
  → проверка размера ≤ ocr.maxFileMB (2 МБ)
  → isVisionModelAsync(visionModel)
  → ocrImage:    prompts.ocr   → текст (до 8 000 символов)
  → describeImage: prompts.vision → JSON {description,text,boxes}
  → кэш ocr-cache.json по SHA-1 (только успешный результат)
```

- `parseVisionJson` терпим к ```json-обёртке и «сырым» переводам строк внутри строк;
- если модель вернула шаблонные фразы («краткое описание», «строго JSON»), описание
  очищается;
- ответы вида «не могу», «изображение не предоставлено» трактуются как ошибка
  `vision-model-rejected`;
- изображения, на которые ссылается открытый Markdown, автоматически прикрепляются
  к запросу Darcus (до 3 штук, до 8 МБ каждое; поддерживаются `![](…)`, `![[…]]`,
  `<img src>`).

### «qwen → gemma» и компактный промпт

Vision-модели (особенно `qwen2.5vl`) теряют изображение, если системный промпт длинный:
в ответ приходит `<|img|>` или «картинка не предоставлена». Поэтому при наличии картинок:

- используется **одно** сообщение `role: "user"` с `images: [...]` и промптом `vision_chat`;
- системная роль не передаётся;
- контекст и история урезаются до 900 и 600 символов;
- `temperature: 0.2`;
- файловый блок `FILE_PROMPT` добавляется в конец.

Это позволяет стабильно распознавать текст `qwen2.5vl:3b` и при этом использовать
`gemma4:e4b` как основную чат-модель. После успешного ответа по картинке он сохраняется
в `chat.visionContext` (до 12 000 символов) и подмешивается в следующие текстовые
вопросы этого чата (до 6 000 символов).

---

## ACTION-протокол

### Формат

```
<<<ACTION>>>
{"type":"create","path":"docs/guide.md","content":"# Заголовок\n\nТекст"}
<<<END ACTION>>>
```

| Тип | Поля | Что делает клиент |
|---|---|---|
| `create` | `path`, `content` | `POST /api/create` + `POST /api/write` |
| `edit` | `path`, `content` | `POST /api/write` |
| `mkdir` | `path` | `POST /api/mkdir` |
| `delete` | `path` | `DELETE /api/delete` (в корзину) |
| `move` | `from`, `to` | `POST /api/move` |
| `rename` | `path`, `newName` | `POST /api/rename` |
| `generate_doc` | `path`, `prompt`, `template?` | `POST /api/darcus/generate-doc` — поддержан парсером и может вызываться прямо из чата |

### Разбор

`public/app.js`:

1. `extractAiActions` ищет маркеры `<<<ACTION>>>` / `<<>>`-варианты;
2. `_scanJsonObject` вручную сканирует сбалансированные `{}` с учётом строк и экранирования
   (поэтому `}` внутри `content` не ломает парсинг);
3. `_parseActionObj` требует `type` из `AI_ACTION_TYPES` (`create`, `edit`, `mkdir`,
   `delete`, `move`, `rename`, `generate_doc`);
4. `runAiAction` спрашивает подтверждение (если не «⚡ Авто»), вызывает API,
   показывает плашку результата `✅`/`⚠️`;
5. если модель заявила о создании файла, но ACTION-блока нет, `autoCreateFileFromQuery`
   вызывает генератор документов и показывает плашку только после реального результата.

### Правила безопасности

- Сервер **никогда** не исполняет ACTION из текста модели; все изменения идут через
  обычные маршруты с `requireAuth` + `projectGuard('edit')`.
- `path` дополнительно проверяется `safeJoin` на сервере.
- Подтверждение показывает путь и первые 400 символов содержимого (для create/edit).
- `delete` не показывает содержимое (файла ещё «нет» в контексте) — это известное
  ограничение UX ⚠️.
- Внешний контент (RAG, web) попадает в промпт как данные, но модель может попытаться
  инициировать действие — поэтому подтверждение обязательно по умолчанию.

---

## Генерация документов

`POST /api/darcus/generate-doc`:

1. Проверка права `canEditProject`.
2. `ragSearch(projects, prompt, {maxChunks: 6})` → контекст (по 600 символов на чанк).
3. `template` → `prompts['template_' + template]` (или «—»).
4. Системный промпт — `generate_doc_system`, пользовательский — `generate_doc`.
5. `temperature: 0.8`.
6. `cleanGeneratedMarkdown`: удаляет ACTION-блоки, ```-обёртки и вступление до первого `# `.
7. Имя файла: `.md` добавляется, недопустимые символы заменяются, при коллизии ` (1)`.
8. Запись файла + журнал (`action: create`, `details: Darcus auto-generated`).

Пустой результат → `502 Модель вернула пустой документ`.

Из интерфейса доступны два пути:

- кнопка **«Darcus — создать»** в сайдбаре (модалка с описанием, шаблоном, папкой и именем);
- ACTION-блок `create` — для коротких документов.

---

## Суммаризация

`POST /api/darcus/summarize`:

- вход: текст из файла (md/txt/docx/xlsx/pdf/pptx) или OCR-кэш для изображений;
- ограничение: файл ≤20 МБ, текст ≤ `min(40000, numCtx × 2.5)` символов;
- промпт `summarize` требует **только JSON**:
  `{"tldr":"…","points":["…"],"entities":["…"]}`;
- парсер сначала ищет ```json-блок, затем `{…}`; при неудаче возвращает сырой текст
  в `tldr` с флагом `_raw: true`;
- результат кэшируется в памяти (`summaryCache`) на 24 часа по SHA-1 файла;
- поля ограничены: `tldr` 1 200, `points` 15, `entities` 40.

UI: кнопка **«Кратко»** в filebar; панель добавляется в конец документа.
⚠️ Панель не прокручивает экран к себе автоматически — известное неудобство.

---

## Голос: TTS и STT

### TTS

1. `POST /api/darcus/tts` → `ttsSynthesize`.
2. `prepareTtsText` нормализует текст под Silero RU:
   - убирает HTML-плашки действий, ACTION-блоки, код, URL и markdown-разметку;
   - бренды и аббревиатуры → кириллица (`Darcus` → «Даркус», `README` → «Ридми»,
     `OCR` → «о цэ эр», `JSON` → «джейсон»);
   - `Ctrl+S` → «контрол эс»;
   - файлы: `README.md` → «ридми точка эм дэ»;
   - даты и версии: `25.11.2026` → «двадцать пять одиннадцать две тысячи двадцать шесть»,
     `5.6` → «пять точка шесть»;
   - `%` → «процентов», `&`/`+` → «и», `=` → «равно»;
   - любые оставшиеся латинские слова транслитерируются;
   - эмодзи удаляются.
3. Текст уходит на `tts.url` (`POST {text,voice,format,language}`), ответ — аудио
   (`Content-Type` из ответа).
4. Клиент проигрывает через Web Audio (`decodeAudioData`), а не `<audio autoplay>`,
   чтобы обойти блокировку автозапуска.
5. Если серверный TTS не настроен (`capabilities.tts === false`) — `speechSynthesis`
   с русским голосом ОС.

### STT

См. [02-installation.md](02-installation.md#python-310-silero-tts-и-faster-whisper).
Кратко:

| Движок | Условие | Особенности |
|---|---|---|
| faster-whisper | `whisper.engine === "faster-whisper"` | CPU int8, VAD, beam_size 5, hotwords, initial prompt, автоисправления, таймаут 180 с, UTF-8 вывод |
| whisper.cpp | заданы `WHISPER_BIN` и `WHISPER_MODEL` | аргументы `-m … -f … -l ru --output-txt --no-timestamps` |
| Web Speech | ничего не настроено | только Chrome/Edge, нужен HTTPS/localhost |

---

## Индексация и кэши

| Операция | Триггер | Что делает |
|---|---|---|
| `indexFile(projectId, abs, rel)` | после create/write/upload/save/restore/move | режет текст на чанки и получает эмбеддинги |
| `indexProjects(projects, {maxChunksPerRun})` | старт (через 20 с, 200 чанков) и `/api/darcus/reindex` | полный обход всех файлов |
| `invalidateFileCache(projectId, rel)` | rename/move/delete/restore/revert | удаляет чанки файла из кэша |
| OCR-индексация | `queueImageAnalysis` после загрузки картинки | OCR+vision → кэш → эмбеддинг описания |

Кэши:

| Файл | Ключ | Лимит | Сброс |
|---|---|---|---|
| `embeddings.json` | SHA-1 текста чанка | 50 000 записей | смена `embedModel`, ручная очистка |
| `ocr-cache.json` | SHA-1 содержимого файла | нет жёсткого лимита | ручная очистка; ошибки не кэшируются |
| `summaryCache` (память) | SHA-1 файла | нет | рестарт, 24 ч TTL |

---

## Лимиты

| Параметр | Значение | Где |
|---|---|---|
| Длина запроса | 8 000 символов | `limits.darcusQueryMax` |
| История | 12 сообщений × 8 000 | `limits.darcusHistoryMax` |
| Вложений | 6 × 4 МБ | `limits.darcusAttachmentsMax/BytesMax` |
| Изображение в base64 | ~12 МБ | `darcusAsk` |
| Текст вложения | 30 000 символов (обрезка) | `darcusAsk` |
| Файл для OCR | `ocr.maxFileMB` (2 МБ) | конфиг |
| Файл для суммаризации | 20 МБ | `server.js` |
| Текст для TTS | 5 000 символов (сервер), 2 000 (Silero) | `server.js`, Python |
| Аудио для STT | 10 МБ | `express.raw` |
| Запросов Darcus | 20/мин | `rateLimitDarcus` |
| Запросов распознавания | 10/мин | `rateLimitTranscribe` |
| Стрим | таймаут `ollama.timeout` (180 с) | конфиг |

---

## Troubleshooting Darcus

| Симптом | Причина | Решение |
|---|---|---|
| `Darcus: слишком много запросов` | 20/мин | подождать минуту |
| `subscription-required` | нет подписки | активировать код или выдать подписку в админке |
| `Ollama не ответила за N с` | модель грузится/не хватает RAM | увеличить `timeout`, взять модель меньше, закрыть другие процессы |
| `socket hang up` | Ollama перезапустила runner | обычно повторяется автоматически; иначе повторить запрос |
| Пустой ответ | модель «сломалась» на промпте | сменить модель, уменьшить `numCtx`, начать новый чат |
| `Модель "…" не является vision-моделью` | выбрана текстовая модель | указать `qwen2.5vl:3b`/`gemma4:e4b`/`llava` |
| OCR возвращает шаблон | модель мала или промпт длинный | vision-модель крупнее, `temperature` 0.1 |
| Семантика не работает | нет `embedModel`/модель не скачана | `ollama pull nomic-embed-text`, переиндексация |
| Поиск находит только точные слова | эмбеддинги пустые | проверить `data/embeddings.json`, «Переиндексировать» |
| Действие Darcus не выполнилось | модель выдала невалидный JSON/путь | проверить плашку с ошибкой, повторить запрос |
| `generate_doc` из чата не выполняется | старый кеш `app.js`/нет подписки | обновить страницу, проверить `requireSubscription` и `/api/darcus/generate-doc` |
| TTS молчит | `tts.url` пуст/Silero не запущен | `/health` на 8765, «Установить/запустить Silero» |
| Распознавание «кракозябрами» | нарушена кодировка вывода | используется UTF-8-вывод; проверить `PYTHONIOENCODING` |
| Микрофон не открывается | HTTP в LAN | HTTPS-порт или серверный Whisper + диктофон |

---

## См. также

- [02-installation.md](02-installation.md) — установка Ollama, Silero, faster-whisper.
- [03-user-guide.md](03-user-guide.md) — интерфейс Darcus и плашки действий.
- [04-api.md](04-api.md#darcus-ии) — все маршруты Darcus.
- [05-data-model.md](05-data-model.md) — `ai-config.json`, кэши, `darcus-chats`.
- [07-collaboration.md](07-collaboration.md) — совместная работа с файлами.
- [11-troubleshooting.md](11-troubleshooting.md) — расширенный разбор ошибок.
- [13-admin-guide.md](13-admin-guide.md#вкладка-darcus) — настройка через админку.

---

## RAG по встроенным инструкциям приложения

В репозитории есть папка `ai-knowledge/` (9 Markdown-документов: интерфейс, Darcus,
совместная работа, офлайн/микрофон, админка, ошибки, действия, деплой). При каждом
запросе `darcus.js`:

1. загружает и кэширует документы по mtime;
2. режет их на чанки по заголовкам;
3. считает лексическую релевантность запроса (стемминг, стоп-слова, бонус заголовкам);
4. добавляет top-3 фрагмента в контекст как «ИНСТРУКЦИИ ПО DARKARMY DOSSIER»;
5. добавляет в system-промпт правило опираться на эти инструкции и не выдумывать функции.

Проверка: `GET /api/darcus/knowledge` (авторизованный) возвращает `{files, chunks, docs}`;
в админке на вкладке Darcus показывается строка «RAG-инструкции: …».

Дополнительные ACTION-типы: `open` (открыть файл), `task` (создать задачу),
`search` (открыть поиск). В контекст также передаются задачи текущего проекта
(текст, статус, исполнитель, приоритет, срок).
