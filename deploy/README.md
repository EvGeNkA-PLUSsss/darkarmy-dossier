# Развёртывание DarkArmy Dossier в production

Пошаговая инструкция: домен, HTTPS, автозапуск, бэкапы и обновления.
Предполагается, что сервис уже запускается локально (`npm start`).

## 1. Требования

- Node.js **20+** (рекомендуется 24);
- 2 ГБ RAM минимум (Darcus с Ollama — отдельно, обычно 8+ ГБ);
- домен (для HTTPS из интернета) и открытые порты 80/443;
- каталог для файлов проектов (например, `F:/Проекты` или `/srv/darkarmy-projects`);
- Ollama — если нужен Darcus (локально, без внешних API).

## 2. Подготовка окружения

```bash
cp .env.example .env
```

Заполнить `.env`:

```ini
NODE_ENV=production
PORT=7561
BIND_HOST=127.0.0.1          # наружу смотрит только reverse proxy
SESSION_SECRET=<64 hex>      # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
PROJECTS_ROOT=/srv/darkarmy-projects
TRUST_PROXY=1                # 1 хоп: Caddy/nginx перед приложением
```

Права на файлы:

```bash
chown -R darkarmy:darkarmy /opt/darkarmy-dossier/data /srv/darkarmy-projects
chmod 600 /opt/darkarmy-dossier/.env
```

Проверка запуска:

```bash
NODE_ENV=production node --env-file=.env server.js
curl -fsS http://127.0.0.1:7561/api/health
```

Ожидаемый ответ: `{"status":"ok",...,"checks":{"db":true,...}}`.

## 3. HTTPS reverse proxy

### Вариант A — Caddy (проще всего, автоматические сертификаты)

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
# заменить dossier.example.com на свой домен
sudo systemctl reload caddy
```

Caddy сам получит Let's Encrypt-сертификат и будет проксировать на `127.0.0.1:7561`,
включая SSE без буферизации.

### Вариант B — nginx

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/darkarmy-dossier
sudo ln -s /etc/nginx/sites-available/darkarmy-dossier /etc/nginx/sites-enabled/
sudo certbot --nginx -d dossier.example.com
sudo nginx -t && sudo systemctl reload nginx
```

После включения прокси перезапустите сервис (нужен `TRUST_PROXY=1`).

## 4. Автозапуск

### Windows (Планировщик задач)

```powershell
# от администратора
powershell -ExecutionPolicy Bypass -File deploy\install-task.ps1
# ежедневный бэкап в 03:30, хранить 7 копий
powershell -ExecutionPolicy Bypass -File deploy\install-backup-task.ps1
```

Проверка: `Get-ScheduledTask -TaskName "DarkArmy Dossier" | Get-ScheduledTaskInfo`.

### Linux (systemd)

```bash
sudo useradd -r -s /usr/sbin/nologin darkarmy
sudo mkdir -p /opt/darkarmy-dossier && sudo cp -r . /opt/darkarmy-dossier
sudo cp deploy/darkarmy-dossier.service /etc/systemd/system/
# создать /etc/darkarmy-dossier.env с переменными окружения
sudo systemctl daemon-reload
sudo systemctl enable --now darkarmy-dossier
sudo systemctl status darkarmy-dossier
```

### PM2 (любая ОС)

```bash
npm i -g pm2
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup          # выполнить команду, которую он выведет
```

## 5. Бэкапы

- `npm run backup` — консистентная копия SQLite (через backup API), JSON-архива и файлов проектов.
- Windows: задача из `deploy/install-backup-task.ps1` (ежедневно).
- Linux: cron или таймер:

```cron
30 3 * * * cd /opt/darkarmy-dossier && /usr/bin/node scripts/backup.js --keep 14 >> data/backup-cron.log 2>&1
```

Проверка восстановления (обязательно раз в месяц):

```bash
# остановить сервис
sudo systemctl stop darkarmy-dossier
# восстановить БД и файлы из backups/<дата>/
cp backups/<дата>/dossier.db data/dossier.db
# запустить и проверить /api/health и вход
```

## 6. Обновление

```bash
git pull
npm ci --omit=dev
node --check server.js
# миграции SQLite выполняются автоматически при старте (с резервной копией JSON)
sudo systemctl restart darkarmy-dossier
curl -fsS https://dossier.example.com/api/health
```

Перед обновлением всегда: `npm run backup`.

## 7. Мониторинг и логи

- Health: `GET /api/health` (200/503).
- Админка → «Обзор»: состояние БД, размеры, модели Ollama, бэкапы.
- Логи: `data/log.txt` (JSON-строки, ротация при 10 МБ), PM2/systemd journal.
- Активные сессии и уведомления видны в админ-дашборде.

## 8. Чек-лист безопасности перед публикацией

- [ ] `NODE_ENV=production`, задан `SESSION_SECRET`;
- [ ] `BIND_HOST=127.0.0.1`, наружу — только HTTPS прокси;
- [ ] `TRUST_PROXY` соответствует числу прокси;
- [ ] сменён пароль администратора (стартовый пароль был в консоли);
- [ ] `data/` и `PROJECTS_ROOT` закрыты правами ОС от посторонних;
- [ ] настроен ежедневный бэкап и проверено восстановление;
- [ ] `.env` не в git (`.gitignore` это гарантирует);
- [ ] включены `X-Robots-Tag: noindex` и HSTS (сервер и прокси);
- [ ] при доступе из интернета проверьте логи на подозрительные входы.

## 9. Частые проблемы

| Симптом | Причина / решение |
|---|---|
| `SESSION_SECRET обязателен в production` | не задан `.env` или переменная пустая |
| `Empty reply` / обрыв SSE | у прокси включена буферизация — используйте конфиг из `deploy/` |
| `invalid IP address` при старте | `TRUST_PROXY=true` замените на `1` или `false` |
| 413 при загрузке | лимит прокси (`client_max_body_size`) или настройки загрузки в админке |
| Сессии теряются при рестарте | не задан постоянный `SESSION_SECRET` |
| Darcus не отвечает | Ollama не запущена или модели не установлены (статус в админ-дашборде) |
