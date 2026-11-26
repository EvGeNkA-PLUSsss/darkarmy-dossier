# 10. Развёртывание на Ubuntu

## Содержание

1. [Что получится](#что-получится)
2. [Требования и подготовка сервера](#требования-и-подготовка-сервера)
3. [Пользователь и каталоги](#пользователь-и-каталоги)
4. [Node.js 24](#nodejs-24)
5. [Код и зависимости](#код-и-зависимости)
6. [`.env` для production](#env-для-production)
7. [Ollama (опционально)](#ollama-опционально)
8. [systemd: автозапуск](#systemd-автозапуск)
9. [nginx: reverse proxy и HTTPS](#nginx-reverse-proxy-и-https)
10. [Альтернатива: Caddy](#альтернатива-caddy)
11. [Let's Encrypt](#lets-encrypt)
12. [Firewall и домен](#firewall-и-домен)
13. [Проверка](#проверка)
14. [Бэкапы по расписанию](#бэкапы-по-расписанию)
15. [Мониторинг и логи](#мониторинг-и-логи)
16. [Обновление](#обновление)
17. [Откат](#откат)
18. [См. также](#см-также)

---

## Что получится

```
Интернет → :443 (nginx + Let's Encrypt) → 127.0.0.1:7561 (Node, systemd)
                                            ├── SQLite data/dossier.db
                                            ├── PROJECTS_ROOT (/srv/darkarmy-projects)
                                            └── Ollama 127.0.0.1:11434 (опционально)
```

Наружу открыты только 80/443 (и SSH). Node и Ollama слушают localhost.

---

## Требования и подготовка сервера

| Параметр | Минимум | Рекомендуется |
|---|---|---|
| ОС | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| CPU | 1 vCPU | 2+ vCPU |
| RAM | 2 ГБ (без ИИ) | 8–16 ГБ (Ollama 3–4B) |
| Диск | 20 ГБ | 50+ ГБ (модели + файлы + бэкапы) |
| Домен | — | `dossier.example.com` (A-запись на IP) |
| Порты | 22, 80, 443 | те же |

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw nginx certbot python3-certbot-nginx
timedatectl set-timezone Europe/Moscow
```

---

## Пользователь и каталоги

```bash
sudo useradd -r -s /usr/sbin/nologin -d /opt/darkarmy-dossier darkarmy
sudo mkdir -p /opt/darkarmy-dossier /srv/darkarmy-projects /var/backups/darkarmy
sudo chown -R darkarmy:darkarmy /opt/darkarmy-dossier /srv/darkarmy-projects /var/backups/darkarmy
sudo chmod 750 /srv/darkarmy-projects /var/backups/darkarmy
```

---

## Node.js 24

### Вариант A: NodeSource

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # v24.x
npm -v
```

### Вариант B: nvm (для нескольких версий)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 24
nvm alias default 24
```

Для systemd нужен абсолютный путь к `node`:

```bash
which node     # /usr/bin/node или /home/…/.nvm/versions/node/v24…/bin/node
```

---

## Код и зависимости

```bash
# из git
sudo -u darkarmy git clone <repo-url> /opt/darkarmy-dossier
# или скопируйте каталог
sudo rsync -a --exclude node_modules --exclude data --exclude .git \
  ./ /opt/darkarmy-dossier/
sudo chown -R darkarmy:darkarmy /opt/darkarmy-dossier

cd /opt/darkarmy-dossier
sudo -u darkarmy npm ci --omit=dev
sudo -u darkarmy npm run check
```

### Автоматическая установка скриптом

В репозитории есть `deploy/install-ubuntu.sh` (запуск из корня проекта, от root/sudo):

```bash
sudo DOMAIN=dossier.example.com bash deploy/install-ubuntu.sh
```

Что делает скрипт:

- ставит `curl`, `ufw`, `nginx`, `certbot`, `rsync` и Node.js (`NODE_MAJOR`, по умолчанию **22**);
- создаёт пользователя `darkarmy`, каталоги `/opt/darkarmy-dossier`, `/srv/darkarmy-data`,
  `/srv/darkarmy-projects`, `/srv/darkarmy-backups`;
- копирует код в `/opt/darkarmy-dossier`, выполняет `npm ci --omit=dev`;
- создаёт `.env` (если его нет) со случайным `SESSION_SECRET`, `DATA_DIR=/srv/darkarmy-data`,
  `PROJECTS_ROOT=/srv/darkarmy-projects`, `BACKUP_DIR=/srv/darkarmy-backups`, `chmod 600`;
- устанавливает systemd-юнит из `deploy/`, включает и запускает сервис;
- подставляет домен в `deploy/nginx.conf`, включает сайт, перезагружает nginx;
- открывает `OpenSSH` и `Nginx Full` в ufw.

После скрипта вручную:

1. DNS A-запись домена на IP;
2. `sudo certbot --nginx -d <домен>` (сертификаты скрипт не получает);
3. проверить `/api/health` и войти;
4. при необходимости — Ollama и модели (подсказка печатается в конце).

⚠️ Отличия от ручной инструкции: скрипт ставит **Node 22** (а не 24) и использует
`DATA_DIR=/srv/darkarmy-data`, `BACKUP_DIR=/srv/darkarmy-backups`. Юнит `ReadWritePaths`
должен включать эти каталоги, и они должны существовать **до** запуска сервиса —
иначе systemd не сможет собрать namespace и сервис не стартует.

---

## `.env` для production

Создайте `/opt/darkarmy-dossier/.env` (владелец `darkarmy`, `chmod 600`):

```ini
NODE_ENV=production
PORT=7561
BIND_HOST=127.0.0.1
SESSION_SECRET=<64 hex-символа>
PROJECTS_ROOT=/srv/darkarmy-projects
DATA_DIR=/opt/darkarmy-dossier/data
BACKUP_DIR=/var/backups/darkarmy
TRUST_PROXY=1
LOG_LEVEL=info
LOGIN_MAX_ATTEMPTS=10

# Darcus
DARCUS_ALLOWED_HOSTS=localhost,127.0.0.1
TTS_URL=http://127.0.0.1:8765/tts
TTS_VOICE=aidar
TTS_FORMAT=wav
WHISPER_LANG=ru

# HTTPS внутри приложения не нужен — TLS терминирует nginx
HTTPS_PORT=
```

```bash
sudo -u darkarmy chmod 600 /opt/darkarmy-dossier/.env
```

Сгенерировать секрет:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

⚠️ `TRUST_PROXY=1`, а не `true`: строковое значение раньше роняло старт
(`invalid IP address`), сейчас парсится корректно, но число — точнее.

---

## Ollama (опционально)

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl status ollama
```

Ограничить прослушивание localhost (systemd drop-in):

```bash
sudo systemctl edit ollama
```

```ini
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_KEEP_ALIVE=10m"
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart ollama
curl -s http://127.0.0.1:11434/api/tags | head
```

Модели (под пользователем `ollama` или любым с доступом к API):

```bash
ollama pull gemma4:e4b
ollama pull qwen2.5vl:3b
ollama pull nomic-embed-text
```

Проверка из приложения: админка → Darcus → «Проверить связь».

⚠️ Модели скачиваются в `/usr/share/ollama/.ollama` — следите за местом на диске.

---

## systemd: автозапуск

Файл `/etc/systemd/system/darkarmy-dossier.service` (совпадает с `deploy/darkarmy-dossier.service`):

```ini
[Unit]
Description=DarkArmy Dossier
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=darkarmy
Group=darkarmy
WorkingDirectory=/opt/darkarmy-dossier
Environment=NODE_ENV=production
EnvironmentFile=/etc/darkarmy-dossier.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/darkarmy-dossier/data /var/backups/darkarmy /srv/darkarmy-projects

[Install]
WantedBy=multi-user.target
```

Секреты — отдельно от кода:

```bash
sudo install -m 600 -o root -g root /dev/null /etc/darkarmy-dossier.env
sudo tee /etc/darkarmy-dossier.env > /dev/null <<'EOF'
NODE_ENV=production
PORT=7561
BIND_HOST=127.0.0.1
SESSION_SECRET=<64 hex>
PROJECTS_ROOT=/srv/darkarmy-projects
DATA_DIR=/opt/darkarmy-dossier/data
BACKUP_DIR=/var/backups/darkarmy
TRUST_PROXY=1
DARCUS_ALLOWED_HOSTS=localhost,127.0.0.1
TTS_URL=http://127.0.0.1:8765/tts
EOF
```

Запуск:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now darkarmy-dossier
sudo systemctl status darkarmy-dossier --no-pager
curl -fsS http://127.0.0.1:7561/api/health
```

Важно:

- `ReadWritePaths` должен включать `DATA_DIR`, `BACKUP_DIR` и `PROJECTS_ROOT`, иначе
  `ProtectSystem=full` заблокирует запись; **все пути обязаны существовать до запуска**
  сервиса, иначе systemd завершится с ошибкой монтирования namespace;
- `KillSignal=SIGTERM` + `TimeoutStopSec=15` дают приложению корректно закрыться
  (flush телеметрии, `storage.close()`);
- `Password`-секреты в `EnvironmentFile` не попадают в `systemctl show` в открытом виде
  (в отличие от `Environment=`), но всё равно доступны root — ограничьте права.

### Альтернатива: PM2

```bash
sudo npm i -g pm2
cd /opt/darkarmy-dossier
sudo -u darkarmy pm2 start deploy/ecosystem.config.js
sudo -u darkarmy pm2 save
sudo env PATH=$PATH pm2 startup systemd -u darkarmy --hp /opt/darkarmy-dossier
```

`ecosystem.config.js` использует `node --env-file=.env`, `instances: 1`,
`max_memory_restart: '1G'`, логи в `data/pm2-*.log`.

---

## nginx: reverse proxy и HTTPS

Файл `/etc/nginx/sites-available/darkarmy-dossier` (совпадает с `deploy/nginx.conf`):

```nginx
upstream darkarmy_dossier {
    server 127.0.0.1:7561;
    keepalive 16;
}

server {
    listen 80;
    server_name dossier.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name dossier.example.com;

    ssl_certificate     /etc/letsencrypt/live/dossier.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dossier.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Robots-Tag "noindex, nofollow" always;

    client_max_body_size 2048m;
    client_body_timeout 300s;

    # PWA: манифест и service worker не кешируем надолго.
    location = /manifest.webmanifest {
        proxy_pass http://darkarmy_dossier;
        proxy_set_header Host $host;
        default_type application/manifest+json;
        add_header Cache-Control "no-cache";
    }
    location = /sw.js {
        proxy_pass http://darkarmy_dossier;
        proxy_set_header Host $host;
        add_header Cache-Control "no-cache";
    }

    location / {
        proxy_pass http://darkarmy_dossier;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

    location ~ ^/(api/events|api/darcus/chat)$ {
        proxy_pass http://darkarmy_dossier;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

### Почему именно так (SSE и загрузки)

| Настройка | Зачем |
|---|---|
| `proxy_http_version 1.1` + `keepalive` | SSE и стриминг без закрытия соединения |
| `proxy_buffering off` для `/api/events` и `/api/darcus/chat` | иначе события и чанки копятся в буфере и приходят «пачкой» |
| `proxy_cache off` | ответы SSE не кэшируются |
| `proxy_read_timeout 1h` | длинные стримы Darcus |
| `client_max_body_size 2048m` | загрузки до 2 ГБ |
| `location = /manifest.webmanifest` | правильный `application/manifest+json` и `no-cache` — иначе PWA может не обновиться |
| `location = /sw.js` | `no-cache`, чтобы новая версия service worker подхватывалась |
| `proxy_set_header X-Forwarded-*` | корректный IP и схема при `TRUST_PROXY=1` |
| `http2` | мультиплексирование (не заменяет SSE-настройки) |

WebSocket **не используется** — отдельного `Upgrade`-блока не нужно.

Активация:

```bash
sudo ln -s /etc/nginx/sites-available/darkarmy-dossier /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

---

## Альтернатива: Caddy

`/etc/caddy/Caddyfile` (совпадает с `deploy/Caddyfile`):

```
dossier.example.com {
	encode gzip zstd

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
		X-Robots-Tag "noindex, nofollow"
		-Server
	}

	reverse_proxy 127.0.0.1:7561 {
		flush_interval -1
		transport http {
			read_timeout 1h
			write_timeout 1h
		}
		header_up X-Real-IP {remote_host}
	}

	log {
		output file /var/log/caddy/darkarmy-dossier.log {
			roll_size 50MB
			roll_keep 10
		}
	}
}
```

```bash
sudo systemctl reload caddy
```

Caddy сам получает и продлевает сертификаты; `flush_interval -1` отключает буферизацию —
это главное для SSE.

---

## Let's Encrypt

Если используется nginx без сертификатов:

```bash
sudo certbot --nginx -d dossier.example.com --redirect --agree-tos -m admin@example.com
sudo certbot renew --dry-run
sudo systemctl list-timers | grep certbot
```

Проверка:

```bash
curl -I https://dossier.example.com
# HTTP/2 200, strict-transport-security, x-robots-tag: noindex
```

Автопродление включено пакетом (`certbot.timer`). Не забудьте открыть 80/tcp —
HTTP-01 challenge требует его.

---

## Firewall и домен

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

DNS: A-запись `dossier.example.com → <IP сервера>`, TTL 300 на время настройки.
Проверка: `dig +short dossier.example.com`.

Порт 7561 наружу **не открывайте** — он должен быть доступен только с localhost.

---

## Проверка

```bash
# 1. Приложение локально
curl -fsS http://127.0.0.1:7561/api/health | jq .

# 2. Версия
curl -fsS http://127.0.0.1:7561/api/version | jq .

# 3. Через прокси
curl -fsS https://dossier.example.com/api/health | jq .

# 4. Заголовки безопасности
curl -sI https://dossier.example.com/ | grep -Ei 'strict-transport|x-robots|x-frame|x-content'

# 5. CSP (только для Accept: text/html)
curl -sI -H 'Accept: text/html' https://dossier.example.com/ | grep -i content-security-policy

# 6. SSE не буферизуется: должны идти hello и ping
curl -N -b cookies.txt https://dossier.example.com/api/events

# 7. Логи сервиса
sudo journalctl -u darkarmy-dossier -n 50 --no-pager
```

Чек-лист после первого деплоя:

- [ ] вход под `admin` работает, пароль сменён;
- [ ] проект «Основной» создан, файл создаётся/сохраняется;
- [ ] загрузка файла 50+ МБ проходит (или упирается в понятный 413);
- [ ] SSE в браузере: статус `pending`, приходят `ping`;
- [ ] Darcus отвечает (если Ollama настроена);
- [ ] `journalctl` без `uncaughtException`;
- [ ] бэкап создаётся вручную и восстанавливается на тестовой копии.

---

## Бэкапы по расписанию

### cron

```bash
sudo crontab -u darkarmy -e
```

```cron
30 3 * * * cd /opt/darkarmy-dossier && /usr/bin/node scripts/backup.js --keep 14 --dest /var/backups/darkarmy >> /opt/darkarmy-dossier/data/backup-cron.log 2>&1
```

### systemd timer (надёжнее)

`/etc/systemd/system/darkarmy-backup.service`:

```ini
[Unit]
Description=DarkArmy Dossier backup

[Service]
Type=oneshot
User=darkarmy
Group=darkarmy
WorkingDirectory=/opt/darkarmy-dossier
ExecStart=/usr/bin/node scripts/backup.js --keep 14 --dest /var/backups/darkarmy
```

`/etc/systemd/system/darkarmy-backup.timer`:

```ini
[Unit]
Description=Daily DarkArmy Dossier backup

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now darkarmy-backup.timer
systemctl list-timers | grep darkarmy
```

Проверка восстановления — [05-data-model.md](05-data-model.md#резервное-копирование-и-восстановление).

---

## Мониторинг и логи

| Что | Как |
|---|---|
| Health | `GET /api/health` → 200/503, поля `checks` |
| Версия/сборка | `GET /api/version` |
| Лог приложения | `data/log.txt` (JSON, ротация 10 МБ × 5) |
| Systemd | `journalctl -u darkarmy-dossier -f` |
| nginx | `/var/log/nginx/access.log`, `error.log` |
| Caddy | `/var/log/caddy/darkarmy-dossier.log` |
| Дашборд | Админка → «Обзор» (размеры, модели, бэкапы) |

Простейший внешний мониторинг (cron + curl):

```bash
*/5 * * * * curl -fsS -m 10 https://dossier.example.com/api/health > /dev/null || echo "dossier DOWN $(date)" >> /var/log/dossier-alerts.log
```

Рекомендуется подключить Uptime Kuma / Zabbix / Prometheus Blackbox на `/api/health`.
Метрик Prometheus приложение не отдаёт ❌.

---

## Обновление

```bash
cd /opt/darkarmy-dossier

# 1. Бэкап ДО обновления
sudo -u darkarmy node scripts/backup.js --keep 14 --dest /var/backups/darkarmy

# 2. Код
sudo -u darkarmy git fetch --all
sudo -u darkarmy git log --oneline HEAD..origin/main | head
sudo -u darkarmy git pull --ff-only

# 3. Зависимости (без dev)
sudo -u darkarmy npm ci --omit=dev

# 4. Проверка синтаксиса
sudo -u darkarmy npm run check

# 5. Перезапуск (миграции SQLite выполнятся при старте)
sudo systemctl restart darkarmy-dossier

# 6. Проверка
curl -fsS http://127.0.0.1:7561/api/health
curl -fsS https://dossier.example.com/api/version
```

Что происходит с данными при обновлении:

- миграции идемпотентны, перед ними создаются `data/backup-pre-sqlite-*`
  и `data/backup-pre-docs-*`;
- новые поля в JSON-документах добавляются кодом при чтении;
- при смене схемы `schema_version` обновляется автоматически.

⚠️ После обновления `public/sw.js` может отдавать старую оболочку — браузер обновит её
при следующей загрузке (VERSION в `sw.js` меняется разработчиком). Если нет — `Ctrl+F5`.

---

## Откат

### Быстрый (код)

```bash
cd /opt/darkarmy-dossier
sudo -u darkarmy git log --oneline -5
sudo -u darkarmy git checkout <предыдущий-коммит>
sudo -u darkarmy npm ci --omit=dev
sudo systemctl restart darkarmy-dossier
```

### Полный (код + данные)

```bash
sudo systemctl stop darkarmy-dossier
sudo mv /opt/darkarmy-dossier/data /opt/darkarmy-dossier/data.broken-$(date +%s)
sudo cp -a /var/backups/darkarmy/<timestamp>/data /opt/darkarmy-dossier/data
sudo cp /var/backups/darkarmy/<timestamp>/dossier.db /opt/darkarmy-dossier/data/dossier.db
sudo rsync -a /var/backups/darkarmy/<timestamp>/projects/ /srv/darkarmy-projects/
sudo chown -R darkarmy:darkarmy /opt/darkarmy-dossier/data /srv/darkarmy-projects
sudo systemctl start darkarmy-dossier
curl -fsS http://127.0.0.1:7561/api/health
```

Если обновление меняло схему, а вы откатываетесь на старый код — **обязательно**
восстанавливайте БД из бэкапа, сделанного до обновления: старый код может не понять
новые поля.

---

## См. также

- [01-architecture.md](01-architecture.md) — что именно запускается.
- [02-installation.md](02-installation.md) — установка и `.env` на Windows.
- [05-data-model.md](05-data-model.md) — бэкап и восстановление данных.
- [08-security.md](08-security.md) — чек-лист и TLS.
- [09-desktop-mobile-pwa.md](09-desktop-mobile-pwa.md) — домен для APK.
- [11-troubleshooting.md](11-troubleshooting.md) — nginx 502/413/SSE.
- [13-admin-guide.md](13-admin-guide.md) — эксплуатация из админки.
