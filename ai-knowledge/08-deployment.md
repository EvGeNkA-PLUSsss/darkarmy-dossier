# Установка и развёртывание

## Windows (локально)

```bat
npm install
copy .env.example .env
npm start
```

Открыть `http://127.0.0.1:7561`.

## Ubuntu (интернет)

1. DNS: A-запись домена → IP сервера.
2. Установить Node 20/22, nginx, certbot.
3. Скопировать проект, `npm ci --omit=dev`.
4. Настроить `.env`: `BIND_HOST=127.0.0.1`, `TRUST_PROXY=1`, `NODE_ENV=production`, `SESSION_SECRET`.
5. systemd unit + nginx reverse proxy.
6. `certbot --nginx -d domain`.
7. Открыть 80/443, проверить `/api/health` и SSE.

Готовый скрипт: `deploy/install-ubuntu.sh`, конфиги в `deploy/nginx.conf`, `deploy/Caddyfile`.

## Бесплатный домен для IP

Варианты:
- **sslip.io** — домен из IP: `192-168-1-10.sslip.io` (для публичного IP: `1-2-3-4.sslip.io`).
- **DuckDNS** — бесплатный поддомен `name.duckdns.org`, обновляется токеном.
- **FreeDNS (afraid.org)** — много доменов.
- **Cloudflare Tunnel** — без белого IP, выдаёт `*.trycloudflare.com`/свой домен.
- **Tailscale Funnel** — приватная сеть + HTTPS.

Для Let's Encrypt нужен домен, указывающий на IP, и открытые 80/443. Для sslip.io:
```
sudo certbot --nginx -d 1-2-3-4.sslip.io
```
Caddy сделает сертификат автоматически.

## Микрофон и PWA

Требуется HTTPS (или localhost). После настройки домена откройте `https://домен`,
установите PWA, разрешите микрофон.
