#!/usr/bin/env bash
#
# PortOS Database Manager
#
# Manage PostgreSQL via Docker or native (system) installation.
# Native mode reuses an existing system PostgreSQL (e.g., Homebrew) on port 5432
# rather than running a separate instance. Docker mode runs a container on port 5561.
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
#                (provisions the PGHOST/PGPORT you select; never another cluster)
#   use-docker   Unavailable pending coordinated offline cutover
#   use-native   Unavailable pending coordinated offline cutover
#   migrate      Unavailable pending coordinated offline cutover
#   export       Export database to a SQL dump file
#   import       Import a SQL dump file into the database
#   logs         Show database logs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Read the same .env grammar as setup/PM2, without sourcing or evaluating it.
# NUL-delimited values preserve password whitespace and shell metacharacters.
# The completion marker makes a missing Node/parser or truncated pipe fail closed
# before any database command, instead of silently targeting the defaults.
read_db_config() {
  node --input-type=commonjs - "$ROOT_DIR" "$1" <<'NODE'
const { join } = require('node:path');
const { parseEnvFile } = require(join(process.argv[2], 'scripts/lib/envFile.cjs'));
const saved = parseEnvFile(join(process.argv[2], '.env'));
const value = (key, fallback = '') => process.env[key] || saved[key] || fallback;
const mode = value('PGMODE', 'docker');
const nativeSetup = process.argv[3] === 'setup-native';
const selectedHost = value('PGHOST');
const dockerPort = value('PGPORT_DOCKER', '5561');
const selectedPort = nativeSetup
  ? process.env.PORTOS_NATIVE_PGPORT || value('PGPORT')
  : process.env.PGPORT || (mode === 'native' ? saved.PGPORT || '' : dockerPort);
const settings = {
  PGMODE: mode, PGUSER: value('PGUSER', 'portos'),
  PGDATABASE: value('PGDATABASE', 'portos'), PGPASSWORD: value('PGPASSWORD', 'portos'),
  PGHOST: selectedHost || 'localhost', SELECTED_PGHOST: selectedHost,
  PGPORT: selectedPort || (mode === 'native' || nativeSetup ? '5432' : dockerPort),
  SELECTED_PGPORT: selectedPort, PGPORT_DOCKER: dockerPort,
};
process.stdout.write(Object.entries({ ...settings, complete: '1' })
  .flat().join('\0') + '\0');
NODE
}
_DB_CONFIG_COMPLETE=false
while IFS= read -r -d '' key && IFS= read -r -d '' value; do
  case "$key" in
    PGMODE|PGUSER|PGDATABASE|PGPASSWORD|PGHOST|PGPORT|PGPORT_DOCKER|SELECTED_PGHOST|SELECTED_PGPORT)
      printf -v "$key" '%s' "$value" ;;
    complete) _DB_CONFIG_COMPLETE=true ;;
  esac
done < <(read_db_config "${1:-}")

if [ "$_DB_CONFIG_COMPLETE" != true ]; then
  echo "❌ Could not load database configuration; no database command was run" >&2
  exit 1
fi
unset key value _DB_CONFIG_COMPLETE
# The maintenance coordinator names its install's dump directory explicitly
# (its data root can differ from this checkout); otherwise use this checkout.
DUMP_DIR="${PORTOS_DUMP_DIR:-$ROOT_DIR/data/db-dumps}"
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

get_mode() {
  printf '%s\n' "$PGMODE"
}

# Container-local tools are equivalent only for the configured local Docker
# endpoint. A shell host/port override must not silently export another DB.
uses_local_docker_endpoint() {
  [ "$PGMODE" = docker ] && [ "$PGPORT" = "$PGPORT_DOCKER" ] || return 1
  case "$PGHOST" in localhost|127.0.0.1|::1) return 0 ;; *) return 1 ;; esac
}

EXPLICIT_ENDPOINT=false

# A coordinator must bind each transfer to its recorded endpoint, not saved
# mode, inherited PGPORT, or whichever Docker container happens to be running.
# Passwords remain in the environment, never command arguments.
set_explicit_endpoint() {
  if [ "$#" -ne 4 ] || [ -z "$1" ] || [ "${#1}" -gt 255 ] ||
      [[ "$1" =~ [[:space:],=] ]] || [[ ! "$2" =~ ^[0-9]{1,5}$ ]] ||
      [ "$((10#$2))" -lt 1 ] || [ "$((10#$2))" -gt 65535 ] ||
      [ -z "$3" ] || [ "${#3}" -gt 63 ] ||
      [ -z "$4" ] || [ "${#4}" -gt 63 ] || [[ "$4" == *"="* ]] ||
      [[ "$4" == postgres://* ]] || [[ "$4" == postgresql://* ]]; then
    err "Invalid explicit endpoint: expected host, port (1-65535), user, and database name" >&2
    return 1
  fi
  PGHOST="$1"
  PGPORT="$2"
  PGUSER="$3"
  PGDATABASE="$4"
  EXPLICIT_ENDPOINT=true
}

cmd_transfer() {
  local action="$1"
  shift
  if [ "${1:-}" = "--endpoint" ]; then
    if [ "$#" -lt 5 ]; then
      err "Usage: $action --endpoint <host> <port> <user> <database> [label|file]" >&2
      return 1
    fi
    set_explicit_endpoint "$2" "$3" "$4" "$5" || return 1
    shift 5
  fi
  if [ "$#" -gt 1 ] || { [ "$action" = "import" ] && [ "$#" -ne 1 ]; }; then
    err "Expected one import file or an optional export label" >&2
    return 1
  fi
  "cmd_$action" "${1:-}"
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

# Check if native PostgreSQL is accepting connections on the expected port
native_running() {
  PGPASSWORD="$PGPASSWORD" pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1
}

# Auto-detect Homebrew PostgreSQL 17 on macOS and add to PATH
# Check both arm64 (/opt/homebrew) and Intel (/usr/local) prefixes
if [ "$(uname)" = "Darwin" ]; then
  for _prefix in /opt/homebrew/opt/postgresql@17 /usr/local/opt/postgresql@17; do
    if [ -x "$_prefix/bin/psql" ]; then
      export PATH="$_prefix/bin:$PATH"
      break
    fi
  done
fi

# Check if native PostgreSQL is installed
has_native_pg() {
  command -v psql >/dev/null 2>&1
}

# Detect an already-running system PostgreSQL and its port
detect_system_pg() {
  # Check standard port 5432 first
  if pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    echo "5432"
    return 0
  fi
  # Check if pg_ctl reports a running server
  if command -v pg_ctl >/dev/null 2>&1; then
    local datadir=""
    # Try Homebrew default data dir
    if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      datadir="$(brew --prefix)/var/postgresql@17"
      if [ ! -d "$datadir" ]; then
        datadir="$(brew --prefix)/var/postgres"
      fi
    fi
    if [ -n "$datadir" ] && [ -d "$datadir" ] && pg_ctl -D "$datadir" status >/dev/null 2>&1; then
      # Parse port from postgresql.conf
      local port
      port=$(grep -E '^port\s*=' "$datadir/postgresql.conf" 2>/dev/null | sed 's/.*=\s*//' | tr -d '[:space:]' || echo "5432")
      echo "${port:-5432}"
      return 0
    fi
  fi
  return 1
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
    local sys_port
    if sys_port=$(detect_system_pg); then
      log "  System PostgreSQL is running on port $sys_port"
      # Check if portos database exists
      if PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$sys_port" -U "$PGUSER" -d "$PGDATABASE" -c "SELECT 1" >/dev/null 2>&1; then
        log "  PortOS database exists"
      else
        warn "  PortOS database/user not configured (run: scripts/db.sh setup-native)"
      fi
    else
      warn "  Native PostgreSQL installed but not running"
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

  # Check if system PostgreSQL is already running and accepting connections
  if PGPASSWORD="$PGPASSWORD" pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then
    log "Native PostgreSQL already running on port $PGPORT"
    return
  fi

  # Try to start via Homebrew services (macOS)
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    if brew services list 2>/dev/null | grep -q "postgresql@17"; then
      info "Starting PostgreSQL via Homebrew services..."
      brew services start postgresql@17 2>/dev/null || true
      for i in $(seq 1 15); do
        if pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
          log "Native PostgreSQL ready on port $PGPORT"
          return
        fi
        sleep 1
      done
    fi
  fi

  # Try pg_ctl with Homebrew data directory
  if command -v pg_ctl >/dev/null 2>&1; then
    local datadir=""
    if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      datadir="$(brew --prefix)/var/postgresql@17"
      if [ ! -d "$datadir" ]; then
        datadir="$(brew --prefix)/var/postgres"
      fi
    fi
    if [ -n "$datadir" ] && [ -d "$datadir" ]; then
      pg_ctl -D "$datadir" -l "$datadir/server.log" start 2>/dev/null || true
      for i in $(seq 1 15); do
        if pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
          log "Native PostgreSQL ready on port $PGPORT"
          return
        fi
        sleep 1
      done
    fi
  fi

  err "Could not start PostgreSQL. Try: brew services start postgresql@17"
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
  info "Stopping native PostgreSQL..."
  # Stop via Homebrew services (macOS)
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew services stop postgresql@17 2>/dev/null || true
    log "Stopped"
    return
  fi
  # Fallback: pg_ctl
  if command -v pg_ctl >/dev/null 2>&1; then
    local datadir=""
    if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      datadir="$(brew --prefix)/var/postgresql@17"
    fi
    if [ -n "$datadir" ] && [ -d "$datadir" ]; then
      pg_ctl -D "$datadir" stop -m fast 2>/dev/null || true
    fi
  fi
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
  info "Fixing native PostgreSQL..."
  # Restart via Homebrew services
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew services restart postgresql@17 2>/dev/null || true
    log "PostgreSQL restarted via Homebrew"
    return
  fi
  warn "Manual fix may be needed — check PostgreSQL logs"
}

# Setup native PostgreSQL — detects and reuses existing system installation
cmd_setup_native() {
  info "Setting up native PostgreSQL for PortOS..."

  # Step 1: Ensure PostgreSQL is installed
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
    if ! command -v psql >/dev/null 2>&1; then
      err "Please install PostgreSQL 17 and pgvector for your platform"
      exit 1
    fi
  fi

  # Step 2: Ensure PostgreSQL is running. A caller-selected endpoint
  # (PGHOST/PGPORT) is provisioned as-is: discovery must never redirect SQL
  # (role/password changes, schema) to a different cluster than the one chosen.
  if [ -n "$SELECTED_PGPORT" ] || [ -n "$SELECTED_PGHOST" ]; then
    PGPORT="${SELECTED_PGPORT:-5432}"
    if pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
      log "PostgreSQL already running at $PGHOST:$PGPORT"
    elif [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      info "Starting PostgreSQL..."
      brew services start postgresql@17
      sleep 2
      if pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
        log "PostgreSQL started at $PGHOST:$PGPORT"
      else
        err "PostgreSQL is not accepting connections at $PGHOST:$PGPORT. Start the selected cluster and try again."
        exit 1
      fi
    else
      err "PostgreSQL is not running at $PGHOST:$PGPORT. Start the selected cluster and try again."
      exit 1
    fi
  else
    local pg_port=""
    if pg_port=$(detect_system_pg); then
      log "System PostgreSQL already running on port $pg_port"
    else
      info "Starting PostgreSQL..."
      if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
        brew services start postgresql@17
        sleep 2
        if pg_port=$(detect_system_pg); then
          log "PostgreSQL started on port $pg_port"
        else
          err "PostgreSQL failed to start. Check: brew services list"
          exit 1
        fi
      else
        err "PostgreSQL is not running. Start it and try again."
        exit 1
      fi
    fi
    PGPORT="$pg_port"
  fi

  # Step 3: Create portos user if it doesn't exist
  # Connect as the current system user (default Homebrew superuser) to create the role
  local sys_user
  sys_user="$(whoami)"
  if ! psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PGUSER'" 2>/dev/null | grep -q 1; then
    info "Creating database user: $PGUSER"
    psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d postgres \
      -c "CREATE ROLE $PGUSER WITH LOGIN PASSWORD '$PGPASSWORD' CREATEDB SUPERUSER;"
    log "User $PGUSER created"
  else
    log "User $PGUSER already exists"
    # Ensure password and superuser are set correctly (superuser needed for extension management)
    psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d postgres \
      -c "ALTER USER $PGUSER WITH PASSWORD '$PGPASSWORD' SUPERUSER;" 2>/dev/null || true
  fi

  # Step 4: Create portos database if it doesn't exist
  if ! psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d postgres -lqt 2>/dev/null | cut -d\| -f1 | grep -qw "$PGDATABASE"; then
    info "Creating database: $PGDATABASE"
    psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d postgres -c "CREATE DATABASE $PGDATABASE OWNER $PGUSER;"
    log "Database $PGDATABASE created"
  else
    log "Database $PGDATABASE already exists"
  fi

  # Step 5: Enable pgvector extension and apply schema
  info "Applying schema..."
  # pgvector extension requires superuser — create as system user, then run schema as portos
  psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d "$PGDATABASE" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || true
  psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d "$PGDATABASE" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>/dev/null || true
  PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 --single-transaction -f "$ROOT_DIR/server/scripts/init-db.sql"
  log "Schema applied"

  echo ""
  log "Native PostgreSQL is ready!"
  info "Using system PostgreSQL on port $PGPORT"
  info "Database: $PGDATABASE (user: $PGUSER)"
  info "Provisioning only: the selected mode is unchanged; Docker data has not been migrated."
  info "Coordinated backend migration is not yet available. Keep using the current backend."
}

# Scope inherited libpq settings out of explicit transfers. PGHOSTADDR takes
# precedence over -h's network destination, PGSERVICE can supply another
# endpoint, and PGOPTIONS can redirect statements (search_path). Only the
# password crosses; every connection parameter is an explicit argument.
run_explicit_pg() (
  local binary="$1" host="$PGHOST" port="$PGPORT" user="$PGUSER" database="$PGDATABASE" password="$PGPASSWORD"
  shift
  local name
  for name in $(compgen -e); do
    case "$name" in PG*) unset "$name" ;; esac
  done
  PGPASSWORD="$password" "$binary" -h "$host" -p "$port" -U "$user" -d "$database" "$@"
)

# Run psql command, using Docker exec in Docker mode if host psql is unavailable
run_psql() {
  if [ "$EXPLICIT_ENDPOINT" = true ]; then
    # Never fall back to container-local psql: that is a different endpoint.
    run_explicit_pg psql "$@"
    return $?
  fi
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "$@"
  elif uses_local_docker_endpoint && docker_running; then
    docker exec -i -e PGPASSWORD="$PGPASSWORD" portos-db psql -U "$PGUSER" -d "$PGDATABASE" "$@"
  else
    err "psql not found on host and Docker DB is not running"
    exit 1
  fi
}

# Run pg_dump, preferring Docker exec in Docker mode to avoid version mismatch
run_pg_dump() {
  if [ "$EXPLICIT_ENDPOINT" = true ]; then
    run_explicit_pg pg_dump "$@"
    return $?
  fi
  if uses_local_docker_endpoint && docker_running; then
    docker exec -e PGPASSWORD="$PGPASSWORD" portos-db pg_dump -U "$PGUSER" -d "$PGDATABASE" "$@"
  elif command -v pg_dump >/dev/null 2>&1; then
    PGPASSWORD="$PGPASSWORD" pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "$@"
  else
    err "pg_dump not found on host and Docker DB is not running" >&2
    # return (not exit) so cmd_export can clean up its temp file
    return 1
  fi
}

# Export database to SQL dump. Prints the dump path on stdout ONLY on success.
# Every step is checked explicitly: cmd_migrate calls this inside a command
# substitution, where set -e is not inherited (and inherit_errexit is missing
# from older supported Bash), so a failed pg_dump must not fall through to the
# rename + success echo (#8781).
cmd_export() {
  local label="${1:-$(date +%Y%m%d-%H%M%S)}"

  # Sanitize label to prevent path traversal
  if echo "$label" | grep -qE '[^A-Za-z0-9._-]'; then
    err "Invalid label: only alphanumeric, dots, hyphens, and underscores are allowed" >&2
    return 1
  fi

  if ! mkdir -p "$DUMP_DIR"; then
    err "Could not create dump directory: $DUMP_DIR" >&2
    return 1
  fi
  local dumpfile="$DUMP_DIR/portos-$label.sql"

  info "Exporting database to $dumpfile..." >&2

  # Dump to a temp file first so a failed dump never replaces an existing one
  local tmpfile
  if ! tmpfile="$(mktemp "$DUMP_DIR/portos-export.XXXXXX")"; then
    err "Could not create a temporary dump file in $DUMP_DIR" >&2
    return 1
  fi
  if ! run_pg_dump --no-owner --no-privileges --no-comments --if-exists --clean > "$tmpfile"; then
    rm -f "$tmpfile"
    err "pg_dump failed — no dump was written" >&2
    return 1
  fi
  if ! mv "$tmpfile" "$dumpfile"; then
    rm -f "$tmpfile"
    err "Could not move the dump into place: $dumpfile" >&2
    return 1
  fi

  log "Exported to: $dumpfile" >&2
  echo "$dumpfile"
}

# Import SQL dump into database
cmd_import() (
  local dumpfile="$1"

  if [ ! -f "$dumpfile" ]; then
    err "Dump file not found: $dumpfile"
    exit 1
  fi

  info "Importing $dumpfile..."

  # Finish a private, byte-preserving replay copy before psql sees any SQL.
  # A failed source read must never become a successful end-of-script commit.
  local stage replay
  stage="$(mktemp -d "${TMPDIR:-/tmp}/portos-database-import.XXXXXX")" || return 1
  trap 'rm -rf "$stage"' EXIT
  if ! replay="$(node "$ROOT_DIR/scripts/prepare-database-replay.mjs" "$dumpfile" "$stage")"; then
    return 1
  fi
  run_psql -v ON_ERROR_STOP=1 --single-transaction < "$replay"

  log "Import complete"
)

# Do not snapshot and change mode while PortOS can still accept writes.
# A process-list probe is not a writer fence. The recoverable coordinator in
# #8805 must own admission, explicit endpoints and verified restart first.
cmd_migrate() {
  err "Database migration and switching are temporarily unavailable: coordinated shutdown and restart are required to preserve writes." >&2
  echo "Keep using the current backend. Backups remain available via scripts/db.sh export." >&2
  return 1
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
    # Homebrew pg logs
    local logfile=""
    if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      logfile="$(brew --prefix)/var/log/postgresql@17.log"
    fi
    if [ -n "$logfile" ] && [ -f "$logfile" ]; then
      tail -f "$logfile"
    else
      warn "No log file found. Check: brew services info postgresql@17"
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

  setup-native   Detect/install PostgreSQL, create portos database
  use-docker     Unavailable pending coordinated offline cutover
  use-native     Unavailable pending coordinated offline cutover

  migrate        Unavailable pending coordinated offline cutover
  export [label] Export database to data/db-dumps/
  import <file>  Import a SQL dump file
  export --endpoint <host> <port> <user> <database> [label]
  import --endpoint <host> <port> <user> <database> <file>
                Use host PostgreSQL tools at this exact endpoint (no Docker fallback)

Environment:
  PGMODE=docker|native   Set in .env to control default mode
  PGPORT=5432            PostgreSQL port (native=5432, docker=5561)
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
  use-docker)   cmd_migrate ;;
  use-native)   cmd_migrate ;;
  migrate)      cmd_migrate ;;
  export|import) action="$1"; shift; cmd_transfer "$action" "$@" ;;
  logs)         cmd_logs ;;
  help|--help|-h) cmd_help ;;
  *)            err "Unknown command: $1"; cmd_help; exit 1 ;;
esac
