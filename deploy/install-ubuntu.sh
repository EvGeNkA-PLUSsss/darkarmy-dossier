#!/usr/bin/env bash
# Установка DarkArmy Dossier на чистый Ubuntu 22.04/24.04 (root/sudo).
# Использование:
#   sudo DOMAIN=dossier.example.com bash deploy/install-ubuntu.sh
# Скрипт ставит Node.js 22 LTS, nginx, certbot, создаёт пользователя и сервис.
set -euo pipefail

DOMAIN="${DOMAIN:-dossier.example.com}"
APP_DIR=/opt/darkarmy-dossier
DATA_DIR=/srv/darkarmy-data
PROJECTS_DIR=/srv/darkarmy-projects
NODE_MAJOR="${NODE_MAJOR:-22}"

if [[ $EUID -ne 0 ]]; then echo "Запустите через sudo"; exit 1; fi

apt-get update
apt-get install -y curl ca-certificates gnupg ufw nginx certbot python3-certbot-nginx rsync

# Node.js LTS
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

# Пользователь
id darkarmy >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APP_DIR" darkarmy
mkdir -p "$APP_DIR" "$DATA_DIR" "$PROJECTS_DIR" /srv/darkarmy-backups

# Код: копируем текущую папку (запускать из корня проекта)
if [[ ! -f "$APP_DIR/server.js" ]]; then
  rsync -a --exclude node_modules --exclude .git --exclude data --exclude backups \
    ./ "$APP_DIR/"
fi
cd "$APP_DIR"
npm ci --omit=dev || npm install --omit=dev

# .env: не перезаписываем существующий
if [[ ! -f "$APP_DIR/.env" ]]; then
  SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
  cat > "$APP_DIR/.env" <<EOF
NODE_ENV=production
BIND_HOST=127.0.0.1
PORT=7561
TRUST_PROXY=1
SESSION_SECRET=$SECRET
DATA_DIR=$DATA_DIR
PROJECTS_ROOT=$PROJECTS_DIR
BACKUP_DIR=/srv/darkarmy-backups
# Для локального HTTPS-микрофона (не обязательно за nginx):
# HTTPS_PORT=7562
# HTTPS_PFX=data/tls/dossier.pfx
# HTTPS_PFX_PASS=...
EOF
  chmod 600 "$APP_DIR/.env"
fi
chown -R darkarmy:darkarmy "$APP_DIR" "$DATA_DIR" "$PROJECTS_DIR" /srv/darkarmy-backups

# systemd
install -m 0644 deploy/darkarmy-dossier.service /etc/systemd/system/darkarmy-dossier.service
systemctl daemon-reload
systemctl enable --now darkarmy-dossier

# nginx
sed "s/dossier.example.com/$DOMAIN/g" deploy/nginx.conf > /etc/nginx/sites-available/darkarmy-dossier
ln -sf /etc/nginx/sites-available/darkarmy-dossier /etc/nginx/sites-enabled/darkarmy-dossier
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# Firewall
ufw allow OpenSSH || true
ufw allow 'Nginx Full' || true

echo
echo "Готово. Дальше:"
echo "  1) DNS A-запись $DOMAIN -> IP сервера"
echo "  2) sudo certbot --nginx -d $DOMAIN   # HTTPS"
echo "  3) Откройте https://$DOMAIN и создайте первого пользователя"
echo "  4) Ollama (если нужен Darcus): curl -fsSL https://ollama.com/install.sh | sh"
echo "     ollama pull gemma4:e4b && ollama pull qwen2.5vl:3b && ollama pull nomic-embed-text"
