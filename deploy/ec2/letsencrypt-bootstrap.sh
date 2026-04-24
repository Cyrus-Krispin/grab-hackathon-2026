#!/usr/bin/env bash
# Run on the EC2 host (Amazon Linux 2023) with sudo. Repo nginx config is already installed
# to /etc/nginx/conf.d/ride-comfort.conf with /.well-known/acme-challenge/ on port 80.
#
# Before running:
#   1. Create a DNS A record: YOUR_HOSTNAME -> this instance's public IP (e.g. 54.169.70.247).
#   2. Wait for DNS to propagate; confirm: dig +short YOUR_HOSTNAME
#   3. Security group: allow 80 and 443 from the internet.
#
# Usage (replace with your values):
#   cd ~/grab-hackathon-2026/deploy/ec2
#   sudo DOMAIN=ride-api.example.com CERTBOT_EMAIL=you@example.com ./letsencrypt-bootstrap.sh
#
# After success: use https://YOUR_HOSTNAME/ in browsers and in RIDE_API_UPSTREAM.
# (HTTPS to the raw IP will still not match the cert; use the hostname.)
set -euo pipefail

DOMAIN="${DOMAIN:-}"
EMAIL="${CERTBOT_EMAIL:-${LE_EMAIL:-${EMAIL:-}}}"

[ "${EUID:-0}" -eq 0 ] || { echo "Run with sudo" >&2; exit 1; }
[ -n "$DOMAIN" ] || { echo "Set DOMAIN=your.api.hostname" >&2; exit 1; }
[ -n "$EMAIL" ] || { echo "Set CERTBOT_EMAIL=you@example.com  (for Let's Encrypt notices)" >&2; exit 1; }

NGINX_CONF="/etc/nginx/conf.d/ride-comfort.conf"
WEBROOT="/var/www/certbot"

if [ ! -f "$NGINX_CONF" ]; then
  echo "Missing $NGINX_CONF. Deploy the app first (install deploy/ec2/ride-comfort.nginx.conf)." >&2
  exit 1
fi

if ! command -v certbot &>/dev/null; then
  dnf install -y certbot
fi

mkdir -p "$WEBROOT"
chown -R nginx:nginx /var/www 2>/dev/null || chown -R ec2-user:ec2-user /var/www 2>/dev/null || true
nginx -t
systemctl reload nginx

echo "Obtaining certificate for $DOMAIN (HTTP-01)..."
certbot certonly \
  --webroot \
  -w "$WEBROOT" \
  -d "$DOMAIN" \
  --non-interactive \
  --agree-tos \
  -m "$EMAIL" \
  --keep-until-expiring

LIVE="/etc/letsencrypt/live/${DOMAIN}"
[ -f "${LIVE}/fullchain.pem" ] && [ -f "${LIVE}/privkey.pem" ] || {
  echo "Expected files not found under $LIVE" >&2
  exit 1
}

Bak="${NGINX_CONF}.bak.letsencrypt.$(date +%s)"
cp -a "$NGINX_CONF" "$Bak"
echo "Backed up: $Bak"

sed -i \
  -e "s|server_name 54.169.70.247 _;|server_name ${DOMAIN} 54.169.70.247 _;|g" \
  -e "s|ssl_certificate     /etc/pki/ride-comfort/fullchain.pem;|ssl_certificate     ${LIVE}/fullchain.pem;|g" \
  -e "s|ssl_certificate_key /etc/pki/ride-comfort/privkey.pem;|ssl_certificate_key ${LIVE}/privkey.pem;|g" \
  "$NGINX_CONF"

nginx -t
systemctl reload nginx

# Reload nginx when certbot auto-renews
HOOK_DIR="/etc/letsencrypt/renewal-hooks/deploy"
mkdir -p "$HOOK_DIR"
if [ ! -f "${HOOK_DIR}/01-reload-nginx.sh" ]; then
  cat >"${HOOK_DIR}/01-reload-nginx.sh" <<'H'
#!/bin/sh
systemctl reload nginx
H
  chmod +x "${HOOK_DIR}/01-reload-nginx.sh"
fi

echo
echo "Done. Test from your laptop (no -k should be required):"
echo "  curl -fsS 'https://${DOMAIN}/health'"
echo
echo "Set Vercel RIDE_API_UPSTREAM=https://${DOMAIN}   (no trailing slash)"
echo "You can remove RIDE_API_TLS_INSECURE=1 if you added it for self-signed only."
echo
if certbot renew --dry-run &>/dev/null; then
  echo "certbot renew --dry-run: OK"
else
  echo "Run later: sudo certbot renew --dry-run"
fi
