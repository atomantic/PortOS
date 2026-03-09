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
      sed -i '' "s/^PGMODE=.*/PGMODE=$mode/" "$ENV_FILE"
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

# Check if native PostgreSQL is running on our port
native_running() {
  pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1
}

# Get native PostgreSQL data directory
native_data_dir() {
  echo "$ROOT_DIR/data/pgdata"
}

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
  if docker ps --filter name=portos-db --format '{{.Status}}' 2>/dev/null | grep -qi "up"; then
    log "  Container portos-db is running"
  else
    warn "  Container portos-db is not running"
  fi

  echo ""
  echo "Native:"
  if has_native_pg; then
    local datadir
    datadir=$(native_data_dir)
    if [ -f "$datadir/postmaster.pid" ] && pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
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
  if PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c "SELECT 1" >/dev/null 2>&1; then
    log "  Database is accepting connections on port $PGPORT"
    local count
    count=$(PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -tAc "SELECT count(*) FROM memories" 2>/dev/null || echo "N/A")
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

  if ! command -v docker >/dev/null 2>&1; then
    err "Docker not installed"
    exit 1
  fi

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

  # Clean stale pid if needed
  if [ -f "$datadir/postmaster.pid" ]; then
    if ! pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
      warn "Removing stale postmaster.pid..."
      rm -f "$datadir/postmaster.pid"
    fi
  fi

  pg_ctl -D "$datadir" -l "$datadir/server.log" -o "-p $PGPORT" start

  for i in $(seq 1 15); do
    if pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
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

  cd "$ROOT_DIR"

  # Stop and remove container
  docker compose stop db 2>/dev/null || true
  docker rm -f portos-db 2>/dev/null || true

  # Remove stale postmaster.pid from the volume
  # Compose prefixes volume names with project name: portos_portos-pgdata
  local project_name
  project_name=$(docker compose config --format json 2>/dev/null | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "portos")
  docker run --rm -v "${project_name}_portos-pgdata:/data" alpine rm -f /data/postmaster.pid 2>/dev/null ||
    docker run --rm -v "portos-pgdata:/data" alpine rm -f /data/postmaster.pid 2>/dev/null || true

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
  pg_ctl -D "$datadir" stop -m immediate 2>/dev/null || true

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
    initdb -D "$datadir" --username="$PGUSER" --auth=trust --no-locale --encoding=UTF8
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
    createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$PGDATABASE"
  fi

  # Set user password (using psql variable to avoid shell injection)
  PGPASSWORD="" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -v pw="$PGPASSWORD" -c "ALTER USER $PGUSER WITH PASSWORD :'pw';" 2>/dev/null || true

  # Run init SQL
  info "Applying schema..."
  PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -f "$ROOT_DIR/server/scripts/init-db.sql"
  log "Schema applied"

  # Switch mode
  set_mode native

  # Update PGPORT in .env if not already correct
  if [ -f "$ENV_FILE" ] && ! grep -q "^PGPORT=$PGPORT" "$ENV_FILE"; then
    if grep -q "^PGPORT=" "$ENV_FILE"; then
      sed -i '' "s/^PGPORT=.*/PGPORT=$PGPORT/" "$ENV_FILE"
    fi
  fi

  echo ""
  log "Native PostgreSQL is ready!"
  info "Data directory: $datadir"
  info "To migrate data from Docker: scripts/db.sh migrate"
}

# Export database to SQL dump
cmd_export() {
  local label="${1:-$(date +%Y%m%d-%H%M%S)}"
  mkdir -p "$DUMP_DIR"
  local dumpfile="$DUMP_DIR/portos-$label.sql"

  info "Exporting database to $dumpfile..."

  PGPASSWORD="$PGPASSWORD" pg_dump \
    -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    --no-owner --no-privileges --if-exists --clean \
    -f "$dumpfile"

  log "Exported to: $dumpfile"
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

  PGPASSWORD="$PGPASSWORD" psql \
    -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -f "$dumpfile"

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
  if ! PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c "SELECT 1" >/dev/null 2>&1; then
    err "Source database ($current_mode) is not running on port $PGPORT"
    echo "  Start it first: scripts/db.sh start"
    exit 1
  fi

  # Count source records
  local count
  count=$(PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -tAc "SELECT count(*) FROM memories" 2>/dev/null || echo "0")
  info "Source has $count memories"

  # Export from source
  local dumpfile
  dumpfile=$(cmd_export "migrate-$(date +%Y%m%d-%H%M%S)")

  # Stop source
  info "Stopping $current_mode..."
  cmd_stop

  # Switch mode and start target
  set_mode "$target_mode"

  if [ "$target_mode" = "native" ]; then
    if [ ! -d "$(native_data_dir)" ]; then
      err "Native PostgreSQL not set up. Run: scripts/db.sh setup-native"
      set_mode "$current_mode"
      exit 1
    fi
    start_native
  else
    start_docker
  fi

  # Import into target
  cmd_import "$dumpfile"

  # Verify
  local new_count
  new_count=$(PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -tAc "SELECT count(*) FROM memories" 2>/dev/null || echo "0")

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
