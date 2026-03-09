#!/usr/bin/env bash
#
# PortOS Database Manager
#
# Manage PostgreSQL via Docker or native Homebrew installation.
# Supports switching between modes and migrating data safely.
#
# Usage:
#   scripts/db.sh <command>
#
# Commands:
#   status       Show current database status
#   start        Start the database (auto-detects mode)
#   stop         Stop the database
#   fix          Fix common issues (stale pid files, etc.)
#   setup-native Install and configure native PostgreSQL via Homebrew
#   use-docker   Switch to Docker mode
#   use-native   Switch to native mode
#   migrate      Export from current mode, import to the other
#   export       Export database to a SQL dump file
#   import       Import a SQL dump file into the database
#   logs         Show database logs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Note: In Docker mode, PGPORT must match the published port in docker-compose.yml (default 5561)
PGPORT="${PGPORT:-5561}"
PGUSER="${PGUSER:-portos}"
PGDATABASE="${PGDATABASE:-portos}"
PGPASSWORD="${PGPASSWORD:-portos}"
PGHOST="${PGHOST:-localhost}"
DUMP_DIR="$ROOT_DIR/data/db-dumps"
ENV_FILE="$ROOT_DIR/.env"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; }
info() { echo -e "${BLUE}🗄️  $1${NC}"; }

# Portable in-place sed helper (works with BSD and GNU sed)
inplace_sed() {
  local script="$1"
  local file="$2"
  local tmp
  tmp="$(mktemp "${file}.XXXXXX")" || return 1
  sed "$script" "$file" >"$tmp"
  mv "$tmp" "$file"
}

# Detect current mode from .env or default to docker
get_mode() {
  if [ -f "$ENV_FILE" ]; then
    local mode
    mode=$(grep -E '^PGMODE=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' || true)
    echo "${mode:-docker}"
  else
    echo "docker"
  fi
}

# Set mode in .env
set_mode() {
  local mode="$1"
  if [ -f "$ENV_FILE" ]; then
    if grep -q '^PGMODE=' "$ENV_FILE"; then
      inplace_sed "s/^PGMODE=.*/PGMODE=$mode/" "$ENV_FILE"
    else
      echo "PGMODE=$mode" >> "$ENV_FILE"
    fi
  else
    echo "PGMODE=$mode" > "$ENV_FILE"
  fi
  log "Mode set to: $mode"
}

# Check if Docker PostgreSQL is running
docker_running() {
  docker ps --filter name=portos-db --format '{{.Status}}' 2>/dev/null | grep -qi "up"
}

# Verify Docker and Compose plugin are available
require_docker_compose() {
  if ! command -v docker >/dev/null 2>&1; then
    err "Docker not installed"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    err "Docker daemon is not running. Start Docker Desktop or the Docker service."
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    err "Docker Compose plugin not available. Install it: https://docs.docker.com/compose/install/"
    exit 1
  fi
}

# Check if native PostgreSQL is running on our port
native_running() {
  PGPASSWORD="$PGPASSWORD" pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1
}

# Get native PostgreSQL data directory
native_data_dir() {
  echo "$ROOT_DIR/data/pgdata"
}

# Auto-detect Homebrew PostgreSQL on macOS and add to PATH
if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
  _pg_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
  if [ -d "$_pg_bin" ]; then
    export PATH="$_pg_bin:$PATH"
  fi
fi

# Check if native PostgreSQL is installed
has_native_pg() {
  command -v pg_ctl >/dev/null 2>&1
}

# Status command
cmd_status() {
  local mode
  mode=$(get_mode)
  info "Current mode: $mode"
  info "Port: $PGPORT"

  echo ""
  echo "Docker:"
  if ! command -v docker >/dev/null 2>&1; then
    warn "  Docker not installed"
  elif ! docker info >/dev/null 2>&1; then
    warn "  Docker daemon is not running"
  elif docker ps --filter name=portos-db --format '{{.Status}}' 2>/dev/null | grep -qi "up"; then
    log "  Container portos-db is running"
  else
    warn "  Container portos-db is not running"
  fi

  echo ""
  echo "Native:"
  if has_native_pg; then
    local datadir
    datadir=$(native_data_dir)
    if [ -f "$datadir/postmaster.pid" ] && PGPASSWORD="$PGPASSWORD" pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then
      log "  Native PostgreSQL is running (data: $datadir)"
    elif [ -d "$datadir" ]; then
      warn "  Native PostgreSQL configured but not running (data: $datadir)"
    else
      warn "  Native PostgreSQL installed but not configured for PortOS"
    fi
  else
    warn "  Native PostgreSQL not installed"
  fi

  echo ""
  echo "Connectivity:"
  if run_psql -c "SELECT 1" >/dev/null 2>&1; then
    log "  Database is accepting connections on port $PGPORT"
    local count
    count=$(run_psql -tAc "SELECT count(*) FROM memories" 2>/dev/null || echo "N/A")
    info "  Memories table has $count rows"
  else
    warn "  Cannot connect to database on port $PGPORT"
  fi
}

# Start command
cmd_start() {
  local mode
  mode=$(get_mode)

  if [ "$mode" = "native" ]; then
    start_native
  else
    start_docker
  fi
}

start_docker() {
  info "Starting Docker PostgreSQL..."

  require_docker_compose

  if docker_running; then
    log "Already running"
    return
  fi

  cd "$ROOT_DIR"
  docker compose up -d db
  info "Waiting for PostgreSQL..."

  for i in $(seq 1 30); do
    if docker compose exec -T db pg_isready -U "$PGUSER" >/dev/null 2>&1; then
      log "PostgreSQL ready on port $PGPORT"
      return
    fi
    sleep 1
  done

  # Check for stale pid issue (one auto-fix attempt only)
  if [ "${_DB_FIX_ATTEMPTED:-}" != "1" ] && docker logs portos-db --tail 5 2>&1 | grep -q "bogus data in lock file"; then
    warn "Stale postmaster.pid detected — running fix..."
    export _DB_FIX_ATTEMPTED=1
    cmd_fix
    start_docker
    return
  fi

  err "PostgreSQL did not become ready in 30s"
  echo "  Check logs: docker compose logs db"
  exit 1
}

start_native() {
  info "Starting native PostgreSQL..."

  if ! has_native_pg; then
    err "Native PostgreSQL not installed. Run: scripts/db.sh setup-native"
    exit 1
  fi

  local datadir
  datadir=$(native_data_dir)

  if [ ! -d "$datadir" ]; then
    err "Database not initialized. Run: scripts/db.sh setup-native"
    exit 1
  fi

  # Clean stale pid if needed — use credential-free pg_ctl status to avoid
  # false negatives from SCRAM auth when the server is actually running
  if [ -f "$datadir/postmaster.pid" ]; then
    if ! pg_ctl -D "$datadir" status >/dev/null 2>&1; then
      warn "Removing stale postmaster.pid..."
      rm -f "$datadir/postmaster.pid"
    fi
  fi

  pg_ctl -D "$datadir" -l "$datadir/server.log" -o "-p $PGPORT" start

  for i in $(seq 1 15); do
    if PGPASSWORD="$PGPASSWORD" pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then
      log "Native PostgreSQL ready on port $PGPORT"
      return
    fi
    sleep 1
  done

  err "PostgreSQL did not start in 15s. Check: $datadir/server.log"
  exit 1
}

# Stop command
cmd_stop() {
  local mode
  mode=$(get_mode)

  if [ "$mode" = "native" ]; then
    stop_native
  else
    stop_docker
  fi
}

stop_docker() {
  info "Stopping Docker PostgreSQL..."
  require_docker_compose
  cd "$ROOT_DIR"
  docker compose stop db 2>/dev/null || true
  log "Stopped"
}

stop_native() {
  local datadir
  datadir=$(native_data_dir)

  if [ ! -d "$datadir" ]; then
    warn "No native database found"
    return
  fi

  info "Stopping native PostgreSQL..."
  pg_ctl -D "$datadir" stop -m fast 2>/dev/null || true
  log "Stopped"
}

# Fix command — resolve common issues
cmd_fix() {
  local mode
  mode=$(get_mode)

  if [ "$mode" = "docker" ]; then
    fix_docker
  else
    fix_native
  fi
}

fix_docker() {
  info "Fixing Docker PostgreSQL..."

  require_docker_compose

  cd "$ROOT_DIR"

  # Determine the actual data volume used by the portos-db container, if it exists
  local data_volume=""
  data_volume=$(docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/var/lib/postgresql/data" }}{{ .Name }}{{ end }}{{ end }}' portos-db 2>/dev/null || echo "")

  # Stop and remove container
  docker compose stop db 2>/dev/null || true
  docker rm -f portos-db 2>/dev/null || true

  # Remove stale postmaster.pid from the volume
  if [ -n "$data_volume" ]; then
    docker run --rm -v "${data_volume}:/data" alpine:3.20 rm -f /data/postmaster.pid 2>/dev/null || true
  else
    # Fallback: derive volume name from compose project name
    local project_name
    project_name=$(docker compose config --format json 2>/dev/null | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "portos")
    docker run --rm -v "${project_name}_portos-pgdata:/data" alpine:3.20 rm -f /data/postmaster.pid 2>/dev/null ||
      docker run --rm -v "portos-pgdata:/data" alpine:3.20 rm -f /data/postmaster.pid 2>/dev/null || true
  fi

  log "Stale lock files cleaned"
  info "Run 'scripts/db.sh start' to restart"
}

fix_native() {
  local datadir
  datadir=$(native_data_dir)

  if [ ! -d "$datadir" ]; then
    warn "No native database found"
    return
  fi

  info "Fixing native PostgreSQL..."

  # Try graceful shutdown first
  pg_ctl -D "$datadir" stop -m fast 2>/dev/null || true

  # Remove stale pid
  rm -f "$datadir/postmaster.pid"

  log "Stale lock files cleaned"
  info "Run 'scripts/db.sh start' to restart"
}

# Setup native PostgreSQL
cmd_setup_native() {
  info "Setting up native PostgreSQL + pgvector..."

  local datadir
  datadir=$(native_data_dir)

  # Install PostgreSQL 17 and pgvector via Homebrew
  if [ "$(uname)" = "Darwin" ]; then
    if ! command -v brew >/dev/null 2>&1; then
      err "Homebrew not installed. Install from https://brew.sh"
      exit 1
    fi

    if ! brew list postgresql@17 >/dev/null 2>&1; then
      info "Installing PostgreSQL 17..."
      brew install postgresql@17
    else
      log "PostgreSQL 17 already installed"
    fi

    if ! brew list pgvector >/dev/null 2>&1; then
      info "Installing pgvector..."
      brew install pgvector
    else
      log "pgvector already installed"
    fi

    # Ensure pg17 binaries are on PATH
    PG_BIN="$(brew --prefix postgresql@17)/bin"
    export PATH="$PG_BIN:$PATH"
    info "Using PostgreSQL from: $PG_BIN"
    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$PG_BIN"; then
      warn "PostgreSQL bin dir is not on your default PATH"
      echo "  Add this to your shell profile (~/.zshrc or ~/.bashrc):"
      echo "    export PATH=\"$PG_BIN:\\\$PATH\""
      echo "  Then restart your terminal or run: source ~/.zshrc"
    fi
  else
    if ! command -v pg_ctl >/dev/null 2>&1; then
      err "Please install PostgreSQL 17 and pgvector for your platform"
      exit 1
    fi
  fi

  # Initialize the data directory
  if [ -d "$datadir" ]; then
    warn "Data directory already exists: $datadir"
    echo "  To reinitialize, remove it first: rm -rf $datadir"
  else
    info "Initializing database cluster..."
    mkdir -p "$datadir"
    local pwfile
    pwfile="$(mktemp)"
    chmod 600 "$pwfile"
    printf '%s\n' "$PGPASSWORD" > "$pwfile"
    initdb -D "$datadir" --username="$PGUSER" --auth=scram-sha-256 --pwfile="$pwfile" --no-locale --encoding=UTF8
    rm -f "$pwfile"
    log "Database cluster initialized"

    # Configure to use our port
    echo "port = $PGPORT" >> "$datadir/postgresql.conf"
    echo "listen_addresses = 'localhost'" >> "$datadir/postgresql.conf"
    info "Configured to listen on port $PGPORT"
  fi

  # Start the server
  start_native

  # Create the database and run init SQL
  if ! PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -lqt 2>/dev/null | cut -d\| -f1 | grep -qw "$PGDATABASE"; then
    info "Creating database: $PGDATABASE"
    PGPASSWORD="$PGPASSWORD" createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$PGDATABASE"
  fi

  # Set user password (using psql variables to avoid shell injection)
  PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -v pw="$PGPASSWORD" -v user="$PGUSER" -c "ALTER USER :\"user\" WITH PASSWORD :'pw';" 2>/dev/null

  # Run init SQL
  info "Applying schema..."
  PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 --single-transaction -f "$ROOT_DIR/server/scripts/init-db.sql"
  log "Schema applied"

  # Switch mode
  set_mode native

  # Update PGPORT in .env if not already correct
  if [ -f "$ENV_FILE" ] && ! grep -q "^PGPORT=$PGPORT" "$ENV_FILE"; then
    if grep -q "^PGPORT=" "$ENV_FILE"; then
      inplace_sed "s/^PGPORT=.*/PGPORT=$PGPORT/" "$ENV_FILE"
    else
      printf '\nPGPORT=%s\n' "$PGPORT" >> "$ENV_FILE"
    fi
  fi

  echo ""
  log "Native PostgreSQL is ready!"
  info "Data directory: $datadir"
  info "To migrate data from Docker: scripts/db.sh migrate"
}

# Run psql command, using Docker exec in Docker mode if host psql is unavailable
run_psql() {
  local mode
  mode=$(get_mode)
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "$@"
  elif [ "$mode" = "docker" ] && docker_running; then
    docker compose --project-directory "$ROOT_DIR" exec -T -e PGPASSWORD="$PGPASSWORD" db psql -U "$PGUSER" -d "$PGDATABASE" "$@"
  else
    err "psql not found on host and Docker DB is not running"
    exit 1
  fi
}

# Run pg_dump, using Docker exec in Docker mode if host pg_dump is unavailable
run_pg_dump() {
  local mode
  mode=$(get_mode)
  if command -v pg_dump >/dev/null 2>&1; then
    PGPASSWORD="$PGPASSWORD" pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "$@"
  elif [ "$mode" = "docker" ] && docker_running; then
    docker compose --project-directory "$ROOT_DIR" exec -T -e PGPASSWORD="$PGPASSWORD" db pg_dump -U "$PGUSER" -d "$PGDATABASE" "$@"
  else
    err "pg_dump not found on host and Docker DB is not running"
    exit 1
  fi
}

# Export database to SQL dump
cmd_export() {
  local label="${1:-$(date +%Y%m%d-%H%M%S)}"

  # Sanitize label to prevent path traversal
  if echo "$label" | grep -qE '[^A-Za-z0-9._-]'; then
    err "Invalid label: only alphanumeric, dots, hyphens, and underscores are allowed"
    exit 1
  fi

  mkdir -p "$DUMP_DIR"
  local dumpfile="$DUMP_DIR/portos-$label.sql"

  info "Exporting database to $dumpfile..." >&2

  run_pg_dump --no-owner --no-privileges --if-exists --clean > "$dumpfile"

  log "Exported to: $dumpfile" >&2
  echo "$dumpfile"
}

# Import SQL dump into database
cmd_import() {
  local dumpfile="$1"

  if [ ! -f "$dumpfile" ]; then
    err "Dump file not found: $dumpfile"
    exit 1
  fi

  info "Importing $dumpfile..."

  # Use stdin redirection so the dump is accessible even in Docker exec mode
  run_psql -v ON_ERROR_STOP=1 --single-transaction < "$dumpfile"

  log "Import complete"
}

# Migrate data between Docker and native
cmd_migrate() {
  local current_mode
  current_mode=$(get_mode)
  local target_mode

  if [ "$current_mode" = "docker" ]; then
    target_mode="native"
  else
    target_mode="docker"
  fi

  info "Migrating data from $current_mode to $target_mode..."

  # Verify source is running
  if ! run_psql -c "SELECT 1" >/dev/null 2>&1; then
    err "Source database ($current_mode) is not running on port $PGPORT"
    echo "  Start it first: scripts/db.sh start"
    exit 1
  fi

  # Count source records
  local count
  count=$(run_psql -tAc "SELECT count(*) FROM memories" 2>/dev/null || echo "0")
  info "Source has $count memories"

  # Export from source
  local dumpfile
  dumpfile=$(cmd_export "migrate-$(date +%Y%m%d-%H%M%S)")

  # Stop source
  info "Stopping $current_mode..."
  cmd_stop

  # Switch mode and start target — restore mode on failure or interruption
  set_mode "$target_mode"
  _migrate_cleanup() {
    warn "Migration aborted — restoring mode to $current_mode"
    set_mode "$current_mode"
  }
  trap '_migrate_cleanup' ERR INT TERM

  if [ "$target_mode" = "native" ]; then
    if [ ! -d "$(native_data_dir)" ]; then
      err "Native PostgreSQL not set up. Run: scripts/db.sh setup-native"
      set_mode "$current_mode"
      trap - ERR
      exit 1
    fi
    start_native
  else
    start_docker
  fi

  # Import into target
  cmd_import "$dumpfile"

  # Clear traps after successful import
  trap - ERR INT TERM

  # Verify
  local new_count
  new_count=$(run_psql -tAc "SELECT count(*) FROM memories" 2>/dev/null || echo "0")

  echo ""
  log "Migration complete!"
  info "Source ($current_mode): $count memories"
  info "Target ($target_mode): $new_count memories"
  info "Dump saved: $dumpfile"
}

# Use Docker mode
cmd_use_docker() {
  stop_native 2>/dev/null || true
  set_mode docker
  info "Switched to Docker mode. Run 'scripts/db.sh start' to start."
}

# Use native mode
cmd_use_native() {
  if ! has_native_pg; then
    err "Native PostgreSQL not installed. Run: scripts/db.sh setup-native"
    exit 1
  fi
  if [ ! -d "$(native_data_dir)" ]; then
    err "Native database not initialized. Run: scripts/db.sh setup-native"
    exit 1
  fi
  stop_docker 2>/dev/null || true
  set_mode native
  info "Switched to native mode. Run 'scripts/db.sh start' to start."
}

# Show logs
cmd_logs() {
  local mode
  mode=$(get_mode)

  if [ "$mode" = "docker" ]; then
    require_docker_compose
    cd "$ROOT_DIR"
    docker compose logs -f db
  else
    local datadir
    datadir=$(native_data_dir)
    if [ -f "$datadir/server.log" ]; then
      tail -f "$datadir/server.log"
    else
      warn "No log file found at $datadir/server.log"
    fi
  fi
}

# Help
cmd_help() {
  cat <<'HELP'
PortOS Database Manager

Usage: scripts/db.sh <command>

Commands:
  status         Show database status (both Docker and native)
  start          Start the database (uses current mode)
  stop           Stop the database
  fix            Fix stale postmaster.pid and other issues
  logs           Tail database logs

  setup-native   Install PostgreSQL 17 + pgvector via Homebrew
  use-docker     Switch to Docker mode
  use-native     Switch to native mode

  migrate        Export from current mode, import to the other
  export [label] Export database to data/db-dumps/
  import <file>  Import a SQL dump file

Environment:
  PGMODE=docker|native   Set in .env to control default mode
  PGPORT=5561            PostgreSQL port (default: 5561)
  PGPASSWORD=portos      Database password
HELP
}

# Main dispatch
case "${1:-help}" in
  status)       cmd_status ;;
  start)        cmd_start ;;
  stop)         cmd_stop ;;
  fix)          cmd_fix ;;
  setup-native) cmd_setup_native ;;
  use-docker)   cmd_use_docker ;;
  use-native)   cmd_use_native ;;
  migrate)      cmd_migrate ;;
  export)       cmd_export "${2:-}" ;;
  import)       cmd_import "${2:?Usage: scripts/db.sh import <file>}" ;;
  logs)         cmd_logs ;;
  help|--help|-h) cmd_help ;;
  *)            err "Unknown command: $1"; cmd_help; exit 1 ;;
esac
