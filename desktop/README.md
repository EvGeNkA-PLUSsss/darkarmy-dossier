# DarkArmy Dossier — ПК-приложение

Есть три способа получить «приложение», а не вкладку браузера.

## 1. PWA (рекомендуется, уже встроено)

Приложение само устанавливается с сайта. Нужен **HTTPS** (или localhost):

1. Запустите сервер и откройте Dossier по `https://…` или `http://127.0.0.1:7561`.
2. В Chrome/Edge: кнопка «Установить» в адресной строке, либо меню → «Установить приложение».
3. В приложении: «?» (Помощь) → «Установить приложение».

На телефоне:

- **Android (Chrome)**: меню ⋮ → «Добавить на главный экран» / «Установить приложение».
- **iOS (Safari)**: «Поделиться» → «На экран „Домой“».
- Микрофон и PWA на телефоне требуют HTTPS (у проекта есть HTTPS-порт 7562 или домен через nginx).

## 2. Отдельное окно на Windows без установки

Запустите сервер, затем:

```bat
desktop\open-windows-app.cmd
```

Скрипт откроет Dossier в отдельном окне Edge/Chrome (`--app=…`) без адресной строки.
Можно задать удалённый сервер:

```bat
set DOSSIER_URL=https://dossier.example.com
desktop\open-windows-app.cmd
```

## 3. Electron-приложение (.exe)

В папке `desktop/electron` лежит готовая обёртка.

```bash
cd desktop/electron
npm install
npm start            # запуск
npm run dist         # сборка Windows: dist/*.exe (NSIS + portable)
```

Переменные:

- `DOSSIER_URL` — адрес сервера (по умолчанию `http://127.0.0.1:7561`).

Сборка под Linux:

```bash
npm run dist:linux   # AppImage + deb
```

## 4. APK для Android (опционально)

PWA уже устанавливается на Android. Если нужен именно APK, используйте Bubblewrap:

```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://dossier.example.com/manifest.webmanifest
bubblewrap build
```

Требуется HTTPS-домен и подпись ключом. Готовый `app-release-signed.apk` можно раздать вручную.
