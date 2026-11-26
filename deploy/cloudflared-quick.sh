#!/usr/bin/env bash
# Быстрый бесплатный HTTPS через Cloudflare Tunnel (без белого IP).
# Требует cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
set -euo pipefail
URL="${DOSSIER_LOCAL_URL:-http://127.0.0.1:7561}"
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Установите cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi
echo "Запускаю временный туннель к $URL ..."
echo "Скопируйте выданный https://*.trycloudflare.com и открывайте Dossier по нему."
exec cloudflared tunnel --url "$URL"
