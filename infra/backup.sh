#!/usr/bin/env bash
# Kompast Postgres backups: pg_dump from the running postgres container.
#
#   ./backup.sh [backup]                   dump now into BACKUP_DIR
#   sudo ./backup.sh install-cron         daily 02:30 root cron → /etc/cron.d/kompast-backup
#   ./backup.sh list                      list local dumps
#   sudo ./backup.sh restore <file.dump>  restore over the live database (destructive)
#   ./backup.sh --help
#
# Settings are read from .env in this directory (written by install.sh):
#   POSTGRES_USER (kompast_admin), POSTGRES_DB (kompast), BACKUP_DIR (/var/backups/kompast),
#   BACKUP_RETENTION_DAYS (14), BACKUP_GCS_URI (optional gs://bucket/prefix; needs gcloud).
# .env is never uploaded. Keep your own copy of it off this VM.

set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")"
ENV_FILE=.env
CRON_FILE=/etc/cron.d/kompast-backup
LOG_FILE=/var/log/kompast-backup.log

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
die() { log "ERROR $*" >&2; exit 1; }

print_usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SELF"
}

env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
cfg() {
  local v
  v="$(env_get "$1")"
  printf '%s' "${v:-$2}"
}

PG_USER="$(cfg POSTGRES_USER kompast_admin)"
PG_DB="$(cfg POSTGRES_DB kompast)"
RETENTION="$(cfg BACKUP_RETENTION_DAYS 14)"
GCS_URI="$(cfg BACKUP_GCS_URI "")"
BACKUP_DIR="$(cfg BACKUP_DIR /var/backups/kompast)"

cmd_backup() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed."
  [[ "$RETENTION" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_RETENTION_DAYS must be a whole number of days (got '$RETENTION')."

  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  local stamp file tmp status=0
  stamp="$(date +%Y%m%d-%H%M%S)"
  file="$BACKUP_DIR/kompast-$stamp.dump"
  tmp="$file.partial"

  log "dumping database '$PG_DB' as '$PG_USER' → $file"
  if ! docker compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$tmp"; then
    rm -f "$tmp"
    die "pg_dump failed (is the postgres service running? cd $(pwd) && docker compose ps)"
  fi
  if [[ ! -s "$tmp" ]]; then
    rm -f "$tmp"
    die "pg_dump produced an empty file"
  fi
  mv "$tmp" "$file"
  chmod 600 "$file"
  log "backup written: $file ($(du -h "$file" | cut -f1))"

  if [[ -n "$GCS_URI" ]]; then
    if ! command -v gcloud >/dev/null 2>&1; then
      log "ERROR gcloud is not installed; cannot copy to $GCS_URI (local copy kept)"
      status=1
    elif gcloud storage cp "$file" "${GCS_URI%/}/"; then
      log "uploaded $(basename "$file") to ${GCS_URI%/}/"
    else
      log "ERROR upload to ${GCS_URI%/}/ failed; local copy kept at $file"
      status=1
    fi
  fi

  find "$BACKUP_DIR" -maxdepth 1 -name 'kompast-*.dump' -mtime "+$RETENTION" -print -delete \
    | sed 's/^/pruned /' || true
  log "retention: local dumps older than $RETENTION days removed"
  exit "$status"
}

cmd_install_cron() {
  [[ $EUID -eq 0 ]] || die "install-cron needs root: sudo $SELF install-cron"
  touch "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  cat > "$CRON_FILE" <<EOF
# Kompast daily Postgres backup, managed by backup.sh install-cron
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 2 * * * root "$SELF" backup >> "$LOG_FILE" 2>&1
EOF
  chmod 644 "$CRON_FILE"
  log "cron installed: $CRON_FILE (daily 02:30, log $LOG_FILE)"
}

cmd_list() {
  local f found=0
  for f in "$BACKUP_DIR"/kompast-*.dump; do
    [[ -e "$f" ]] || continue
    ls -lh "$f"
    found=1
  done
  if (( found == 0 )); then
    log "no dumps in $BACKUP_DIR"
  fi
}

cmd_restore() {
  local file="${1:-}" answer abs
  [[ -n "$file" ]] || die "usage: $SELF restore <file.dump>"
  [[ -f "$file" ]] || die "no such file: $file"
  abs="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
  command -v docker >/dev/null 2>&1 || die "docker is not installed."

  echo "This replaces the contents of database '$PG_DB' with: $abs"
  echo "Services web, collab and worker are stopped for the restore."
  printf 'Type the database name (%s) to confirm: ' "$PG_DB"
  read -r answer </dev/tty || die "no terminal to confirm on"
  [[ "$answer" == "$PG_DB" ]] || die "confirmation did not match; nothing changed"

  log "stopping web, collab and worker"
  docker compose stop web collab worker
  log "restoring $abs"
  if ! docker compose exec -T postgres pg_restore -U "$PG_USER" -d "$PG_DB" --clean --if-exists --no-owner < "$abs"; then
    die "pg_restore reported errors. Services are still stopped. Fix the cause, then: cd $(pwd) && docker compose run --rm migrate && docker compose up -d"
  fi
  log "re-applying roles and row-level security (migrate)"
  docker compose run --rm migrate || die "migrate failed after the restore; services are still stopped. Check: docker compose logs migrate"
  log "starting services"
  docker compose up -d
  log "restore complete"
}

case "${1:-backup}" in
  backup) cmd_backup ;;
  install-cron) cmd_install_cron ;;
  list) cmd_list ;;
  restore) cmd_restore "${2:-}" ;;
  -h | --help | help) print_usage ;;
  *) print_usage >&2; exit 1 ;;
esac
