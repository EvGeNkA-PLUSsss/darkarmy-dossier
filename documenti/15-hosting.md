# 15. Хостинг, тарифы и мост Ollama

## Официальный hosted

- **Web — бесплатно:** https://147-45-78-20.sslip.io:8443/
- **Darcus AI — 250 ₽/мес:** доступ и оплата через Telegram **@AgroDeveloper**.
- AI-подписка включает Darcus и лимит файла **500 МБ**; без подписки — 50 МБ.
- Регистрация/доступ: написать в Telegram; админ выдаёт учётку/код подписки.
- Сайт проекта: https://evgenka-plussss.github.io/darkarmy-dossier/
- Исходники/релизы: https://github.com/EvGeNkA-PLUSsss/darkarmy-dossier

### Сервер

Ubuntu 22.04, приложение в `/opt/darkarmy-dossier`, данные `/srv/darkarmy-data`,
проекты `/srv/darkarmy-projects`, systemd `darkarmy-dossier`, nginx + Let's Encrypt
на **8443** (443 занят xray, не трогаем). HTTP 80 → redirect, ACME webroot для продления.

## Мост Ollama с домашнего ПК (без установки Ollama на сервер)

Сервер получает Ollama через SSH reverse-tunnel:

```
Dossier (server) → 127.0.0.1:11434 → SSH → Ollama на ПК (127.0.0.1:11434)
```

- Отдельный пользователь `ollama-bridge`, ключ `~/.ssh/darkarmy_ollama_bridge`.
- Ограничения в `authorized_keys`: `no-pty`, `no-agent-forwarding`, `no-X11-forwarding`,
  `permitlisten="127.0.0.1:11434"`, `command="echo ..."`.
- Туннель слушает только loopback сервера; из интернета Ollama недоступна.
- Запуск на ПК: `bridge/start-ollama-bridge.ps1` (добавлен в автозагрузку).
- URL в админке: `http://127.0.0.1:11434`, модели — установленные на ПК.
- Проверка с сервера: `curl http://127.0.0.1:11434/api/tags`.

## Безопасность

- Не устанавливайте Ollama на публичный сервер с 4 ГБ RAM без необходимости.
- Не открывайте 11434 наружу; используйте только туннель.
- Для hosted AI лучше держать ПК включённым; при выключении моста Darcus вернёт ошибку.
