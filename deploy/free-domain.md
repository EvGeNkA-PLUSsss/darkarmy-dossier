# Бесплатный домен для IP и HTTPS

Нужен для PWA, микрофона и нормального HTTPS. Полностью бесплатный **свой** домен
(например `dossier.ru`) получить нельзя, но бесплатные поддомены — можно.

## Вариант 1. sslip.io (самый быстрый, без регистрации)

Если у сервера **публичный IP** `1.2.3.4`, домен уже существует:

```
1-2-3-4.sslip.io
```

1. В DNS ничего настраивать не нужно.
2. В nginx/Caddy укажите этот домен.
3. Откройте порты 80/443.
4. Выпустите сертификат:

```bash
sudo certbot --nginx -d 1-2-3-4.sslip.io
# или Caddy сам выпустит сертификат
```

Плюс: 2 минуты, без аккаунта. Минус: домен привязан к IP; при смене IP — новый домен.

## Вариант 2. DuckDNS (бесплатный поддомен, обновляемый)

1. Зарегистрируйтесь на https://www.duckdns.org.
2. Создайте домен `darkarmy-dossier.duckdns.org`.
3. Укажите IP сервера.
4. Автообновление IP (cron):

```bash
# /etc/cron.d/duckdns
*/5 * * * * root curl -fsS "https://www.duckdns.org/update?domains=darkarmy-dossier&token=ВАШ_ТОКЕН&ip=" >/dev/null
```

5. В nginx: `server_name darkarmy-dossier.duckdns.org;`
6. `sudo certbot --nginx -d darkarmy-dossier.duckdns.org`

Скрипт: `deploy/duckdns-update.sh`.

## Вариант 3. Cloudflare Tunnel (даже без белого IP)

Бесплатно, HTTPS автоматически, не нужен открытый порт:

```bash
# быстрый временный туннель (ссылка *.trycloudflare.com)
cloudflared tunnel --url http://127.0.0.1:7561
```

Для постоянного домена:

```bash
cloudflared tunnel login
cloudflared tunnel create dossier
cloudflared tunnel route dns dossier dossier.example.com
cloudflared tunnel run dossier
```

Плюс: работает за NAT/CGNAT. Минус: трафик идёт через Cloudflare; для приватных
данных учитывайте политику.

Скрипт быстрого запуска: `deploy/cloudflared-quick.sh`.

## Вариант 4. Tailscale Funnel

Если сервер и клиенты в Tailscale:

```bash
tailscale funnel 7561
```

Даёт HTTPS-адрес `*.tailscale.com`, доступный снаружи.

## Вариант 5. FreeDNS / afraid.org

Бесплатные поддомены вида `name.afraid.org`; настройка A-записи вручную.

---

## После получения домена

1. `server_name YOUR_DOMAIN;` в nginx или блок Caddy.
2. `sudo certbot --nginx -d YOUR_DOMAIN`
3. Откройте `https://YOUR_DOMAIN` — PWA установится, микрофон заработает.
4. В приложении/APK укажите этот адрес.
5. Проверьте: `curl -I https://YOUR_DOMAIN/api/health`.

### Если IP за NAT

Порт 80/443 недоступен → Let's Encrypt HTTP-01 не сработает. Используйте
Cloudflare Tunnel / Tailscale Funnel либо DNS-01 (нужен API DNS-провайдера).
