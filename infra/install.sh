#!/usr/bin/env bash
# Kompast production installer for a fresh Debian/Ubuntu VM (x86_64, e.g. GCP).
#
#   curl -fsSL https://github.com/rosdyana/kompast/releases/latest/download/install.sh | sudo bash
#
# Full usage, flags and environment variables: run with --help.
# Single file on purpose: the curl | bash path only has this script.

# Set by .github/workflows/release.yml in the copy attached to a GitHub Release
# (e.g. "v0.4.0"): that release's runtime files and images are what this
# script installs. Empty in a checkout or on a branch.
KOMPAST_RELEASE=""

print_usage() {
  cat <<'EOF'
Kompast production installer (Debian/Ubuntu, x86_64). Images come from GHCR; no clone needed.

Install the latest release, as root:
  curl -fsSL https://github.com/rosdyana/kompast/releases/latest/download/install.sh | sudo bash
Or verify the script before running it:
  curl -fsSLO https://github.com/rosdyana/kompast/releases/latest/download/install.sh
  curl -fsSLO https://github.com/rosdyana/kompast/releases/latest/download/SHA256SUMS
  sha256sum --check --ignore-missing SHA256SUMS && sudo bash install.sh
Or from a checkout (copies its infra/ files instead of downloading them):
  git clone https://github.com/rosdyana/kompast.git && cd kompast && sudo ./infra/install.sh
Private repo: export GITHUB_TOKEN and run with sudo -E (downloads go through the GitHub API).

Runtime files (docker-compose.yml, backup.sh, ...) come from a GitHub Release and are checked
against its SHA256SUMS before use; IMAGE_TAG defaults to that release's version.

Modes (chosen automatically):
  install      no $KOMPAST_DIR/.env yet: asks the questions, generates secrets, deploys
  upgrade      .env exists: refreshes runtime files, backs up the DB, pulls and restarts
  reconfigure  --reconfigure: re-asks domain/storage/proxy/backups with current values as
               defaults. Never regenerates secrets; .env is copied to .env.bak-<timestamp> first

Flags:
  --check                 preflight only: changes nothing, downloads nothing, writes no log
  --yes, -y               non-interactive: take KOMPAST_* values or defaults, never prompt
  --reconfigure           see above
  --skip-backup           upgrade: skip the pre-upgrade database backup (not recommended)
  --skip-connection-test  skip the port-80 reachability test before Caddy is configured
  --help, -h              this text

Environment (pre-answers; with --yes they are used without asking, otherwise they are the default):
  KOMPAST_DIR                     install directory (default /opt/kompast)
  KOMPAST_DOMAIN                  bare host, e.g. kompast.example.com
  KOMPAST_GHCR_OWNER              GitHub owner of the images (default rosdyana)
  KOMPAST_IMAGE_TAG               image tag (default: the release being installed, e.g. 0.4.0)
  GHCR_USER, GHCR_TOKEN           only for private images: GitHub user + PAT with read:packages
  KOMPAST_STORAGE                 gcs | local (default gcs)
  KOMPAST_GCS_BUCKET              bucket name, no gs://
  KOMPAST_GCS_PROJECT             GCP project id (default: from the GCE metadata server)
  KOMPAST_GCS_KEY_FILE            service-account JSON on this host (default secrets/gcs-service-account.json)
  KOMPAST_PROXY                   caddy | none (default caddy)
  KOMPAST_BACKUP                  local | local+gcs | none (default local)
  KOMPAST_BACKUP_DIR              local dump directory (default /var/backups/kompast)
  KOMPAST_BACKUP_RETENTION_DAYS   default 14
  KOMPAST_BACKUP_GCS_URI          gs://bucket[/prefix], required when KOMPAST_BACKUP=local+gcs
  KOMPAST_REPO                    GitHub repo for downloads (default rosdyana/kompast)
  KOMPAST_VERSION                 release to install, e.g. v0.4.0 (default: this script's release,
                                  else the latest release)
  KOMPAST_REF                     TESTING ONLY: download runtime files from a branch/commit instead
                                  of a release. Unverified (no checksums); IMAGE_TAG is not moved
  GITHUB_TOKEN                    private repo: authenticate downloads (GitHub API)
  DEBUG=1                         trace every command with set -x into the log. The trace includes
                                  generated secrets, so do not share the log

Logs: every non-check run appends to /var/log/kompast-install.log. A failure prints the step that
failed and that path.

Afterwards, the `kompast` command manages the install: status, logs, restart, upgrade, check,
reconfigure, backup, backups, restore, version, cleanup.

Copy $KOMPAST_DIR/.env off the VM. BETTER_AUTH_SECRET also encrypts the secrets saved in
/setup and /settings: lose it and those cannot be recovered.
EOF
}

main() {
  set -Eeuo pipefail

  # ===== Globals =============================================================
  KOMPAST_DIR="${KOMPAST_DIR:-/opt/kompast}"
  ENV_FILE="$KOMPAST_DIR/.env"
  BACKUP_CRON=/etc/cron.d/kompast-backup
  CADDYFILE=/etc/caddy/Caddyfile
  LOG_FILE=""
  STEP_NO=0
  CURRENT_STEP="startup"
  CHECK_ONLY=0 YES=0 RECONFIGURE=0 SKIP_BACKUP=0 SKIP_CONN_TEST=0
  MODE=""
  DOMAIN="" WANT_CADDY=0 BACKUP_ON=0 PREV_TAG=""
  SRC_DIR=""
  OS_ID="" OS_CODENAME="" OS_PRETTY=""
  GCP_IP="" GCP_PROJECT="" GCP_ZONE="" ON_GCP=0
  DOCKER_NEEDS_INSTALL=0
  MISSING_TOOLS=() CHECK_ROWS=()
  N_FAIL=0 N_WARN=0
  ANS_DOMAIN="" ANS_GHCR_OWNER="" ANS_IMAGE_TAG="" ANS_PRIVATE=0
  ANS_STORAGE="" ANS_GCS_BUCKET="" ANS_GCS_PROJECT="" ANS_SA_PATH=""
  ANS_PROXY="" ANS_BACKUP="" ANS_BK_DIR="" ANS_BK_RETENTION="" ANS_BK_URI=""
  GHCR_USER="${GHCR_USER:-}" GHCR_TOKEN="${GHCR_TOKEN:-}" SWAP_CREATED=0
  export DEBIAN_FRONTEND=noninteractive

  if [[ -t 1 ]]; then
    C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_WARN=$'\033[33m'; C_OFF=$'\033[0m'
  else
    C_OK=''; C_ERR=''; C_WARN=''; C_OFF=''
  fi

  # ===== Arguments ===========================================================
  local arg
  for arg in "$@"; do
    case "$arg" in
      --check) CHECK_ONLY=1 ;;
      -y | --yes) YES=1 ;;
      --reconfigure) RECONFIGURE=1 ;;
      --skip-backup) SKIP_BACKUP=1 ;;
      --skip-connection-test) SKIP_CONN_TEST=1 ;;
      -h | --help | help) print_usage; exit 0 ;;
      *) print_usage >&2; die "Unknown argument: $arg" ;;
    esac
  done

  resolve_source
  if (( CHECK_ONLY == 0 )); then
    start_log
  fi
  if [[ "${DEBUG:-0}" == 1 ]]; then
    set -x
  fi
  trap on_error ERR

  # ===== 1. Preflight (no changes) ============================================
  step "Preflight checks"
  run_preflight
  print_checks
  if (( N_FAIL > 0 )) && (( CHECK_ONLY == 0 )) && (( ${#MISSING_TOOLS[@]} > 0 )); then
    if confirm "Install the missing tools (${MISSING_TOOLS[*]}) with apt now?" Y; then
      step "Install missing tools"
      apt-get update -qq </dev/null
      apt-get install -y -qq "${MISSING_TOOLS[@]}" </dev/null >/dev/null
      run_preflight
      print_checks
    fi
  fi
  (( N_FAIL == 0 )) || die "Preflight failed; nothing was changed. Fix the ✗ items and re-run."

  if (( CHECK_ONLY )); then
    print_gcp_hint
    (( N_WARN == 0 )) || warn "$N_WARN warning(s): a real install asks whether to continue."
    ok "Preflight passed. --check changed nothing and downloaded nothing."
    exit 0
  fi

  if (( YES == 0 )); then
    have_tty || die "No terminal (/dev/tty). Run from an SSH session, or pre-answer every question and pass --yes."
  fi
  print_gcp_hint
  (( N_WARN == 0 )) || confirm "Continue despite the $N_WARN warning(s) above?" Y \
    || die "Stopped at warnings; nothing was changed."

  # ===== 2. Install directory and mode ========================================
  step "Install directory"
  answer KOMPAST_DIR "Install directory" "$KOMPAST_DIR" '^/[^[:space:]]+$' \
    "Use an absolute path without spaces." KOMPAST_DIR
  ENV_FILE="$KOMPAST_DIR/.env"
  if (( RECONFIGURE )); then
    [[ -f "$ENV_FILE" ]] || die "--reconfigure needs an existing $ENV_FILE (nothing to reconfigure)."
    MODE=reconfigure
  elif [[ -f "$ENV_FILE" ]]; then
    MODE=upgrade
  else
    MODE=install
  fi
  ok "Mode: $MODE, directory: $KOMPAST_DIR"

  # ===== 3. Prerequisites =====================================================
  step "Prerequisites"
  if (( DOCKER_NEEDS_INSTALL )); then
    confirm "Docker Engine >= 24 and compose >= 2.20 are needed. Install or upgrade them from Docker's official apt repository?" Y \
      || die "Docker is required; nothing was changed."
    install_docker
  else
    ok "Docker and compose are new enough"
  fi
  ensure_swap

  # ===== 4. Runtime files =====================================================
  step "Runtime files"
  sync_runtime_files
  cd "$KOMPAST_DIR"

  # ===== 5. Answers and configuration =========================================
  case "$MODE" in
    install)
      init_answers
      collect_answers_loop
      install_apply
      ;;
    reconfigure)
      init_answers
      collect_answers_loop
      reconfigure_apply
      ;;
    upgrade)
      step "Upgrade options"
      upgrade_options
      ;;
  esac

  # ===== 6. Wrapper, deploy, verify ===========================================
  step "Command wrapper"
  install_wrapper
  deploy_and_verify
  print_summary
}

# ============================================================================
# Output, logging, steps, prompts
# ============================================================================

die()  { echo "${C_ERR}✗${C_OFF} $*" >&2; exit 1; }
ok()   { echo "${C_OK}✓${C_OFF} $*"; }
warn() { echo "${C_WARN}!${C_OFF} $*"; }
info() { echo "→ $*"; }

step() {
  STEP_NO=$((STEP_NO + 1))
  CURRENT_STEP="$STEP_NO. $1"
  echo
  echo "== $CURRENT_STEP =="
}

start_log() {
  LOG_FILE=/var/log/kompast-install.log
  mkdir -p /var/log
  touch "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  exec > >(tee -a "$LOG_FILE") 2>&1
  echo
  echo "===== $(date -Is) kompast install.sh (yes=$YES reconfigure=$RECONFIGURE skip_backup=$SKIP_BACKUP) ====="
}

on_error() {
  local rc=$?
  echo "${C_ERR}✗${C_OFF} Failed during step: ${CURRENT_STEP}.${LOG_FILE:+ Full log: $LOG_FILE}" >&2
  exit "$rc"
}

have_tty() { (exec </dev/tty) 2>/dev/null; }

# ask VAR "Prompt" [default] — interactive only; reads the terminal, never stdin
ask() {
  local __var="$1" __prompt="$2" __def="${3:-}" __reply=""
  have_tty || die "No terminal to answer '$__prompt'. Pre-answer it with a KOMPAST_* variable and --yes."
  if [[ -n "$__def" ]]; then
    read -r -p "$__prompt [$__def]: " __reply </dev/tty || die "Input closed."
  else
    read -r -p "$__prompt: " __reply </dev/tty || die "Input closed."
  fi
  printf -v "$__var" '%s' "${__reply:-$__def}"
}

# answer VAR "Prompt" default regex "message" [ENVVAR]
#   ENVVAR set  -> its value is the default (and the value used with --yes)
#   --yes       -> the default, or die if it does not match the regex
#   otherwise   -> prompt until the answer matches the regex
answer() {
  local __v="$1" __p="$2" __d="$3" __re="$4" __msg="$5" __env="${6:-}" __val=""
  if [[ -n "$__env" ]]; then
    local __ev="${!__env:-}"
    if [[ -n "$__ev" ]]; then __d="$__ev"; fi
  fi
  if (( YES )); then
    __val="$__d"
    [[ "$__val" =~ $__re ]] || die "$__p: '${__val}' is missing or invalid. ${__msg}${__env:+ (set $__env)}"
  else
    while true; do
      ask __val "$__p" "$__d"
      if [[ "$__val" =~ $__re ]]; then break; fi
      warn "$__msg"
    done
  fi
  printf -v "$__v" '%s' "$__val"
}

# confirm "question" [Y|N] — 0 = yes. --yes answers with the default; no terminal = no
confirm() {
  local q="$1" def="${2:-Y}" hint="[Y/n]" ans=""
  if [[ "$def" == N ]]; then hint="[y/N]"; fi
  if (( YES )); then
    [[ "$def" == Y ]]
    return
  fi
  have_tty || return 1
  read -r -p "$q $hint " ans </dev/tty || return 1
  ans="${ans:-$def}"
  [[ "$ans" =~ ^[Yy] ]]
}

ask_secret() {
  local __var="$1" __prompt="$2" __reply=""
  have_tty || die "No terminal to read '$__prompt' from."
  read -r -s -p "$__prompt: " __reply </dev/tty || die "Input closed."
  echo
  printf -v "$__var" '%s' "$__reply"
}

# ============================================================================
# .env helpers (uncommented KEY= lines only, so commented examples are never touched)
# ============================================================================

env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 }; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

backup_env_file() {
  local bak stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  bak="$ENV_FILE.bak-$stamp"
  # umask in a subshell: the backup is created 0600 from the start, not
  # world-readable until the chmod below runs.
  (umask 077; cp -p "$ENV_FILE" "$bak")
  chmod 600 "$bak"
  ok "Saved the current .env as $bak"
}

rand_hex() { openssl rand -hex "$1"; }

# Redis requires a password (docker-compose.yml). The hex value needs no
# URL-escaping inside REDIS_URL. Only the Redis pair is written here.
set_redis_secret() {
  local pw
  pw="$(rand_hex 24)"
  env_set REDIS_PASSWORD "$pw"
  env_set REDIS_URL "redis://:${pw}@redis:6379"
}

# The non-superuser, RLS-exempt role web/collab/worker use instead of the
# Postgres superuser (migrate creates it from this URL). Hex password: no
# URL-escaping needed.
set_service_db_secret() {
  env_set DATABASE_SERVICE_URL "postgres://kompast_service:$(rand_hex 24)@postgres:5432/kompast"
}

# Installs from before Redis auth / the DB role split lack these. Adds only
# what's missing (backing up .env first); every other secret is untouched.
add_missing_runtime_secrets() {
  local backed_up=0
  if [[ -z "$(env_get REDIS_PASSWORD)" ]]; then
    backup_env_file; backed_up=1
    set_redis_secret
    ok "Generated REDIS_PASSWORD (Redis now requires a password; other secrets untouched)"
  fi
  if [[ -z "$(env_get DATABASE_SERVICE_URL)" ]]; then
    (( backed_up )) || backup_env_file
    set_service_db_secret
    ok "Generated DATABASE_SERVICE_URL (app containers no longer get the Postgres superuser; other secrets untouched)"
  fi
}

# ============================================================================
# Preflight (no changes)
# ============================================================================

record() {
  CHECK_ROWS+=("$1|$2|$3")
  case "$1" in
    FAIL) N_FAIL=$((N_FAIL + 1)) ;;
    WARN) N_WARN=$((N_WARN + 1)) ;;
  esac
}

print_checks() {
  local row st name detail color sym
  echo
  for row in "${CHECK_ROWS[@]}"; do
    IFS='|' read -r st name detail <<<"$row"
    case "$st" in
      OK) color=$C_OK; sym="✓" ;;
      WARN) color=$C_WARN; sym="!" ;;
      *) color=$C_ERR; sym="✗" ;;
    esac
    printf '  %s%s%s %-13s %s\n' "$color" "$sym" "$C_OFF" "$name" "$detail"
  done
  echo "  $N_FAIL failure(s), $N_WARN warning(s)"
  echo
}

gcp_meta() {
  curl -sf -m 2 -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/$1" 2>/dev/null || true
}

# Listeners on a TCP port, minus our own (caddy, docker-proxy)
listeners_on() {
  ss -ltnpH 2>/dev/null | awk -v p="$1" '{ n = split($4, a, ":"); if (a[n] == p) print }' \
    | grep -vE 'caddy|docker-proxy' || true
}

# Any listener at all on a TCP port
port_busy() {
  ss -ltnH 2>/dev/null | awk -v p="$1" '{ n = split($4, a, ":"); if (a[n] == p) found = 1 } END { exit !found }'
}

listener_procs() {
  sed -n 's/.*users:(("\([^"]*\)".*/\1/p' <<<"$1" | sort -u | paste -sd, - || true
}

existing_parent() {
  local d="$1"
  while [[ ! -e "$d" && "$d" != / ]]; do d="$(dirname "$d")"; done
  printf '%s' "$d"
}

free_gb() {
  local d kb
  d="$(existing_parent "$1")"
  kb="$(df -Pk "$d" | awk 'NR == 2 {print $4}')"
  printf '%s' $((kb / 1048576))
}

# ver_ge HAVE NEED — 0 when HAVE >= NEED (dotted versions)
ver_ge() {
  [[ -n "$1" ]] && [[ "$(printf '%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

run_preflight() {
  CHECK_ROWS=(); N_FAIL=0; N_WARN=0; MISSING_TOOLS=(); DOCKER_NEEDS_INSTALL=0
  local kb gib n p listeners code wp cp bd bgb dockerdir dgb srv cver swapinfo

  if [[ $EUID -eq 0 ]]; then
    record OK "root" "running as root"
  else
    record FAIL "root" "not root — run with sudo"
  fi

  # /etc/os-release is a standard system file, sourced in subshells
  # shellcheck disable=SC1091
  OS_ID="$( (. /etc/os-release && echo "${ID:-}") 2>/dev/null || true)"
  # shellcheck disable=SC1091
  OS_CODENAME="$( (. /etc/os-release && echo "${VERSION_CODENAME:-}") 2>/dev/null || true)"
  # shellcheck disable=SC1091
  OS_PRETTY="$( (. /etc/os-release && echo "${PRETTY_NAME:-}") 2>/dev/null || true)"
  case "$OS_ID" in
    debian | ubuntu) record OK "os" "$OS_PRETTY" ;;
    *) record FAIL "os" "${OS_PRETTY:-unknown} — Debian and Ubuntu only" ;;
  esac

  if [[ "$(uname -m)" == x86_64 ]]; then
    record OK "arch" "x86_64"
  else
    record FAIL "arch" "$(uname -m) — published images are linux/amd64 only"
  fi

  for p in openssl curl; do
    if command -v "$p" >/dev/null 2>&1; then
      record OK "$p" "installed"
    else
      MISSING_TOOLS+=("$p")
      record FAIL "$p" "missing — can be installed with apt"
    fi
  done

  n="$(nproc 2>/dev/null || echo 1)"
  if (( n >= 2 )); then record OK "vCPU" "$n"; else record WARN "vCPU" "$n (recommend 2+)"; fi

  # Cloud VMs report slightly under their nominal size, so "4 GB" is checked as 3.5 GiB.
  kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  gib="$(awk -v k="$kb" 'BEGIN { printf "%.1f", k / 1048576 }')"
  if (( kb >= 3670016 )); then record OK "RAM" "${gib} GiB"; else record WARN "RAM" "${gib} GiB (recommend 4 GB+)"; fi

  swapinfo="$(swapon --show --noheadings 2>/dev/null || true)"
  if [[ -n "$swapinfo" ]]; then
    record OK "swap" "active"
  elif (( kb < 3670016 )); then
    record WARN "swap" "none on a low-memory host — install offers a 2 GB /swapfile"
  else
    record OK "swap" "none (not needed at this RAM size)"
  fi

  dockerdir=/var/lib/docker
  [[ -d $dockerdir ]] || dockerdir=/
  dgb="$(free_gb "$dockerdir")"
  if (( dgb >= 20 )); then record OK "disk" "${dgb} GB free on $dockerdir"; else record WARN "disk" "${dgb} GB free on $dockerdir (recommend 20 GB+)"; fi

  bd="$(env_get BACKUP_DIR)"; bd="${bd:-/var/backups/kompast}"
  bgb="$(free_gb "$bd")"
  if (( bgb >= 5 )); then
    record OK "backup disk" "${bgb} GB free at $bd"
  else
    record WARN "backup disk" "${bgb} GB free at $bd (local dumps need room)"
  fi

  if command -v ss >/dev/null 2>&1; then
    for p in 80 443; do
      listeners="$(listeners_on "$p")"
      if [[ -z "$listeners" ]]; then
        record OK "port $p" "free (or ours)"
      else
        record WARN "port $p" "in use by $(listener_procs "$listeners") — Caddy needs it"
      fi
    done
    wp="$(env_get WEB_PORT)"; wp="${wp:-3000}"
    cp="$(env_get COLLAB_PORT)"; cp="${cp:-1234}"
    for p in "$wp" "$cp"; do
      listeners="$(listeners_on "$p")"
      if [[ -z "$listeners" ]]; then
        record OK "port $p" "free on 127.0.0.1"
      else
        record WARN "port $p" "in use by $(listener_procs "$listeners")"
      fi
    done
  else
    record WARN "ports" "ss not found (apt install iproute2); port checks skipped"
  fi

  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    srv="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
    if [[ -z "$srv" ]]; then
      srv="$(docker version --format '{{.Client.Version}}' 2>/dev/null || true)"
    fi
    cver="$(docker compose version --short 2>/dev/null | sed 's/^v//' || true)"
    if ver_ge "$srv" 24.0.0 && ver_ge "$cver" 2.20.0; then
      record OK "docker" "Engine $srv, compose $cver"
    else
      DOCKER_NEEDS_INSTALL=1
      record WARN "docker" "Engine ${srv:-?}, compose ${cver:-?}: need Engine >= 24 and compose >= 2.20 — upgrade offered"
    fi
    if ! docker info >/dev/null 2>&1; then
      record WARN "docker daemon" "not reachable — is dockerd running?"
    fi
  else
    DOCKER_NEEDS_INSTALL=1
    record WARN "docker" "Engine or compose v2 missing — install offers Docker's official packages"
  fi

  GCP_IP="$(gcp_meta instance/network-interfaces/0/access-configs/0/external-ip)"
  if [[ -n "$GCP_IP" ]]; then
    ON_GCP=1
    GCP_PROJECT="$(gcp_meta project/project-id)"
    GCP_ZONE="$(gcp_meta instance/zone | awk -F/ '{print $NF}')"
    record OK "GCP" "external IP $GCP_IP, project ${GCP_PROJECT:-?}, zone ${GCP_ZONE:-?}"
  else
    ON_GCP=0
    record WARN "GCP" "metadata server not reachable — not on GCP? DNS and firewall are yours"
  fi

  if command -v curl >/dev/null 2>&1; then
    code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' https://ghcr.io/v2/ 2>/dev/null || true)"
    if [[ -z "$code" || "$code" == 000 ]]; then
      record FAIL "ghcr.io" "unreachable — image pulls would fail"
    else
      record OK "ghcr.io" "reachable (HTTP $code)"
    fi
  else
    record WARN "ghcr.io" "not checked (curl missing)"
  fi
}

print_gcp_hint() {
  (( ON_GCP )) || return 0
  cat <<EOF
  Firewall for HTTP/HTTPS (printed, not run):
    gcloud compute firewall-rules create kompast-web \\
      --project=${GCP_PROJECT:-<project>} --direction=INGRESS --action=ALLOW \\
      --allow=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags=kompast-web
  The VM must carry the network tag 'kompast-web' (VM details → Edit → Network tags).

EOF
}

# ============================================================================
# Prerequisites: Docker, swap
# ============================================================================

install_docker() {
  info "Installing Docker Engine and compose from Docker's official apt repository"
  apt-get update -qq </dev/null
  apt-get install -y -qq ca-certificates curl </dev/null >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$OS_ID" "$OS_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq </dev/null
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin </dev/null >/dev/null
  systemctl enable --now docker
  docker compose version >/dev/null || die "Docker installed but 'docker compose' does not work."
  ok "Docker Engine and compose installed or upgraded"
}

# create_swapfile: explicit returns (set -e is off inside if-conditions)
create_swapfile() {
  if [[ -e /swapfile ]]; then
    warn "/swapfile already exists; not touching it"
    return 1
  fi
  fallocate -l 2G /swapfile || return 1
  SWAP_CREATED=1
  chmod 600 /swapfile || return 1
  mkswap /swapfile >/dev/null || return 1
  swapon /swapfile || return 1
  if ! grep -qE '^/swapfile[[:space:]]' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab || return 1
  fi
  printf 'vm.swappiness=10\n' > /etc/sysctl.d/30-kompast-swap.conf || return 1
  sysctl -q -p /etc/sysctl.d/30-kompast-swap.conf || true
}

rollback_swap() {
  if (( SWAP_CREATED )); then
    swapoff /swapfile 2>/dev/null || true
    rm -f /swapfile
    sed -i '\#^/swapfile[[:space:]]#d' /etc/fstab || true
    rm -f /etc/sysctl.d/30-kompast-swap.conf
  fi
}

ensure_swap() {
  local kb
  kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  if (( kb >= 3670016 )); then
    ok "RAM is 4 GB or more; swap not required"
    return 0
  fi
  if [[ -n "$(swapon --show --noheadings 2>/dev/null || true)" ]]; then
    ok "Swap already active"
    return 0
  fi
  warn "Under 4 GB RAM and no swap: image pulls, builds and migrations can run out of memory."
  if confirm "Create a 2 GB /swapfile (fstab entry, vm.swappiness=10)?" Y; then
    if create_swapfile; then
      ok "2 GB swapfile active"
    else
      rollback_swap
      warn "Swap creation failed and was rolled back. Continuing without swap."
    fi
  fi
}

# ============================================================================
# Runtime files: copy from a checkout, or download from GitHub
# ============================================================================

resolve_source() {
  local src="${BASH_SOURCE[0]:-}" d
  SRC_DIR=""
  if [[ -n "$src" && -f "$src" ]]; then
    d="$(cd "$(dirname "$src")" && pwd)"
    if [[ -f "$d/docker-compose.yml" && -f "$d/backup.sh" ]]; then
      SRC_DIR="$d"
    fi
  fi
}

repo_slug() { echo "${KOMPAST_REPO:-rosdyana/kompast}"; }

# github_api PATH — JSON from the GitHub REST API (authenticated when GITHUB_TOKEN is set).
github_api() {
  local args=(-sS -H "Accept: application/vnd.github+json")
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then args+=(-H "Authorization: Bearer $GITHUB_TOKEN"); fi
  curl "${args[@]}" "https://api.github.com/repos/$(repo_slug)/$1"
}

# Sets RELEASE_VERSION: KOMPAST_VERSION, else the release this script came
# from (KOMPAST_RELEASE), else the repo's latest published release.
resolve_release() {
  if [[ -n "${RELEASE_VERSION:-}" ]]; then return 0; fi
  local v="${KOMPAST_VERSION:-$KOMPAST_RELEASE}"
  if [[ -z "$v" ]]; then
    v="$(github_api releases/latest | sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
    [[ -n "$v" ]] || die "No published release found in $(repo_slug). Pin one with KOMPAST_VERSION=vX.Y.Z (or, for testing only, KOMPAST_REF=<branch>)."
  fi
  [[ "$v" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || die "Not a release version: '$v' (expected vX.Y.Z)"
  RELEASE_VERSION="$v"
}

# download_release_asset NAME DEST — one asset of RELEASE_VERSION.
download_release_asset() {
  local name="$1" dest="$2" url code
  local args=(-sS -L -o "$dest" -w '%{http_code}')
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    # Private repos: the browser download URL needs a web session, so use the API's asset endpoint.
    url="$(github_api "releases/tags/$RELEASE_VERSION" | awk -v n="$name" '
      /"url": *"https:\/\/api\.github\.com\/repos\/.*\/releases\/assets\/[0-9]+"/ { match($0, /https:[^"]+/); u = substr($0, RSTART, RLENGTH) }
      index($0, "\"name\": \"" n "\"") { print u; exit }')"
    [[ -n "$url" ]] || die "Release $RELEASE_VERSION has no asset named $name"
    args+=(-H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/octet-stream")
  else
    url="https://github.com/$(repo_slug)/releases/download/$RELEASE_VERSION/$name"
  fi
  code="$(curl "${args[@]}" "$url" || true)"
  if [[ "$code" != 200 ]]; then
    rm -f "$dest"
    die "download failed (HTTP ${code:-none}): $name from release $RELEASE_VERSION of $(repo_slug). 404 = no such release/asset; 401/403/404 on a private repo = set GITHUB_TOKEN (and use sudo -E)."
  fi
}

# verify_release_file ASSET PATH — PATH must match ASSET's line in the release's SHA256SUMS.
verify_release_file() {
  local want got
  want="$(awk -v n="$1" '$2 == n || $2 == "*" n { print $1; exit }' "$RELEASE_SUMS")"
  [[ -n "$want" ]] || die "$1 is not listed in SHA256SUMS of release $RELEASE_VERSION"
  got="$(sha256sum "$2" | awk '{print $1}')"
  [[ "$got" == "$want" ]] || die "Checksum mismatch for $1 from release $RELEASE_VERSION (expected $want, got $got). Refusing to continue."
}

# The image tag a release publishes: release.yml tags images with the semver, no leading "v".
release_image_tag() {
  if [[ -n "${RELEASE_VERSION:-}" ]]; then echo "${RELEASE_VERSION#v}"; fi
}

# Fresh-install default: the release being installed; from a checkout, the
# repo's package.json version; "latest" only when neither is known
# (KOMPAST_REF). A pinned tag means an upgrade is a deliberate move, and
# `kompast version` shows what is actually running.
default_image_tag() {
  local t
  t="$(release_image_tag)"
  if [[ -z "$t" && -n "${SRC_DIR:-}" && -f "$SRC_DIR/../package.json" ]]; then
    t="$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$SRC_DIR/../package.json" | head -n1)"
  fi
  echo "${t:-latest}"
}

# get_file NAME DEST — copy from the checkout, or download (verified). Never reached in --check.
get_file() {
  if [[ -n "$SRC_DIR" ]]; then
    cp "$SRC_DIR/$1" "$2"
    return 0
  fi
  if [[ -n "${KOMPAST_REF:-}" ]]; then
    get_file_unverified "$1" "$2"
    return 0
  fi
  resolve_release
  if [[ -z "${RELEASE_SUMS:-}" ]]; then
    RELEASE_SUMS="$(mktemp)"
    download_release_asset SHA256SUMS "$RELEASE_SUMS"
    ok "Release $RELEASE_VERSION: runtime files are checked against its SHA256SUMS"
  fi
  # GitHub renames release assets that start with a dot, so they are published without it.
  local asset="${1#.}" tmp
  tmp="$(mktemp)"
  download_release_asset "$asset" "$tmp"
  verify_release_file "$asset" "$tmp"
  cat "$tmp" > "$2"
  rm -f "$tmp"
}

# KOMPAST_REF: straight from a branch/commit — no release, no checksums. For testing changes before release.
get_file_unverified() {
  if [[ -z "${WARNED_UNVERIFIED:-}" ]]; then
    WARNED_UNVERIFIED=1
    warn "KOMPAST_REF=$KOMPAST_REF: downloading UNVERIFIED files from that branch/commit (testing only, no checksums)"
  fi
  local url code
  url="https://raw.githubusercontent.com/$(repo_slug)/${KOMPAST_REF}/infra/$1"
  local args=(-sS -L -o "$2" -w '%{http_code}')
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    args+=(-H "Authorization: Bearer $GITHUB_TOKEN")
  fi
  code="$(curl "${args[@]}" "$url" || true)"
  if [[ "$code" != 200 ]]; then
    rm -f "$2"
    die "download failed (HTTP ${code:-none}): $url. 404 = wrong KOMPAST_REPO/KOMPAST_REF; 401/403/404 on a private repo = set GITHUB_TOKEN (and use sudo -E)."
  fi
}

sync_runtime_files() {
  mkdir -p "$KOMPAST_DIR" "$KOMPAST_DIR/secrets"
  local f tmp
  for f in docker-compose.yml .env.example Caddyfile.example backup.sh; do
    get_file "$f" "$KOMPAST_DIR/$f"
  done
  chmod 755 "$KOMPAST_DIR/backup.sh"

  tmp="$(mktemp)"
  get_file gcs-cors.json "$tmp"
  if [[ ! -f "$KOMPAST_DIR/gcs-cors.json" ]]; then
    cat "$tmp" > "$KOMPAST_DIR/gcs-cors.json"
  elif ! cmp -s "$tmp" "$KOMPAST_DIR/gcs-cors.json"; then
    if confirm "$KOMPAST_DIR/gcs-cors.json differs from upstream. Overwrite it (your edits are lost)?" N; then
      cat "$tmp" > "$KOMPAST_DIR/gcs-cors.json"
    else
      warn "Kept your existing gcs-cors.json"
    fi
  fi
  rm -f "$tmp"
  chmod 644 "$KOMPAST_DIR/gcs-cors.json"
  ok "Runtime files in $KOMPAST_DIR are current"
}

rewrite_cors_origin() {
  local f="$KOMPAST_DIR/gcs-cors.json" tmp
  tmp="$(mktemp)"
  sed -E "s#\"origin\": *\[[^]]*\]#\"origin\": [\"https://$DOMAIN\"]#" "$f" > "$tmp"
  cat "$tmp" > "$f"
  rm -f "$tmp"
  ok "gcs-cors.json origin set to https://$DOMAIN"
}

# ============================================================================
# Answers: collected in ANS_* (defaults = previous answers), reviewed, then applied
# ============================================================================

init_answers() {
  if [[ "$MODE" == reconfigure ]]; then
    local apex
    apex="$(env_get APP_URL)"; apex="${apex#*://}"; apex="${apex%%/*}"
    ANS_DOMAIN="$apex"
    ANS_GHCR_OWNER="$(env_get GHCR_OWNER)"
    ANS_IMAGE_TAG="$(env_get IMAGE_TAG)"
    ANS_STORAGE="$(env_get STORAGE_DRIVER)"
    ANS_GCS_BUCKET="$(env_get GCS_BUCKET)"
    ANS_GCS_PROJECT="$(env_get GCS_PROJECT_ID)"
    ANS_SA_PATH="$(env_get GCS_CREDENTIALS_HOST_PATH)"
    if [[ "$ANS_SA_PATH" == /dev/null ]]; then ANS_SA_PATH="$KOMPAST_DIR/secrets/gcs-service-account.json"; fi
    if caddy_configured_for "$ANS_DOMAIN"; then ANS_PROXY=caddy; else ANS_PROXY=none; fi
    if [[ -f "$BACKUP_CRON" ]]; then
      if [[ -n "$(env_get BACKUP_GCS_URI)" ]]; then ANS_BACKUP=local+gcs; else ANS_BACKUP=local; fi
    else
      ANS_BACKUP=none
    fi
    ANS_BK_DIR="$(env_get BACKUP_DIR)"; ANS_BK_DIR="${ANS_BK_DIR:-/var/backups/kompast}"
    ANS_BK_RETENTION="$(env_get BACKUP_RETENTION_DAYS)"; ANS_BK_RETENTION="${ANS_BK_RETENTION:-14}"
    ANS_BK_URI="$(env_get BACKUP_GCS_URI)"
  else
    ANS_DOMAIN=""
    ANS_GHCR_OWNER="rosdyana"
    ANS_IMAGE_TAG="$(default_image_tag)"
    ANS_STORAGE="gcs"
    ANS_GCS_BUCKET=""
    ANS_GCS_PROJECT="$GCP_PROJECT"
    ANS_SA_PATH="$KOMPAST_DIR/secrets/gcs-service-account.json"
    ANS_PROXY="caddy"
    ANS_BACKUP="local"
    ANS_BK_DIR="/var/backups/kompast"
    ANS_BK_RETENTION="14"
    ANS_BK_URI=""
  fi
}

collect_answers() {
  answer ANS_DOMAIN "Domain for Kompast (bare host, e.g. kompast.example.com)" "$ANS_DOMAIN" \
    '^[a-z0-9.-]+\.[a-z]{2,}$' "Use a bare lowercase host such as kompast.example.com (no https://, no path)." KOMPAST_DOMAIN
  DOMAIN="$ANS_DOMAIN"
  check_dns

  answer ANS_GHCR_OWNER "GitHub owner that publishes the images (ghcr.io/<owner>/kompast-*)" "$ANS_GHCR_OWNER" \
    '^[a-z0-9][a-z0-9-]*$' "Lowercase letters, digits and hyphens only." KOMPAST_GHCR_OWNER
  answer ANS_IMAGE_TAG "Image tag" "$ANS_IMAGE_TAG" \
    '^[A-Za-z0-9_][A-Za-z0-9_.-]*$' "Letters, digits, dot, dash, underscore." KOMPAST_IMAGE_TAG
  choose_private

  answer ANS_STORAGE "Attachment storage: gcs (recommended on GCP) or local" "$ANS_STORAGE" \
    '^(gcs|local)$' "Enter gcs or local." KOMPAST_STORAGE
  if [[ "$ANS_STORAGE" == gcs ]]; then
    answer ANS_GCS_BUCKET "GCS bucket name (no gs://)" "$ANS_GCS_BUCKET" \
      '^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$' "3-63 characters: lowercase letters, digits, dots, hyphens." KOMPAST_GCS_BUCKET
    answer ANS_GCS_PROJECT "GCP project id" "$ANS_GCS_PROJECT" \
      '^[a-z][a-z0-9-]{4,28}[a-z0-9]$' "Enter a GCP project id." KOMPAST_GCS_PROJECT
    answer_sa_key
  fi

  answer ANS_PROXY "Reverse proxy: caddy (installed here, automatic HTTPS) or none (bring your own)" "$ANS_PROXY" \
    '^(caddy|none)$' "Enter caddy or none." KOMPAST_PROXY

  answer ANS_BACKUP "Backups: local (VM disk, daily 02:30), local+gcs (also copy to GCS), or none" "$ANS_BACKUP" \
    '^(local|local\+gcs|none)$' "Enter local, local+gcs or none." KOMPAST_BACKUP
  if [[ "$ANS_BACKUP" != none ]]; then
    answer ANS_BK_DIR "Local backup directory on this VM" "$ANS_BK_DIR" \
      '^/[^[:space:]]+$' "Use an absolute path without spaces." KOMPAST_BACKUP_DIR
    answer ANS_BK_RETENTION "Keep local dumps for how many days" "$ANS_BK_RETENTION" \
      '^[1-9][0-9]*$' "Enter a whole number of days (1 or more)." KOMPAST_BACKUP_RETENTION_DAYS
  fi
  if [[ "$ANS_BACKUP" == local+gcs ]]; then
    answer ANS_BK_URI "GCS destination (gs://bucket or gs://bucket/prefix)" "$ANS_BK_URI" \
      '^gs://[a-z0-9][a-z0-9._-]*(/[^[:space:]]*)?$' "Must look like gs://bucket or gs://bucket/prefix." KOMPAST_BACKUP_GCS_URI
  else
    ANS_BK_URI=""
  fi
}

check_dns() {
  local resolved
  resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR == 1 {print $1}' || true)"
  if [[ -z "$resolved" ]]; then
    warn "$DOMAIN does not resolve yet. Caddy cannot get an HTTPS certificate until its A record points at this VM${GCP_IP:+ ($GCP_IP)}."
  elif [[ -n "$GCP_IP" && "$resolved" != "$GCP_IP" ]]; then
    warn "$DOMAIN resolves to $resolved, but this VM's external IP is $GCP_IP. The certificate will fail until DNS points here."
  else
    ok "$DOMAIN resolves to $resolved"
    return 0
  fi
  confirm "Continue anyway?" Y || die "Stopped at the DNS check; nothing was changed."
}

choose_private() {
  local def=N
  if [[ -n "${GHCR_TOKEN:-}" ]]; then
    ANS_PRIVATE=1
  elif (( YES )); then
    ANS_PRIVATE=0
  else
    if (( ANS_PRIVATE )); then def=Y; fi
    if confirm "Are the GHCR images private (need a GitHub token to pull)?" "$def"; then
      ANS_PRIVATE=1
    else
      ANS_PRIVATE=0
    fi
  fi
  if (( ANS_PRIVATE )) && [[ -z "${GHCR_TOKEN:-}" ]]; then
    if (( YES )); then
      die "GHCR_TOKEN is required for private images with --yes."
    fi
    if [[ -z "${GHCR_USER:-}" ]]; then
      ask GHCR_USER "GitHub username that owns the token"
    fi
    [[ -n "$GHCR_USER" ]] || die "GitHub username is required."
    ask_secret GHCR_TOKEN "GitHub PAT with read:packages (hidden)"
    [[ -n "$GHCR_TOKEN" ]] || die "The token is required for private images."
  fi
}

sa_json_ok() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -I -c 'import json, sys
d = json.load(open(sys.argv[1]))
sys.exit(0 if isinstance(d, dict) and d.get("type") == "service_account" else 1)' "$1" 2>/dev/null
  else
    grep -Eq '"type"[[:space:]]*:[[:space:]]*"service_account"' "$1"
  fi
}

answer_sa_key() {
  local in="" abs="" msg="" d="$ANS_SA_PATH"
  if [[ -n "${KOMPAST_GCS_KEY_FILE:-}" ]]; then d="$KOMPAST_GCS_KEY_FILE"; fi
  while true; do
    if (( YES )); then
      in="$d"
    else
      ask in "Service-account JSON key (path under $KOMPAST_DIR, or absolute)" "$d"
    fi
    if [[ "$in" == /* ]]; then abs="$in"; else abs="$KOMPAST_DIR/$in"; fi
    if [[ ! -f "$abs" ]]; then
      msg="No file at $abs. Copy the key there first (e.g. scp it into $KOMPAST_DIR/secrets/)."
    elif ! sa_json_ok "$abs"; then
      msg="$abs is not a service-account key (expected \"type\": \"service_account\")."
    else
      break
    fi
    if (( YES )); then die "$msg"; fi
    warn "$msg"
    d="$in"
  done
  ANS_SA_PATH="$abs"
}

print_answers() {
  echo
  echo "Review"
  printf '  %-20s %s\n' "Domain" "$ANS_DOMAIN"
  printf '  %-20s %s\n' "Images" "ghcr.io/$ANS_GHCR_OWNER/kompast-*:$ANS_IMAGE_TAG"
  printf '  %-20s %s\n' "Private images" "$( ((ANS_PRIVATE)) && echo "yes (token: •••••• entered, not stored)" || echo no)"
  printf '  %-20s %s\n' "Storage" "$ANS_STORAGE"
  if [[ "$ANS_STORAGE" == gcs ]]; then
    printf '  %-20s %s\n' "  bucket / project" "$ANS_GCS_BUCKET / $ANS_GCS_PROJECT"
    printf '  %-20s %s\n' "  key file" "$ANS_SA_PATH"
  fi
  printf '  %-20s %s\n' "Reverse proxy" "$ANS_PROXY"
  printf '  %-20s %s\n' "Backups" "$ANS_BACKUP"
  if [[ "$ANS_BACKUP" != none ]]; then
    printf '  %-20s %s\n' "  local directory" "$ANS_BK_DIR"
    printf '  %-20s %s\n' "  retention (days)" "$ANS_BK_RETENTION"
  fi
  if [[ -n "$ANS_BK_URI" ]]; then
    printf '  %-20s %s\n' "  off-host copy" "$ANS_BK_URI"
  fi
  echo "  Secrets (DB passwords, BETTER_AUTH_SECRET) are generated, never displayed."
  echo
}

collect_answers_loop() {
  while true; do
    collect_answers
    print_answers
    if confirm "Does this look right?" Y; then
      break
    fi
    info "Asking again; your previous answers are the defaults."
  done
}

# ============================================================================
# Apply: write .env and the proxy/storage/backup config
# ============================================================================

write_override_file() {
  cat > "$KOMPAST_DIR/docker-compose.override.yml" <<'EOF'
# Written by install.sh for STORAGE_DRIVER=local: attachments live in a named volume.
services:
  web:
    volumes:
      - attachments:/data/attachments
  worker:
    volumes:
      - attachments:/data/attachments
volumes:
  attachments:
EOF
}

apply_settings() {
  env_set APP_URL "https://$ANS_DOMAIN"
  env_set BETTER_AUTH_URL "https://$ANS_DOMAIN"
  env_set COLLAB_WS_URL "wss://$ANS_DOMAIN/api/collab"
  env_set GHCR_OWNER "$ANS_GHCR_OWNER"
  env_set IMAGE_TAG "$ANS_IMAGE_TAG"
  if [[ "$ANS_STORAGE" == gcs ]]; then
    chmod 600 "$ANS_SA_PATH"
    env_set STORAGE_DRIVER gcs
    env_set GCS_BUCKET "$ANS_GCS_BUCKET"
    env_set GCS_PROJECT_ID "$ANS_GCS_PROJECT"
    env_set GCS_CREDENTIALS_HOST_PATH "$ANS_SA_PATH"
    rm -f "$KOMPAST_DIR/docker-compose.override.yml"
    if confirm "Set the origin in $KOMPAST_DIR/gcs-cors.json to https://$ANS_DOMAIN now?" Y; then
      rewrite_cors_origin
    fi
    cat <<EOF
  Apply the bucket CORS config once, from a machine where gcloud is logged in (not run here):
    gcloud storage buckets update gs://$ANS_GCS_BUCKET --cors-file=$KOMPAST_DIR/gcs-cors.json
EOF
  else
    env_set STORAGE_DRIVER local
    env_set STORAGE_LOCAL_DIR /data/attachments
    env_set GCS_BUCKET ""
    env_set GCS_PROJECT_ID ""
    env_set GCS_CREDENTIALS_HOST_PATH /dev/null
    write_override_file
    warn "Local storage: attachments live in a Docker volume on this VM only (not for multiple instances)."
  fi
  env_set BACKUP_DIR "$ANS_BK_DIR"
  env_set BACKUP_RETENTION_DAYS "${ANS_BK_RETENTION:-14}"
  env_set BACKUP_GCS_URI "$ANS_BK_URI"
  if [[ "$ANS_BACKUP" == none ]]; then BACKUP_ON=0; else BACKUP_ON=1; fi
  chmod 600 "$ENV_FILE"
}

caddy_block() { # caddy_block WEB_PORT COLLAB_PORT
  cat <<EOF
# Kompast — managed by kompast install.sh
${DOMAIN} {
  # Yjs/Hocuspocus needs the WebSocket upgrade preserved; this must stay before the catch-all.
  @collab {
    path /api/collab*
  }
  reverse_proxy @collab 127.0.0.1:$2

  reverse_proxy 127.0.0.1:$1

  # Upper bound on request bodies, above the largest app-side upload (200 MB, Notion import).
  request_body {
    max_size 250MB
  }

  encode zstd gzip

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "SAMEORIGIN"
    Referrer-Policy "strict-origin-when-cross-origin"
    Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    -Server
  }
}
EOF
}

caddy_configured_for() {
  local re="${1//./\\.}"
  [[ -f "$CADDYFILE" ]] && grep -Eq "^[[:space:]]*${re}[[:space:]]*\{" "$CADDYFILE"
}

caddy_configured() { caddy_configured_for "$DOMAIN"; }

# True when the Caddyfile only holds Debian's stock ":80" demo site
is_stock_caddyfile() {
  local bad
  bad="$(grep -E '^[^[:space:]#]' "$1" | grep -vE '^(:80 \{|\})$' || true)"
  [[ -z "$bad" ]] && grep -qE '^:80 \{' "$1"
}

install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    ok "Caddy already installed"
    return 0
  fi
  info "Installing Caddy from the official Cloudsmith apt repository"
  apt-get update -qq </dev/null
  apt-get install -y -qq curl gnupg ca-certificates </dev/null >/dev/null
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq </dev/null
  apt-get install -y -qq caddy </dev/null >/dev/null
  ok "Caddy installed"
}

configure_caddy() {
  local wp cp block new stamp
  wp="$(env_get WEB_PORT)"; wp="${wp:-3000}"
  cp="$(env_get COLLAB_PORT)"; cp="${cp:-1234}"
  if caddy_configured; then
    warn "$CADDYFILE already has a site block for $DOMAIN, left unchanged. Compare it with $KOMPAST_DIR/Caddyfile.example (the /api/collab* route must come first)."
    return 0
  fi
  block="$(caddy_block "$wp" "$cp")"
  new="$(mktemp)"
  if [[ ! -s "$CADDYFILE" ]] || is_stock_caddyfile "$CADDYFILE"; then
    printf '%s\n' "$block" > "$new"
  else
    cat "$CADDYFILE" > "$new"
    printf '\n%s\n' "$block" >> "$new"
  fi
  if ! caddy validate --config "$new" --adapter caddyfile; then
    rm -f "$new"
    die "The generated Caddyfile failed validation; $CADDYFILE was not changed."
  fi
  stamp="$(date +%Y%m%d%H%M%S)"
  if [[ -s "$CADDYFILE" ]]; then
    cp -a "$CADDYFILE" "$CADDYFILE.kompast-bak-$stamp"
    info "Previous Caddyfile saved as $CADDYFILE.kompast-bak-$stamp"
  fi
  cat "$new" > "$CADDYFILE"
  rm -f "$new"
  caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null || die "Caddy rejected $CADDYFILE (see output above)."
  systemctl enable --now caddy >/dev/null
  systemctl reload caddy || die "Caddy reload failed. See: journalctl -u caddy -n 50"
  ok "Caddy configured for $DOMAIN"
}

# Port-80 reachability test: a temporary listener, fetched from the public domain
# Returns 0 reachable, 1 not reachable, 2 could not test
connection_test() {
  if port_busy 80; then
    return 2
  fi
  local dir token pid="" body="" method=""
  dir="$(mktemp -d)"
  token="$(rand_hex 8)"
  printf '%s\n' "$token" > "$dir/$token"
  if command -v python3 >/dev/null 2>&1; then
    python3 -m http.server 80 --bind 0.0.0.0 --directory "$dir" >/dev/null 2>&1 &
    pid=$!
    method=python
  elif docker info >/dev/null 2>&1 \
    && docker run -d --rm -p 80:80 -v "$dir:/usr/share/nginx/html:ro" --name kompast-portcheck nginx:alpine >/dev/null 2>&1; then
    method=docker
  else
    rm -rf "$dir"
    return 2
  fi
  sleep 2
  body="$(curl -s --max-time 5 "http://$DOMAIN/$token" || true)"
  if [[ "$method" == python ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  else
    docker rm -f kompast-portcheck >/dev/null 2>&1 || true
  fi
  rm -rf "$dir"
  [[ "$body" == "$token" ]]
}

connection_gate() {
  if caddy_configured; then
    return 0
  fi
  if (( SKIP_CONN_TEST )); then
    warn "Skipping the connection test (--skip-connection-test)"
    return 0
  fi
  step "Connection test (is http://$DOMAIN/ reaching this VM on port 80?)"
  local rc=0
  connection_test || rc=$?
  case "$rc" in
    0)
      ok "http://$DOMAIN/ reaches this VM"
      return 0
      ;;
    2)
      warn "Could not run the test (port 80 busy, or no python3 or docker). Continuing."
      return 0
      ;;
  esac
  warn "http://$DOMAIN/ did not reach this VM."
  cat <<EOF
  Likely causes:
   - DNS: $DOMAIN does not point at this VM${GCP_IP:+ (external IP $GCP_IP)}, or it has not propagated yet
   - GCP firewall: no rule allows tcp:80,tcp:443 to this VM, or the VM lacks the 'kompast-web' tag
   - Another firewall or proxy upstream is blocking port 80
  Let's Encrypt validates over port 80. Without it the certificate fails, and repeated failures
  hit Let's Encrypt's rate limits for this domain.
EOF
  confirm "Continue anyway?" N \
    || die "Stopped before any configuration was written. Fix reachability and re-run (or pass --skip-connection-test)."
}

install_apply() {
  if [[ "$ANS_PROXY" == caddy ]]; then
    connection_gate
  fi
  step "Write configuration"
  local pg_admin pg_app
  pg_admin="$(rand_hex 24)"
  pg_app="$(rand_hex 24)"
  # umask in a subshell so the file is never readable by others, even briefly.
  (umask 077; cp "$KOMPAST_DIR/.env.example" "$ENV_FILE")
  chmod 600 "$ENV_FILE"
  env_set NODE_ENV production
  env_set POSTGRES_PASSWORD "$pg_admin"
  env_set DATABASE_ADMIN_URL "postgres://kompast_admin:${pg_admin}@postgres:5432/kompast"
  env_set DATABASE_URL "postgres://kompast_app:${pg_app}@postgres:5432/kompast"
  env_set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
  set_redis_secret
  set_service_db_secret
  # One-time secret the /setup form asks for, so nobody who finds the URL
  # first can pick the Entra tenant. Shown once in "Next steps" below.
  env_set SETUP_TOKEN "$(rand_hex 16)"
  apply_settings
  ok "Wrote $ENV_FILE (chmod 600) with generated secrets"
  finish_proxy
}

reconfigure_apply() {
  step "Write configuration"
  backup_env_file
  add_missing_runtime_secrets
  apply_settings
  if [[ "$ANS_BACKUP" == none && -f "$BACKUP_CRON" ]]; then
    rm -f "$BACKUP_CRON"
    ok "Removed the backup cron (backups set to none)"
  fi
  ok "Updated $ENV_FILE (secrets unchanged)"
  if [[ "$ANS_PROXY" == caddy ]]; then
    connection_gate
  fi
  finish_proxy
}

finish_proxy() {
  WANT_CADDY=0
  if [[ "$ANS_PROXY" == caddy ]]; then
    step "Reverse proxy"
    install_caddy
    configure_caddy
    WANT_CADDY=1
  else
    warn "No reverse proxy configured. Put HTTPS in front of 127.0.0.1:$(env_get WEB_PORT) (web) and 127.0.0.1:$(env_get COLLAB_PORT) (/api/collab*, before the catch-all). Template: $KOMPAST_DIR/Caddyfile.example"
  fi
}

# ============================================================================
# Upgrade options
# ============================================================================

upgrade_options() {
  local new_tag
  DOMAIN="$(env_get APP_URL)"; DOMAIN="${DOMAIN#*://}"; DOMAIN="${DOMAIN%%/*}"
  PREV_TAG="$(env_get IMAGE_TAG)"
  ok "Existing $ENV_FILE found. Secrets, storage and backup settings are not touched."
  echo "  APP_URL    $(env_get APP_URL)"
  echo "  IMAGE_TAG  $PREV_TAG   (the previous tag; roll back by setting it again and running kompast upgrade)"

  # Installs made before Redis auth / the DB role split lack REDIS_PASSWORD
  # and DATABASE_SERVICE_URL; the new compose file refuses to start without
  # them, so add only those (this runs before any docker compose command).
  add_missing_runtime_secrets

  # Upgrading from a release moves IMAGE_TAG to that release, so the runtime
  # files just installed and the images always match (and an install on the
  # old floating "latest" gets pinned). From a branch (KOMPAST_REF) or a
  # checkout the tag is left alone. KOMPAST_IMAGE_TAG always wins.
  new_tag="$PREV_TAG"
  if [[ -n "$(release_image_tag)" ]]; then
    new_tag="$(release_image_tag)"
  fi
  if [[ -n "${KOMPAST_IMAGE_TAG:-}" ]]; then
    new_tag="$KOMPAST_IMAGE_TAG"
  elif (( YES == 0 )) && confirm "Use IMAGE_TAG $new_tag?" Y; then
    :
  elif (( YES == 0 )); then
    ask_valid_tag new_tag
  fi
  if [[ "$new_tag" != "$PREV_TAG" ]]; then
    backup_env_file
    env_set IMAGE_TAG "$new_tag"
    ok "IMAGE_TAG: $PREV_TAG → $new_tag"
  fi

  if [[ -f "$BACKUP_CRON" ]]; then
    BACKUP_ON=1
  else
    BACKUP_ON=0
  fi

  if caddy_configured; then
    WANT_CADDY=1
  elif (( YES == 0 )) && confirm "No Caddy site for $DOMAIN on this host. Set up Caddy now?" Y; then
    ANS_PROXY=caddy
    ANS_DOMAIN="$DOMAIN"
    finish_proxy
  else
    WANT_CADDY=0
  fi
}

ask_valid_tag() {
  local __out="$1" __t=""
  ask __t "New IMAGE_TAG" "$PREV_TAG"
  until [[ "$__t" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]; do
    warn "Letters, digits, dot, dash, underscore."
    ask __t "New IMAGE_TAG" "$PREV_TAG"
  done
  printf -v "$__out" '%s' "$__t"
}

# ============================================================================
# Deploy and verify
# ============================================================================

fix_gcs_key_ownership() {
  local path uid gid
  path="$(env_get GCS_CREDENTIALS_HOST_PATH)"
  [[ -f "$path" ]] || die "GCS key not found at $path"
  uid="$(docker compose run --rm --no-deps --entrypoint sh web -c 'id -u kompast' </dev/null 2>/dev/null | tail -n1 | tr -d '[:space:]')"
  gid="$(docker compose run --rm --no-deps --entrypoint sh web -c 'id -g kompast' </dev/null 2>/dev/null | tail -n1 | tr -d '[:space:]')"
  [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || die "Could not read the kompast uid/gid from the web image."
  # The containers run as the non-root kompast user, so the mode-600 key must belong to that uid.
  chown "$uid:$gid" "$path"
  chmod 600 "$path"
  ok "GCS key owned by container user kompast ($uid:$gid), mode 600"
}

refuse_unsafe_flags() {
  if grep -Eq '^(ENABLE_DEV_LOGIN|DEMO_MODE)=true' "$ENV_FILE"; then
    die "ENABLE_DEV_LOGIN or DEMO_MODE is true in $ENV_FILE. Refusing to deploy a production install with them on."
  fi
}

pre_upgrade_backup() {
  [[ -f "$BACKUP_CRON" ]] || return 0
  if (( SKIP_BACKUP )); then
    warn "Skipping the pre-upgrade backup (--skip-backup)"
    return 0
  fi
  step "Pre-upgrade database backup"
  if "$KOMPAST_DIR/backup.sh" backup; then
    ok "Backup taken before pulling new images (previous IMAGE_TAG: $PREV_TAG)"
  else
    warn "The backup failed."
    confirm "Continue the upgrade without a backup?" N \
      || die "Upgrade stopped before pulling images; nothing was changed."
  fi
}

wait_migrate() {
  local cid status code i
  info "Waiting for the migrate service (up to 180s)"
  for ((i = 0; i < 90; i++)); do
    cid="$(docker compose ps -a -q migrate 2>/dev/null | head -n1 || true)"
    if [[ -n "$cid" ]]; then
      status="$(docker inspect -f '{{.State.Status}}' "$cid")"
      if [[ "$status" == exited ]]; then
        code="$(docker inspect -f '{{.State.ExitCode}}' "$cid")"
        if [[ "$code" == 0 ]]; then
          ok "Migrations applied"
          return 0
        fi
        docker compose logs migrate --tail=80 || true
        die "migrate exited with code $code (logs above)."
      fi
    fi
    sleep 2
  done
  docker compose logs migrate --tail=80 || true
  die "migrate did not finish within 180s."
}

wait_web() {
  local port code i
  port="$(env_get WEB_PORT)"; port="${port:-3000}"
  info "Waiting for web on 127.0.0.1:$port (up to 120s)"
  for ((i = 0; i < 60; i++)); do
    code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$port/login" 2>/dev/null || true)"
    case "$code" in
      200 | 30[0-9])
        ok "web answering (HTTP $code)"
        return 0
        ;;
    esac
    sleep 2
  done
  docker compose logs web --tail=80 || true
  die "web did not answer on 127.0.0.1:$port within 120s."
}

check_collab() {
  local port i
  port="$(env_get COLLAB_PORT)"; port="${port:-1234}"
  info "Waiting for collab on 127.0.0.1:$port"
  for ((i = 0; i < 30; i++)); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      ok "collab listening on 127.0.0.1:$port"
      return 0
    fi
    sleep 2
  done
  docker compose logs collab --tail=80 || true
  die "collab is not listening on 127.0.0.1:$port."
}

check_public() {
  if curl -sI -m 10 "https://$DOMAIN/" >/dev/null 2>&1; then
    ok "https://$DOMAIN/ answers over HTTPS"
  else
    warn "https://$DOMAIN/ is not answering yet. Caddy may still be fetching the certificate (needs DNS to this VM and ports 80/443). Check: sudo journalctl -u caddy -n 50"
  fi
}

deploy_and_verify() {
  refuse_unsafe_flags
  if [[ "$MODE" == upgrade ]]; then
    pre_upgrade_backup
  fi

  step "Pull images"
  if [[ -n "${GHCR_TOKEN:-}" ]]; then
    [[ -n "${GHCR_USER:-}" ]] || die "GHCR_USER is required with GHCR_TOKEN (the GitHub username that owns the token)."
    printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null \
      || die "docker login ghcr.io failed. Check GHCR_USER and that the token has read:packages."
    ok "Logged in to ghcr.io as $GHCR_USER (the token stays in root's Docker config, not in .env)"
  fi
  docker compose pull

  step "Storage permissions"
  if [[ "$(env_get STORAGE_DRIVER)" == local ]]; then
    docker compose run --rm --no-deps --user root --entrypoint sh web -c 'chown -R kompast:kompast /data/attachments'
    ok "Attachments volume owned by kompast"
  else
    fix_gcs_key_ownership
  fi

  step "Start the stack"
  docker compose rm -sf migrate >/dev/null 2>&1 || true
  docker compose up -d
  wait_migrate

  step "Verify"
  wait_web
  check_collab
  if (( WANT_CADDY )); then
    check_public
  fi

  step "Backups"
  if (( BACKUP_ON )); then
    "$KOMPAST_DIR/backup.sh" install-cron
    if [[ "$MODE" == install ]]; then
      "$KOMPAST_DIR/backup.sh" backup
    fi
  elif [[ -f "$BACKUP_CRON" ]]; then
    rm -f "$BACKUP_CRON"
  else
    ok "Backups set to none"
  fi
}

# ============================================================================
# Wrapper command and summary
# ============================================================================

install_wrapper() {
  local tmp=/usr/local/bin/.kompast.new
  {
    printf '#!/usr/bin/env bash\nKOMPAST_DIR=%q\n' "$KOMPAST_DIR"
    # The installer's own release/checksum helpers, copied verbatim so the
    # wrapper verifies exactly the way install.sh does.
    echo 'KOMPAST_RELEASE=""; RELEASE_VERSION=""; RELEASE_SUMS=""'
    echo 'die() { echo "✗ $*" >&2; exit 1; }'
    echo 'ok() { echo "✓ $*" >&2; }'
    echo 'warn() { echo "! $*" >&2; }'
    declare -f repo_slug github_api resolve_release download_release_asset verify_release_file
    cat <<'WRAP'
# kompast — day-to-day commands for the Kompast install (generated by install.sh).
set -euo pipefail
if [[ $EUID -ne 0 ]]; then exec sudo -E "$0" "$@"; fi
cd "$KOMPAST_DIR"

# Upgrades run the install.sh attached to a GitHub Release (KOMPAST_VERSION,
# else the latest), checked against that release's SHA256SUMS before it runs
# as root — never a script piped from a branch. KOMPAST_REF=<branch> is the
# explicit, unverified escape hatch for testing.
fetch_installer() {
  local dir
  dir="$(mktemp -d)"
  if [[ -n "${KOMPAST_REF:-}" ]]; then
    warn "KOMPAST_REF=$KOMPAST_REF: running an UNVERIFIED installer from that branch/commit (testing only)"
    local args=(-fsSL -o "$dir/install.sh")
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then args+=(-H "Authorization: Bearer $GITHUB_TOKEN"); fi
    curl "${args[@]}" "https://raw.githubusercontent.com/$(repo_slug)/$KOMPAST_REF/infra/install.sh"
  else
    resolve_release
    RELEASE_SUMS="$dir/SHA256SUMS"
    download_release_asset SHA256SUMS "$RELEASE_SUMS"
    download_release_asset install.sh "$dir/install.sh"
    verify_release_file install.sh "$dir/install.sh"
    ok "Kompast $RELEASE_VERSION: install.sh matches the release's SHA256SUMS"
  fi
  INSTALLER="$dir/install.sh"
}
installer() {
  fetch_installer
  KOMPAST_DIR="$KOMPAST_DIR" KOMPAST_VERSION="${KOMPAST_VERSION:-$RELEASE_VERSION}" bash "$INSTALLER" "$@"
}
cmd="${1:-}"
if [[ $# -gt 0 ]]; then shift; fi
case "$cmd" in
  status) docker compose ps ;;
  logs) docker compose logs -f --tail=200 "$@" ;;
  restart) docker compose restart "$@" ;;
  upgrade) installer "$@" ;;
  check) installer --check ;;
  reconfigure) installer --reconfigure "$@" ;;
  backup) ./backup.sh backup ;;
  backups) ./backup.sh list ;;
  restore) ./backup.sh restore "$@" ;;
  version)
    echo "IMAGE_TAG=$(grep -E '^IMAGE_TAG=' .env | cut -d= -f2-)"
    for svc in migrate web collab worker; do
      cid="$(docker compose ps -a -q "$svc" 2>/dev/null | head -n1 || true)"
      if [[ -n "$cid" ]]; then
        img="$(docker inspect -f '{{.Image}}' "$cid")"
        digest="$(docker inspect -f '{{index .RepoDigests 0}}' "$img" 2>/dev/null || true)"
        echo "$svc  ${digest:-$img}"
      else
        echo "$svc  (not created)"
      fi
    done
    ;;
  cleanup)
    docker image prune -f
    docker system df
    ;;
  *)
    echo "usage: kompast status | logs [svc] | restart [svc] | upgrade | check | reconfigure | backup | backups | restore <file> | version | cleanup" >&2
    exit 1
    ;;
esac
WRAP
  } > "$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" /usr/local/bin/kompast
  ok "Installed the 'kompast' command"
}

print_summary() {
  local url wp cp region bdir uri retention
  url="$(env_get APP_URL)"
  wp="$(env_get WEB_PORT)"; wp="${wp:-3000}"
  cp="$(env_get COLLAB_PORT)"; cp="${cp:-1234}"
  echo
  ok "Kompast is running at $url (IMAGE_TAG $(env_get IMAGE_TAG))"
  if [[ "$MODE" == upgrade && -n "$PREV_TAG" ]]; then
    echo "  Previous IMAGE_TAG: $PREV_TAG. To roll back: set IMAGE_TAG=$PREV_TAG in $ENV_FILE, then run: kompast upgrade"
  fi
  if [[ "$MODE" == install ]]; then
    cat <<EOF

Next steps
  1. Microsoft Entra ID: register an app with the redirect URI
       $url/api/auth/callback/microsoft-entra-id
  2. Open $url/setup and enter the Tenant ID, Client ID and Client Secret,
     plus this setup token: $(env_get SETUP_TOKEN)
     (also in $ENV_FILE as SETUP_TOKEN; it is only needed once).
     Double-check the Tenant ID: a wrong one can stop the app from booting.
  3. The first person to sign in becomes the workspace owner and super admin.
EOF
  fi
  if (( WANT_CADDY == 0 )); then
    warn "No reverse proxy here. Put HTTPS in front of 127.0.0.1:$wp (web) and 127.0.0.1:$cp (/api/collab*, before the catch-all)."
  fi
  cat <<EOF

!! Copy $ENV_FILE OFF this VM now (password manager or another machine).
   BETTER_AUTH_SECRET encrypts the secrets saved in /setup and /settings. Lose it and those
   secrets are gone, even though the rest of the data restores fine.
EOF
  if [[ -f "$BACKUP_CRON" ]]; then
    bdir="$(env_get BACKUP_DIR)"; bdir="${bdir:-/var/backups/kompast}"
    retention="$(env_get BACKUP_RETENTION_DAYS)"; retention="${retention:-14}"
    uri="$(env_get BACKUP_GCS_URI)"
    echo
    echo "Backups: daily 02:30 (cron $BACKUP_CRON) → $bdir, keep $retention days (log /var/log/kompast-backup.log)"
    echo "         free now: $(free_gb "$bdir") GB at that filesystem"
    if [[ -n "$uri" ]]; then
      echo "         off-host copy → $uri"
    else
      warn "Local-only: backups are lost if this VM or its disk is deleted. Optional snapshot schedule (printed, not run):"
      region="${GCP_ZONE%-*}"
      cat <<EOF
    gcloud compute resource-policies create snapshot-schedule kompast-daily \\
      --project=${GCP_PROJECT:-<project>} --region=${region:-<region>} \\
      --daily-schedule --start-time=03:30 --max-retention-days=14
    gcloud compute disks add-resource-policies $(hostname -s) \\
      --zone=${GCP_ZONE:-<zone>} --project=${GCP_PROJECT:-<project>} --resource-policies=kompast-daily
EOF
    fi
  fi
  cat <<EOF

Commands
  kompast status            service status            kompast version   tag and running digests
  kompast logs web          follow logs               kompast cleanup   prune dangling images
  kompast upgrade           re-run the installer      kompast reconfigure
  kompast backup            dump the database now     kompast backups   list local dumps
  kompast restore <file>    restore (destructive)     install log: /var/log/kompast-install.log
EOF
}

main "$@"
