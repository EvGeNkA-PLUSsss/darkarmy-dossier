#!/usr/bin/env bash
# Обновление бесплатного домена DuckDNS и выпуск сертификата.
# Использование:
#   sudo DOMAIN=darkarmy-dossier TOKEN=xxxx-xxxx bash deploy/duckdns-update.sh
set -euo pipefail
DOMAIN="${DOMAIN:?Укажите DOMAIN (без .duckdns.org)}"
TOKEN="${TOKEN:?Укажите TOKEN из личного кабинета DuckDNS}"
curl -fsS "https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}&ip="
echo
sleep 2
if command -v certbot >/dev/null 2>&1; then
  sudo certbot --nginx -d "${DOMAIN}.duckdns.org" --non-interactive --agree-tos -m "admin@${DOMAIN}.duckdns.org" || true
else
  echo "certbot не установлен: sudo apt install certbot python3-certbot-nginx"
fi
