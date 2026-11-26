# 09. Desktop, мобильные устройства и PWA

## Содержание

1. [Три способа «поставить приложение»](#три-способа-поставить-приложение)
2. [PWA: манифест и service worker](#pwa-манифест-и-service-worker)
3. [Установка на Windows](#установка-на-windows)
4. [Установка на Android](#установка-на-android)
5. [Установка на iOS/iPadOS](#установка-на-iosipados)
6. [Требование HTTPS](#требование-https)
7. [Офлайн-режим: что работает, что нет](#офлайн-режим-что-работает-что-нет)
8. [Electron-обёртка](#electron-обёртка)
9. [Окно Edge/Chrome `--app`](#окно-edgechrome---app)
10. [Сборка APK (Bubblewrap/TWA) на Ubuntu](#сборка-apk-bubblewraptwa-на-ubuntu)
11. [Ограничения](#ограничения)
12. [См. также](#см-также)

---

## Три способа «поставить приложение»

| Способ | Что даёт | Где работает | Требует |
|---|---|---|---|
| **PWA** (манифест + service worker) | иконка, отдельное окно, офлайн-оболочка | Windows, Android, iOS, Linux, macOS | HTTPS (или localhost) |
| **Electron** (`desktop/electron`) | нативное окно с иконкой и меню | Windows, Linux, macOS | Node, зависимости, запущенный сервер |
| **Окно `--app`** (`desktop/open-windows-app.cmd`) | отдельное окно браузера без адресной строки | Windows (Edge/Chrome) | браузер + запущенный сервер |
| **APK/TWA** | устанавливаемое Android-приложение из Play или APK | Android | сборка через Bubblewrap (в репозитории **не** собрана) ❌ |

---

## PWA: манифест и service worker

### `public/manifest.webmanifest`

```json
{
  "name": "DarkArmy Dossier",
  "short_name": "Dossier",
  "description": "Личная экосистема документов, проектов и ИИ-ассистента Darcus",
  "id": "/",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "display_override": ["window-controls-overlay", "standalone", "minimal-ui"],
  "orientation": "any",
  "background_color": "#0b0d12",
  "theme_color": "#0b0d12",
  "lang": "ru",
  "dir": "ltr",
  "categories": ["productivity", "utilities", "business"],
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-192-maskable.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
    { "src": "/icons/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    { "name": "Darcus", "short_name": "Darcus", "url": "/?action=darcus", "icons": [{ "src": "/icons/icon-192.png", "sizes": "192x192" }] },
    { "name": "Новый файл", "short_name": "Файл", "url": "/?action=new-file", "icons": [{ "src": "/icons/icon-192.png", "sizes": "192x192" }] }
  ]
}
```

Манифест подключён в `index.html`, `login.html`, `register.html` (`<link rel="manifest">`).
Ярлыки (`shortcuts`) обрабатываются в `app.js` → `handlePwaAction()`:
`?action=darcus` открывает чат Darcus, `?action=new-file` — диалог создания файла.

### `public/sw.js`

| Свойство | Значение |
|---|---|
| Имя кэша | `da-pwa-v4` |
| Предзагрузка (CORE) | `/`, `/index.html`, `/app.js`, `/design.css`, `/manifest.webmanifest`, 4 иконки |
| Установка | `Promise.allSettled(CORE.map(c.add))` + `skipWaiting()` |
| Активация | удаление всех кэшей, кроме текущего, + `clients.claim()` |
| Навигация | network-first, при ошибке — `index.html` из кэша |
| JS/CSS/webmanifest | network-first с обновлением кэша, при ошибке — кэш |
| Изображения | cache-first |
| `POST` и прочие методы | не перехватываются |
| `/api/*`, `/files/*`, `events` | **никогда не кешируются** |

Регистрация — только в secure context (`initPwa()`):

```js
if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
```

Обновление оболочки: измените `VERSION` в `sw.js` (`da-pwa-v4`) и перезагрузите страницу.
При этом старый кэш будет удалён на `activate`.

### Кнопка установки

- `beforeinstallprompt` перехватывается, сохраняется в `_deferredInstallPrompt`,
  кнопка `#installAppBtn` становится видимой (в модалке «Помощь»);
- по клику вызывается `prompt()`;
- если события не было — тост «Установка недоступна: откройте сайт по HTTPS или через
  меню браузера»;
- `appinstalled` скрывает кнопку.

---

## Установка на Windows

### Chrome / Edge

1. Откройте сайт по **HTTPS** (или `http://localhost:7561`).
2. В адресной строке появится иконка установки (или меню → «Установить приложение»).
   В приложении — «Помощь» → «Установить приложение».
3. Приложение откроется в отдельном окне без адресной строки, появится в «Пуск».

Ограничения Windows:

- без HTTPS (обычный `http://192.168.x.x:7561`) установка недоступна;
- значок в трее/автозапуск — средствами ОС (Планировщик), в приложении нет;
- PWA не работает при выключенном сервере (оболочка откроется, данные — нет).

### Альтернатива: Electron

См. [Electron-обёртка](#electron-обёртка) — даёт настоящее десктопное окно и `.exe`.

---

## Установка на Android

### Chrome / Edge / Яндекс.Браузер

1. Откройте сайт по HTTPS.
2. Меню браузера → «Установить приложение» / «Добавить на главный экран».
3. Подтвердите; иконка появится на рабочем столе, приложение откроется в standalone-режиме.

Особенности:

- нужен валидный сертификат (самоподписанный не даст установку без исключения);
- ярлыки «Darcus» и «Новый файл» появляются при долгом нажатии на иконку
  (поддерживается не всеми лаунчерами);
- микрофон работает, если сайт открыт по HTTPS;
- на HTTP в локальной сети установка недоступна, но сайт работает как обычная вкладка.

### APK

Готового APK в репозитории нет ❌. Инструкция по сборке — ниже.

---

## Установка на iOS/iPadOS

Safari:

1. Откройте сайт по HTTPS.
2. Кнопка «Поделиться» → «На экран „Домой“».
3. Иконка появится на домашнем экране; приложение откроется без интерфейса Safari.

Ограничения iOS:

- `beforeinstallprompt` не поддерживается — кнопка «Установить приложение» не появится,
  установка только через меню Safari;
- service worker поддерживается, но кэш может очищаться системой при нехватке места;
- push-уведомления для PWA на iOS ограничены (в приложении не реализованы);
- скачивание файлов и печать ведут себя иначе, чем на десктопе;
- микрофон и камера — только HTTPS и после разрешения.

---

## Требование HTTPS

| Функция | HTTP (localhost) | HTTP (LAN IP) | HTTPS |
|---|---|---|---|
| Вход, файлы, чаты | ✓ | ✓ | ✓ |
| Установка PWA | ✓ | — | ✓ |
| Service worker | ✓ | — | ✓ |
| Микрофон (`getUserMedia`) | ✓ | — | ✓ |
| Системный диктофон (`<input capture>`) | ✓ | ✓ | ✓ |
| Копирование в буфер (некоторые API) | ✓ | — | ✓ |
| `crypto.randomUUID` | ✓ | — (fallback) | ✓ |

Для LAN используйте встроенный HTTPS-порт (`HTTPS_PORT`, см.
[02-installation.md](02-installation.md#https-сертификат-для-микрофона)) или reverse proxy
с валидным сертификатом.

---

## Офлайн-режим: что работает, что нет

Работает без сети (после первого визита):

- открытие оболочки приложения (`index.html`, `app.js`, `design.css`, иконки);
- отображение ранее загруженной страницы входа.

Не работает:

- любые данные: `/api/*` не кешируются;
- файлы проектов (`/files/*`) не кешируются;
- отправка сообщений, сохранение, поиск, Darcus, голос;
- офлайн-редактирование и синхронизация при восстановлении связи ❌.

То есть это **не offline-first приложение**, а кэш оболочки, чтобы приложение быстрее
стартовало и не показывало «нет соединения» при кратком обрыве.

---

## Electron-обёртка

Каталог `desktop/electron`:

```
desktop/electron/
├── main.js          окно, меню, внешние ссылки
├── preload.js       contextBridge: window.darkarmyDesktop
├── package.json     electron ^33, electron-builder ^25, скрипты
└── icons/           icon-192.png, icon-512.png
```

### `main.js`

- окно 1440×900, минимум 900×600, фон `#0b0d12`, `autoHideMenuBar`;
- URL: `process.env.DOSSIER_URL` или `http://127.0.0.1:7561`;
- при неудаче — диалог «Не удалось подключиться к серверу» с кнопками «Повторить»/«Выход»;
- `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `spellcheck: true`, `preload`;
- `setWindowOpenHandler` — все `http(s)`-ссылки открываются в системном браузере;
- `will-navigate` блокирует уход за пределы `DOSSIER_URL` и `127.0.0.1:7561`;
- меню приложения отключено.

`preload.js` отдаёт только:

```js
window.darkarmyDesktop = { isDesktop: true, platform: "win32"|"linux"|"darwin" }
```

Никакого доступа к Node из страницы нет.

### Запуск

```powershell
cd desktop\electron
npm install
npm start
# или с удалённым сервером:
$env:DOSSIER_URL="https://dossier.example.com"; npm start
```

Сервер должен быть уже запущен (`npm start` в корне) либо указан `DOSSIER_URL`.

### Сборка

```powershell
npm run dist          # Windows: portable + NSIS-установщик
npm run dist:linux    # Linux: AppImage + deb
```

Артефакты — в `desktop/electron/dist`. Конфигурация `build`:

```json
{ "appId": "com.darkarmy.dossier",
  "productName": "DarkArmy Dossier",
  "win": { "target": ["nsis", "portable"], "icon": "icons/icon-512.png" },
  "linux": { "target": ["AppImage", "deb"], "icon": "icons/icon-512.png", "category": "Office" },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true } }
```

⚠️ Подпись кода не настроена — Windows SmartScreen и macOS Gatekeeper будут предупреждать.
`mac`-таргет в конфиге отсутствует.

---

## Окно Edge/Chrome `--app`

Самый простой «десктоп» без Electron: `desktop/open-windows-app.cmd`.

```bat
set URL=%DOSSIER_URL%
if "%URL%"=="" set URL=http://127.0.0.1:7561
rem ищет msedge.exe, затем chrome.exe
start "" "%EDGE%" --app=%URL% --window-size=1440,900
```

Что даёт: отдельное окно без адресной строки и вкладок, иконка в панели задач.
Не даёт: своего меню, автозапуска, установщика.

---

## Сборка APK (Bubblewrap/TWA) на Ubuntu

Trusted Web Activity — «нативная» обёртка вокруг PWA. В репозитории Android-проекта нет,
поэтому шаги выполняются на отдельной машине.

### 1. Подготовка

```bash
sudo apt update
sudo apt install -y openjdk-17-jdk android-sdk unzip
node -v            # 18+ (лучше 20/24)
npm i -g @bubblewrap/cli
```

Bubblewrap при первом запуске предложит скачать JDK/SDK — можно согласиться.

### 2. Инициализация

```bash
mkdir -p ~/dossier-twa && cd ~/dossier-twa
bubblewrap init --manifest https://dossier.example.com/manifest.webmanifest
```

Ответьте на вопросы:

| Вопрос | Значение |
|---|---|
| Application name | `DarkArmy Dossier` |
| Short name | `Dossier` |
| Application ID | `com.darkarmy.dossier` |
| Display mode | `standalone` |
| Orientation | `any` |
| Theme/background color | `#0b0d12` |
| Signing key | создать новый (сохраните keystore и пароль!) |

### 3. Digital Asset Links

Для TWA без адресной строки нужен файл:

```
https://dossier.example.com/.well-known/assetlinks.json
```

содержимое (отпечаток SHA-256 вашего keystore):

```json
[{ "relation": ["delegate_permission/common.handle_all_urls"],
   "target": { "namespace": "android_app",
               "package_name": "com.darkarmy.dossier",
               "sha256_cert_fingerprints": ["AA:BB:…"] } }]
```

⚠️ Сервер не отдаёт этот файл (маршрута нет) ❌. Разместите его статикой на прокси:

```nginx
location = /.well-known/assetlinks.json {
    root /var/www/dossier-wellknown;
    default_type application/json;
}
```

Без `assetlinks.json` приложение откроется с адресной строкой браузера.

### 4. Сборка

```bash
bubblewrap build
# получаете app-release-signed.apk и app-release-bundle.aab
```

Установка на устройство:

```bash
adb install -r app-release-signed.apk
```

### 5. Требования и ограничения APK

- сайт должен быть доступен по **валидному HTTPS** (Let's Encrypt подходит);
- сертификат не должен быть самоподписанным;
- PWA-манифест должен содержать `name`, `short_name`, `icons 192/512`, `start_url`,
  `display: standalone` — всё это уже есть;
- обновление контента происходит с сервера (APK — только оболочка);
- пересборка APK нужна при смене иконки/названия/ID, но не при обновлении веб-приложения;
- публикация в Google Play требует `.aab`, политику конфиденциальности и подпись.

---

## Ограничения

1. **Нет push-уведомлений** (ни Web Push, ни нативных) ❌ — только уведомления внутри
   приложения по SSE.
2. **Нет фоновой синхронизации** и офлайн-очереди ❌.
3. **Нет нативных интеграций**: share-таргет, «Открыть в…», системные файлы — не реализованы.
4. **Микрофон/камера** требуют HTTPS и разрешений.
5. **Service worker** может быть очищен ОС (особенно iOS) — оболочка загрузится заново.
6. **Electron-обёртка** (`desktop/electron`) не запускает сервер сама — для этого есть
   отдельный Windows-лаунчер `release/DarkArmyDossier.exe`.
7. **Подпись кода** для Electron/APK не настроена (APK подписан debug-ключом).
8. **APK** собран как WebView-клиент (`release/DarkArmyDossier.apk`), без TWA/assetlinks;
   для PWA-установки используйте Chrome по HTTPS.
9. **PWA-ярлыки** (`shortcuts`) поддерживаются не всеми лаунчерами и браузерами.
10. **Установка по HTTP в LAN** невозможна; для телефонов без домена используйте
    самоподписанный HTTPS-порт и добавляйте сертификат в доверенные.

---

## См. также

- [02-installation.md](02-installation.md) — HTTPS-сертификат для LAN.
- [03-user-guide.md](03-user-guide.md) — интерфейс на мобильном.
- [08-security.md](08-security.md) — HTTPS и заголовки.
- [10-deployment-ubuntu.md](10-deployment-ubuntu.md) — домен и сертификаты для APK.
- [11-troubleshooting.md](11-troubleshooting.md) — «PWA не ставится».
- [12-development.md](12-development.md) — как менять `sw.js` и `manifest`.

---

## Готовые сборки и офлайн-режим (актуально)

В репозитории есть папка `release/`:

| Файл | Что это |
|---|---|
| `release/DarkArmyDossier.exe` | Windows-лаунчер (.NET Framework): запускает сервер и открывает отдельное окно Edge/Chrome |
| `release/DarkArmyDossier.apk` | Android WebView-клиент, debug-подпись; при первом запуске спрашивает адрес сервера |
| `release/README.md` | инструкции по установке/пересборке |

Иконки приложения перерисованы (`public/icons/`: 64/192/512/1024, maskable, `favicon.ico`, `app.ico`),
используются в PWA, favicon, EXE и APK.

### Офлайн-режим

- Включается в профиле (кнопка-человечек) → «Офлайн-режим».
- При включении скачиваются проекты, деревья, задачи и файлы (Cache Storage).
- Без интернета доступен только просмотр; редактирование/чат/Darcus/задачи отключаются.
- Работает по HTTPS или localhost (service worker + Cache API).
- Кнопки «Скачать сейчас» / «Очистить» управляют кэшем.

### Микрофон на HTTP

Браузер требует secure context. При нажатии микрофона по HTTP приложение предлагает
открыть HTTPS-версию (порт 7562/домен) либо записать через системный диктофон при
включённом серверном Whisper. См. [deploy/free-domain.md](../deploy/free-domain.md).
