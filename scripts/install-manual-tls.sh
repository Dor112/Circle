#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
domain=chat-circle.ru
project="${1:-/opt/krug}"
bundle="$(cd -- "$(dirname -- "$0")" && pwd)"
[[ $EUID -eq 0 ]] || { echo 'Run this helper as root in the VPS console.'; exit 1; }
[[ -d "$project" ]] || { echo 'Project directory not found.'; exit 1; }
project="$(cd -- "$project" && pwd)"
[[ -f "$project/compose.yaml" && -f "$project/Caddyfile" && -f "$project/.env" ]] || { echo 'compose.yaml, Caddyfile or .env is missing.'; exit 1; }
[[ -f "$bundle/fullchain.pem" && -f "$bundle/privkey.pem" ]] || { echo 'Certificate bundle is incomplete.'; exit 1; }
actual_domain="$(sed -n 's/^DOMAIN=//p' "$project/.env" | tr -d '\r' | head -n1)"
[[ "$actual_domain" == "$domain" ]] || { echo "Expected DOMAIN=$domain in .env. Nothing changed."; exit 1; }
openssl x509 -in "$bundle/fullchain.pem" -noout -checkhost "$domain"
openssl x509 -in "$bundle/fullchain.pem" -noout -checkend 0
openssl x509 -in "$bundle/fullchain.pem" -noout -dates
cert_pub="$(openssl x509 -in "$bundle/fullchain.pem" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256)"
key_pub="$(openssl pkey -in "$bundle/privkey.pem" -pubout -outform DER | openssl dgst -sha256)"
[[ "$cert_pub" == "$key_pub" ]] || { echo 'Certificate and key do not match. Nothing changed.'; exit 1; }
override="$project/compose.override.yaml"
marker='# Managed by Krug manual TLS helper.'
if [[ -e "$override" ]] && ! grep -qxF "$marker" "$override"; then
  echo 'An existing compose.override.yaml belongs to another setup. Nothing changed; merge the certificate mount manually.'
  exit 1
fi
backup="$(mktemp -d /root/krug-tls-backup-XXXXXXXX)"
cp -p "$project/Caddyfile" "$backup/Caddyfile"
[[ ! -f "$override" ]] || cp -p "$override" "$backup/compose.override.yaml"
mkdir -p "$project/certs"
[[ ! -f "$project/certs/fullchain.pem" ]] || cp -p "$project/certs/fullchain.pem" "$backup/fullchain.pem"
[[ ! -f "$project/certs/privkey.pem" ]] || cp -p "$project/certs/privkey.pem" "$backup/privkey.pem"
rollback() {
  local code=$?
  trap - ERR
  echo "Installation failed. Restoring previous files. Backup: $backup"
  cp -p "$backup/Caddyfile" "$project/Caddyfile"
  if [[ -f "$backup/compose.override.yaml" ]]; then cp -p "$backup/compose.override.yaml" "$override"; else rm -f -- "$override"; fi
  for f in fullchain.pem privkey.pem; do
    if [[ -f "$backup/$f" ]]; then cp -p "$backup/$f" "$project/certs/$f"; else rm -f -- "$project/certs/$f"; fi
  done
  (cd -- "$project" && docker compose up -d --no-deps --pull never --force-recreate caddy) || true
  exit "$code"
}
trap rollback ERR
install -m 600 "$bundle/fullchain.pem" "$project/certs/fullchain.pem"
install -m 600 "$bundle/privkey.pem" "$project/certs/privkey.pem"
cat > "$override" <<'YAML'
# Managed by Krug manual TLS helper.
services:
  caddy:
    volumes:
      - ./certs:/certs:ro
YAML
cat > "$project/Caddyfile" <<'CADDY'
chat-circle.ru {
    tls /certs/fullchain.pem /certs/privkey.pem
    encode zstd gzip
    reverse_proxy app:3000
}
CADDY
cd -- "$project"
docker compose config --quiet
docker compose run --rm --no-deps --pull never caddy caddy validate --config /etc/caddy/Caddyfile
docker compose up -d --no-deps --pull never --force-recreate caddy
trap - ERR
echo "Manual HTTPS configuration installed. Previous configuration and keys: $backup"
echo 'Check: docker compose ps; docker compose logs --tail=30 caddy'
echo 'The browser must accept https://chat-circle.ru without certificate warnings.'
echo 'This helper does not fix external firewall/routing or renew the certificate automatically.'
