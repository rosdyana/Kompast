#!/usr/bin/env bash
# Hosted stakeholder demo — run on the demo server from a checkout of this
# repo (see docs/DEMO.md). Needs Docker with the compose plugin, plus openssl.
#
#   ./demo.sh init <url>   write infra/.env for a demo (generates every secret)
#                          e.g. ./demo.sh init https://demo.example.com
#                               ./demo.sh init http://localhost:3000   (try it on this machine, no Caddy)
#   ./demo.sh up           build images from this checkout, start everything, seed the demo
#   ./demo.sh reset        wipe and re-seed the demo data (keeps services running)
#   ./demo.sh status       containers + the URL and access code to share
#   ./demo.sh logs [svc]   follow logs (web, worker, collab, postgres, ...)
#   ./demo.sh down         stop everything (data volumes are kept)
#
# Images are built here, from whatever is checked out, rather than pulled
# from GHCR — release.yml only publishes main/tags, and a demo usually runs
# an unreleased branch. Set DEMO_PLATFORM=linux/arm64 on an ARM host.
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE=.env
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.demo.yml)
SERVICES=(migrate web collab worker)
export DEMO_PLATFORM="${DEMO_PLATFORM:-linux/amd64}"

die() { echo "✗ $*" >&2; exit 1; }
info() { echo "→ $*"; }

env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

# Sets KEY=VALUE in .env: replaces an existing (or commented-out) KEY line, else appends.
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    $0 ~ "^#? *" k "=" { if (!done) { print k "=" v; done = 1 }; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
}

rand() { openssl rand -hex "$1"; }

require_demo_env() {
  [[ -f "$ENV_FILE" ]] || die "infra/.env not found. Run: ./demo.sh init <url>"
  [[ "$(env_get DEMO_MODE)" == "true" ]] || die "DEMO_MODE=true is not set in infra/.env — refusing to treat this as a demo deployment."
  [[ -n "$(env_get DEMO_ACCESS_CODE)" ]] || die "DEMO_ACCESS_CODE is empty in infra/.env."
}

cmd_init() {
  local url="${1:-}"
  [[ "$url" =~ ^https?://[^/]+$ ]] || die "Usage: ./demo.sh init <url>   (e.g. https://demo.example.com — scheme + host, no path)"
  [[ -f "$ENV_FILE" ]] && die "infra/.env already exists. Move it aside first if you really want a fresh one (it holds the database password)."
  command -v openssl >/dev/null || die "openssl is required to generate secrets."

  cp .env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  local host ws admin_pw app_pw
  host="${url#*://}"
  if [[ "$url" == https://* ]]; then
    ws="wss://${host}/api/collab"          # through Caddy's /api/collab route
  else
    ws="ws://${host%%:*}:1234"              # local try-out: straight to the collab port
  fi
  admin_pw="$(rand 16)"
  app_pw="$(rand 16)"

  env_set APP_URL "$url"
  env_set BETTER_AUTH_URL "$url"
  env_set COLLAB_WS_URL "$ws"
  env_set POSTGRES_PASSWORD "$admin_pw"
  env_set DATABASE_ADMIN_URL "postgres://kompast_admin:${admin_pw}@postgres:5432/kompast"
  env_set DATABASE_URL "postgres://kompast_app:${app_pw}@postgres:5432/kompast"
  env_set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
  # Attachments on local disk — no GCS bucket needed for a demo. /tmp because
  # the web image runs as a non-root user; uploads don't survive a restart.
  env_set STORAGE_DRIVER local
  env_set STORAGE_LOCAL_DIR /tmp/kompast-attachments
  env_set GCS_BUCKET ""
  env_set GCS_PROJECT_ID ""
  env_set DEMO_MODE true
  env_set DEMO_ACCESS_CODE "lumen-$(rand 4)"
  # Local image names only — nothing is pulled from GHCR (see header).
  env_set GHCR_OWNER kompast-demo
  env_set IMAGE_TAG demo

  echo "✓ Wrote infra/.env for ${url}"
  echo "  Access code: $(env_get DEMO_ACCESS_CODE)   (every persona's password — share it with the audience)"
  if [[ "$url" == https://* ]]; then
    cat <<EOF

  Add this site to your Caddyfile, then reload Caddy:

  ${host} {
  	@collab path /api/collab*
  	reverse_proxy @collab 127.0.0.1:1234
  	reverse_proxy 127.0.0.1:3000
  	encode zstd gzip
  }
EOF
  fi
  echo
  echo "  Next: ./demo.sh up"
}

build_images() {
  local owner tag
  owner="$(env_get GHCR_OWNER)"
  tag="$(env_get IMAGE_TAG)"
  for svc in "${SERVICES[@]}"; do
    info "Building kompast-${svc} (${DEMO_PLATFORM}) — first build takes a few minutes"
    docker build --platform "$DEMO_PLATFORM" -f "Dockerfile.${svc}" -t "ghcr.io/${owner}/kompast-${svc}:${tag}" ..
  done
}

seed() {
  info "Seeding the demo workspace (wipes previous demo data)"
  "${COMPOSE[@]}" --profile seed run --rm --build seed-demo
}

print_share() {
  echo
  echo "✓ Demo is up"
  echo "  URL          $(env_get APP_URL)/login"
  echo "  Access code  $(env_get DEMO_ACCESS_CODE)"
  echo "  Personas     Grace (super admin) · Daniel / Priya (Software) · Joyce / Kevin (Marketing, 繁中) · Oliver (workspace admin)"
  echo "  Reset data   ./demo.sh reset"
}

cmd_up() {
  require_demo_env
  build_images
  info "Starting services"
  "${COMPOSE[@]}" up -d
  seed
  print_share
}

cmd_reset() {
  require_demo_env
  seed
  print_share
}

case "${1:-}" in
  init) shift; cmd_init "$@" ;;
  up) cmd_up ;;
  reset | seed) cmd_reset ;;
  status) require_demo_env; "${COMPOSE[@]}" ps; print_share ;;
  logs) shift; "${COMPOSE[@]}" logs -f --tail=100 "$@" ;;
  down) "${COMPOSE[@]}" down ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
