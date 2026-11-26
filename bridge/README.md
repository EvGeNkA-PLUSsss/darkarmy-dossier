# Безопасный мост Ollama с этого ПК на сервер

Сервер Dossier не хранит модель и не устанавливает Ollama: запросы к Ollama идут
по SSH reverse-tunnel на этот ПК, только на loopback сервера.

## Как устроено

```
Dossier на сервере → http://127.0.0.1:11434 (только loopback сервера)
        ↑ SSH reverse tunnel (порт 11434)
Ваш ПК → Ollama на 127.0.0.1:11434
```

- На сервере создан пользователь `ollama-bridge` с `/bin/bash` без sudo.
- Его `authorized_keys` ограничен:
  `no-pty`, `no-agent-forwarding`, `no-X11-forwarding`,
  `permitlisten="127.0.0.1:11434"`, `command="echo ..."`.
- `GatewayPorts clientspecified`, но туннель явно биндится на `127.0.0.1`,
  поэтому из интернета порт Ollama недоступен.
- Ollama на ПК слушает только `127.0.0.1:11434`.

## Запуск/перезапуск

```powershell
powershell -ExecutionPolicy Bypass -File bridge/start-ollama-bridge.ps1
```

Или положите `bridge/start-ollama-bridge.cmd` в автозагрузку Windows
(`shell:startup`) — мост поднимется при входе в систему.

## Проверка

На сервере:

```bash
curl http://127.0.0.1:11434/api/tags
```

В Dossier: админка → Darcus → URL Ollama `http://127.0.0.1:11434`,
модели — те, что установлены на ПК (`gemma4:e4b`, `qwen2.5vl:3b`, `nomic-embed-text`).

## Отключение

Закройте процесс `ssh` с `-R 127.0.0.1:11434` или удалите файл из автозагрузки.
