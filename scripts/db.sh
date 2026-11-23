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
#   use-docker   Legacy command. Use Settings → Database
#   use-native   Legacy command. Use Settings → Database
#   migrate      Legacy command. Use Settings → Database
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
const { resolveDatabaseSettings, parsePort } = require(join(process.argv[2], 'scripts/lib/databaseSettings.cjs'));
const resolved = resolveDatabaseSettings({ saved });
const nativeSetup = process.argv[3] === 'setup-native';
// Ordinary CLI commands retain an explicit exported endpoint override, even in
// Docker mode (offline maintenance uses this to address a selected cluster).
const selectedPort = nativeSetup ? resolved.selectedNativePort : parsePort(process.env.PGPORT);
const settings = {
  PGMODE: resolved.mode, PGUSER: resolved.user,
  PGDATABASE: resolved.database, PGPASSWORD: resolved.password,
  PGHOST: resolved.host, SELECTED_PGHOST: resolved.selectedHost,
  PGPORT: String(selectedPort ?? (nativeSetup ? resolved.nativePort : resolved.port)),
  SELECTED_PGPORT: selectedPort === undefined ? '' : String(selectedPort),
  PGPORT_DOCKER: String(resolved.dockerPort),
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
# Compose interpolates docker-compose.yml with its own .env grammar (inline
# comments, `$` expansion), which differs from the literal parser above. Process
# environment outranks Compose's .env, so exporting the resolved values makes
# every `docker compose` call below provision exactly what PortOS connects with.
# Exported to child environments only — never argv or logs.
export PGUSER PGDATABASE PGPASSWORD PGPORT_DOCKER
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

# Inherited libpq variables that choose WHERE a client connects or how the
# session behaves, independent of the -h/-p/-U/-d arguments: PGHOSTADDR
# overrides -h's network destination, PGSERVICE/PGSERVICEFILE can supply another
# endpoint, and PGOPTIONS alters session settings (search_path). Keep this list
# in step with ROUTING_ENV in scripts/setup-db.js. TLS and authentication
# variables (PGSSLMODE, PGSSLROOTCERT, PGPASSFILE, ...) are deliberately NOT
# listed: they are supported operator configuration, not endpoint identity.
PG_ROUTING_VARS="PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS"

# Run a host libpq client (psql, pg_dump, pg_isready) with those variables
# removed from ITS environment only; the operator's shell is untouched. Every
# call site passes the resolved host/port/user/database as explicit arguments.
pg_bound() (
  local name
  for name in $PG_ROUTING_VARS; do
    unset "$name"
  done
  "$@"
)

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
  if [ "$action" = import ] && [ "$EXPLICIT_ENDPOINT" = true ] && [ "$#" -eq 2 ] && [ "$1" = --cutover ]; then
    # pg_dump --clean only drops source objects. Replay the fixed retirement
    # even if the imported ledger already records it, in the same transaction.
    cmd_import "$2" -X -f - -f "$ROOT_DIR/server/scripts/db-migrations/030-drop-retired-native-usage-tables.sql"
    return
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
  PGPASSWORD="$PGPASSWORD" pg_bound pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1
}

# Auto-detect Homebrew PostgreSQL 17 on macOS and add to PATH
# Check both arm64 (/opt/homebrew) and Intel (/usr/local) prefixes
if [ "$(uname)" = "Darwin" ]; then
  # PORTOS_BREW_PG_PREFIXES lets tests keep a real Homebrew Postgres off PATH.
  for _prefix in ${PORTOS_BREW_PG_PREFIXES:-/opt/homebrew/opt/postgresql@17 /usr/local/opt/postgresql@17}; do
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
  if pg_bound pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
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
      if PGPASSWORD="$PGPASSWORD" pg_bound psql -h "$PGHOST" -p "$sys_port" -U "$PGUSER" -d "$PGDATABASE" -c "SELECT 1" >/dev/null 2>&1; then
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
    # -h 127.0.0.1 forces TCP: during first-time init the entrypoint runs a
    # socket-only temp server, so a default (socket) probe passes too early.
    # Also require the base schema (01-init.sql) so dependents don't race it.
    if docker compose exec -T db pg_isready -h 127.0.0.1 -U "$PGUSER" >/dev/null 2>&1 &&
       [ "$(docker compose exec -T db psql -X -h 127.0.0.1 -U "$PGUSER" -d "$PGDATABASE" -tAc "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'memories' LIMIT 1" 2>/dev/null | tr -d '[:space:]')" = "1" ]; then
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

# Run a command as root: directly when already root, else via non-interactive sudo.
linux_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

# Poll up to 15s for the native endpoint to accept connections.
wait_native_ready() {
  local i
  for i in $(seq 1 15); do
    if pg_bound pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
      log "Native PostgreSQL ready on port $PGPORT"
      return 0
    fi
    sleep 1
  done
  return 1
}

start_native() {
  info "Starting native PostgreSQL..."

  if ! has_native_pg; then
    err "Native PostgreSQL not installed. Run: scripts/db.sh setup-native"
    exit 1
  fi

  # Check if system PostgreSQL is already running and accepting connections
  if native_running; then
    log "Native PostgreSQL already running on port $PGPORT"
    return
  fi

  # Try to start via Homebrew services (macOS)
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    if brew services list 2>/dev/null | grep -q "postgresql@17"; then
      info "Starting PostgreSQL via Homebrew services..."
      brew services start postgresql@17 2>/dev/null || true
      for i in $(seq 1 15); do
        if pg_bound pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
          log "Native PostgreSQL ready on port $PGPORT"
          return
        fi
        sleep 1
      done
    fi
  fi

  # Linux servers: systemd unit first, then pg_ctl against an explicit PGDATA
  if [ "$(uname)" = "Linux" ]; then
    if command -v systemctl >/dev/null 2>&1; then
      info "Starting PostgreSQL via systemctl..."
      linux_privileged systemctl start postgresql 2>/dev/null || true
      wait_native_ready && return
    fi
    if [ -n "${PGDATA:-}" ] && [ -d "$PGDATA" ] && command -v pg_ctl >/dev/null 2>&1; then
      pg_ctl -D "$PGDATA" -l "$PGDATA/server.log" start 2>/dev/null || true
      wait_native_ready && return
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
      wait_native_ready && return
    fi
  fi

  if [ "$(uname)" = "Darwin" ]; then
    err "Could not start PostgreSQL. Try: brew services start postgresql@17"
  else
    err "Could not start PostgreSQL. Try: sudo systemctl start postgresql (or set PGDATA and use pg_ctl)"
  fi
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
  # Stopping an absent or already-stopped container exits 0, so a nonzero exit
  # is a genuine failure (daemon down, permissions) and must not read as success.
  if ! docker compose stop db; then
    err "Failed to stop Docker PostgreSQL"
    exit 1
  fi
  log "Stopped"
}

# True while the selected native endpoint still accepts connections.
native_accepting() {
  pg_bound pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1
}

stop_native() {
  info "Stopping native PostgreSQL..."
  local stop_failed=false
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew services stop postgresql@17 || stop_failed=true
    # A server started via pg_ctl (including start_native's fallback) is not a
    # brew service, so the stop above leaves it running.
    if native_accepting && command -v pg_ctl >/dev/null 2>&1; then
      local datadir
      for datadir in "$(brew --prefix)/var/postgresql@17" "$(brew --prefix)/var/postgres"; do
        if [ -d "$datadir" ]; then
          pg_ctl -D "$datadir" stop -m fast && stop_failed=false && break
          stop_failed=true
        fi
      done
    fi
  elif [ "$(uname)" = "Linux" ] && native_accepting; then
    if command -v systemctl >/dev/null 2>&1; then
      linux_privileged systemctl stop postgresql || stop_failed=true
    fi
    if native_accepting && [ -n "${PGDATA:-}" ] && [ -d "$PGDATA" ] && command -v pg_ctl >/dev/null 2>&1; then
      pg_ctl -D "$PGDATA" stop -m fast && stop_failed=false || stop_failed=true
    fi
  elif command -v pg_ctl >/dev/null 2>&1 && [ -n "${PGDATA:-}" ] && [ -d "$PGDATA" ]; then
    pg_ctl -D "$PGDATA" stop -m fast || stop_failed=true
  fi
  # Claim Stopped only once the endpoint stops answering. A failing stop command
  # against an endpoint that is already down stays an idempotent success.
  local tries=0
  while native_accepting && [ "$tries" -lt 8 ]; do
    sleep 0.25
    tries=$((tries + 1))
  done
  if native_accepting; then
    err "Native PostgreSQL is still accepting connections on port $PGPORT"
    exit 1
  fi
  if [ "$stop_failed" = true ]; then
    warn "Stop command failed, but nothing is listening on port $PGPORT"
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

  local container_id data_volume configured_volume running
  # Repair removes the container, so the next `compose up` must select the SAME
  # volume. A renamed checkout/project or changed volume override can otherwise
  # free the fixed container name and boot a new, empty database after repair.
  # Resolve Compose's canonical model before any stop/removal. Its full output
  # contains credentials: emit only a validated volume name, never parser errors.
  if ! configured_volume=$(docker compose config --format json 2>/dev/null | node -e '
    let input = "";
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const config = JSON.parse(input);
        const mounts = config.services?.db?.volumes;
        if (!Array.isArray(mounts)) process.exit(1);
        const matching = mounts.filter(v => v?.target === "/var/lib/postgresql/data");
        if (matching.length !== 1 || matching[0].type !== "volume") process.exit(1);
        const name = config.volumes?.[matching[0].source]?.name;
        if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_.-]*$/i.test(name)) process.exit(1);
        process.stdout.write(name);
      } catch { process.exit(1); }
    });
  '); then
    err "Could not resolve the configured database volume; repair stopped"
    return 1
  fi
  # A successful list distinguishes an absent container from an unavailable
  # daemon. Never turn a failed inspection into permission to modify its volume.
  if ! container_id=$(docker ps -aq --filter 'name=^/portos-db$'); then
    err "Could not establish the database container state; repair stopped"
    return 1
  fi
  if [ -n "$container_id" ]; then
    # Retain the actual volume before removing the container, not a guessed
    # Compose project name (which may have changed since it was provisioned).
    if ! data_volume=$(docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/var/lib/postgresql/data" }}{{ .Name }}{{ end }}{{ end }}' "$container_id"); then
      err "Could not resolve the database data volume; repair stopped"
      return 1
    fi
    if [ "$data_volume" != "$configured_volume" ]; then
      err "Database container volume differs from the configured Compose volume; repair stopped"
      info "Restore the original Compose project/volume configuration before retrying. The container and data are unchanged."
      return 1
    fi
    if ! docker compose stop db; then
      err "Failed to stop Docker PostgreSQL; repair stopped"
      return 1
    fi
    if ! running=$(docker inspect -f '{{.State.Running}}' "$container_id") || [ "$running" != false ]; then
      err "Database container is still running or its state is unknown; repair stopped"
      return 1
    fi
    # Do not force-remove a container that may have restarted since inspection.
    if ! docker rm "$container_id"; then
      err "Failed to remove the database container; repair stopped"
      return 1
    fi
  else
    # No container exists. Never try guessed names, which docker run would
    # silently create; the configured volume must already exist below.
    data_volume="$configured_volume"
  fi
  # Verify absence after removal too, including any concurrent restart.
  if ! container_id=$(docker ps -aq --filter 'name=^/portos-db$') || [ -n "$container_id" ]; then
    err "Database container absence could not be verified; repair stopped"
    return 1
  fi
  if [ -z "$data_volume" ] || ! docker volume inspect "$data_volume" >/dev/null; then
    err "Database data volume could not be verified; repair stopped"
    return 1
  fi

  # Remove stale postmaster.pid from the volume. Reuse the pinned, already-pulled
  # db image from docker-compose.yml (has rm/cat) so repair works offline.
  local PG_HELPER_IMAGE
  PG_HELPER_IMAGE=$(docker compose config --images db 2>/dev/null | head -1)
  [ -n "$PG_HELPER_IMAGE" ] || PG_HELPER_IMAGE=$(grep -m1 'image:.*pgvector' "$ROOT_DIR/docker-compose.yml" | awk '{print $2}')
  if [ -z "$PG_HELPER_IMAGE" ]; then
    warn "Could not resolve the db image from docker-compose.yml — cannot remove stale lock files"
    return 1
  fi
  if ! docker run --rm --pull=never -v "${data_volume}:/data" "$PG_HELPER_IMAGE" \
      sh -c 'rm -f /data/postmaster.pid && test ! -e /data/postmaster.pid'; then
    err "Failed to remove or verify the stale database lock; repair stopped"
    return 1
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
# Run one role statement as the system user without the password in argv.
# The statement arrives on stdin; psql reads the role name and password from
# the environment (\getenv, PostgreSQL 15+) and quotes them as an identifier
# (:"role") and a literal (:'pw'). The values are scoped to this one command and
# deliberately not PG* variables, so they never authenticate the connection.
provision_role() {
  local sys_user="$1" statement="$2"
  printf '%s\n%s\n%s\n' '\getenv role PORTOS_BOOTSTRAP_ROLE' '\getenv pw PORTOS_BOOTSTRAP_PASSWORD' "$statement" |
    PORTOS_BOOTSTRAP_ROLE="$PGUSER" PORTOS_BOOTSTRAP_PASSWORD="$PGPASSWORD" \
      pg_bound psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d postgres -v ON_ERROR_STOP=1 -X -q
}

# Exact-name existence probes (no substring/word matching: hyphenated sibling
# names such as portos-staging must not match portos). Names reach psql through
# \getenv and are quoted as literals (:'x'), never interpolated into SQL.
role_exists() {
  printf '%s\n%s\n' '\getenv role PORTOS_BOOTSTRAP_ROLE' "SELECT 1 FROM pg_roles WHERE rolname = :'role';" |
    PORTOS_BOOTSTRAP_ROLE="$PGUSER" pg_bound psql -h "$PGHOST" -p "$PGPORT" -U "$1" -d postgres -tA -X -q 2>/dev/null | grep -qx 1
}

database_exists() {
  printf '%s\n%s\n' '\getenv db PORTOS_BOOTSTRAP_DB' "SELECT 1 FROM pg_database WHERE datname = :'db';" |
    PORTOS_BOOTSTRAP_DB="$PGDATABASE" pg_bound psql -h "$PGHOST" -p "$PGPORT" -U "$1" -d postgres -tA -X -q 2>/dev/null | grep -qx 1
}

# Homebrew's pgvector bottle only ships builds for the newest PostgreSQL
# majors. A `brew upgrade` can move it past postgresql@17 and unlink the old
# vector library, leaving the running server failing every vector query with
# `could not access file "$libdir/vector"`. When the pg17 keg has no vector
# library, build the same pgvector release from source against that keg.
# `make install` writes real files into the keg's shared lib/extension dirs,
# which later pgvector upgrades (symlink-only) leave alone.
ensure_pgvector_for_pg17() {
  local pg_config pkglibdir version
  pg_config="$(brew --prefix postgresql@17)/bin/pg_config"
  pkglibdir="$("$pg_config" --pkglibdir)"
  if [ -e "$pkglibdir/vector.dylib" ] || [ -e "$pkglibdir/vector.so" ]; then
    log "pgvector library present for PostgreSQL 17"
    return 0
  fi
  version="$(brew list --versions pgvector | awk '{print $NF}' | sed 's/_.*//')"
  if [ -z "$version" ]; then
    err "Cannot determine the installed Homebrew pgvector version; run: brew reinstall pgvector"
    exit 1
  fi
  warn "Homebrew's pgvector $version has no PostgreSQL 17 library in $pkglibdir; building it from source"
  # Subshell so the EXIT trap removes the build dir on any exit path without
  # clobbering the caller's traps.
  (
    build_dir="$(mktemp -d)"
    trap 'rm -rf "$build_dir"' EXIT
    git clone --quiet --depth 1 --branch "v$version" https://github.com/pgvector/pgvector.git "$build_dir/pgvector" &&
      make -C "$build_dir/pgvector" PG_CONFIG="$pg_config" >/dev/null &&
      make -C "$build_dir/pgvector" PG_CONFIG="$pg_config" install >/dev/null
  ) || {
    err "Could not build pgvector for PostgreSQL 17 (needs git and the Xcode command line tools)"
    exit 1
  }
  log "pgvector ${version} built and installed for PostgreSQL 17"
}

# A `brew upgrade` swaps the postgresql@17 keg's binaries and libraries but
# leaves the old server process running, so new backends load the new
# libraries into the old binary and fail (`Symbol not found` in plpgsql, the
# rebuilt vector library). When the running server's minor version differs
# from the installed keg and Homebrew manages the service, restart it; when
# something else runs it, stop with the exact restart to do.
restart_stale_brew_pg17() {
  [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1 || return 0
  local running installed sys_user
  sys_user="$(whoami)"
  running="$(pg_bound psql -X -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d postgres -tAc 'SHOW server_version_num' 2>/dev/null | tr -d '[:space:]' || true)"
  installed="$("$(brew --prefix postgresql@17)/bin/pg_config" --version 2>/dev/null | sed -E 's/^[^0-9]*([0-9]+)\.([0-9]+).*/\1 \2/' | awk '{ printf "%d", $1 * 10000 + $2 }' || true)"
  case "$running" in ''|*[!0-9]*) return 0 ;; esac
  case "$installed" in ''|*[!0-9]*) return 0 ;; esac
  # Another major on this port is not the keg we manage.
  [ $((running / 10000)) -eq $((installed / 10000)) ] || return 0
  [ "$running" -ne "$installed" ] || return 0
  if brew services list 2>/dev/null | awk '$1 == "postgresql@17" { print $2 }' | grep -qx started; then
    warn "PostgreSQL server ($running) is older than the installed postgresql@17 ($installed) after a Homebrew upgrade; restarting it"
    brew services restart postgresql@17 >/dev/null || true
    local i
    for i in $(seq 1 30); do
      pg_bound pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1 && break
      sleep 1
    done
    running="$(pg_bound psql -X -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d postgres -tAc 'SHOW server_version_num' 2>/dev/null | tr -d '[:space:]' || true)"
    if [ "$running" = "$installed" ]; then
      log "PostgreSQL restarted on the installed version"
      return 0
    fi
    err "PostgreSQL did not come back on the installed version after a restart. Check: brew services list"
    exit 1
  fi
  err "PostgreSQL on port $PGPORT is running an older binary ($running) than the installed postgresql@17 ($installed). Restart that server, then re-run: npm run setup:db"
  exit 1
}

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
    ensure_pgvector_for_pg17

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
    if pg_bound pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
      log "PostgreSQL already running at $PGHOST:$PGPORT"
    elif [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      info "Starting PostgreSQL..."
      brew services start postgresql@17
      sleep 2
      if pg_bound pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
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

  restart_stale_brew_pg17

  # Step 3: Create portos user if it doesn't exist
  # Connect as the current system user (default Homebrew superuser) to create the role
  local sys_user
  sys_user="$(whoami)"
  if ! role_exists "$sys_user"; then
    info "Creating database user: $PGUSER"
    provision_role "$sys_user" 'CREATE ROLE :"role" WITH LOGIN PASSWORD :'"'"'pw'"'"' CREATEDB SUPERUSER;'
    log "User $PGUSER created"
  else
    log "User $PGUSER already exists"
    # Ensure password and superuser are set correctly (superuser needed for extension management)
    provision_role "$sys_user" 'ALTER USER :"role" WITH PASSWORD :'"'"'pw'"'"' SUPERUSER;' 2>/dev/null || true
  fi

  # Step 4: Create portos database if it doesn't exist
  if ! database_exists "$sys_user"; then
    info "Creating database: $PGDATABASE"
    printf '%s\n%s\n%s\n' '\getenv db PORTOS_BOOTSTRAP_DB' '\getenv role PORTOS_BOOTSTRAP_ROLE' 'CREATE DATABASE :"db" OWNER :"role";' |
      PORTOS_BOOTSTRAP_DB="$PGDATABASE" PORTOS_BOOTSTRAP_ROLE="$PGUSER" \
        pg_bound psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d postgres -v ON_ERROR_STOP=1 -X -q
    log "Database $PGDATABASE created"
  else
    log "Database $PGDATABASE already exists"
  fi

  # Step 5: Enable pgvector extension and apply schema
  info "Applying schema..."
  # pgvector extension requires superuser — create as system user, then run schema as portos
  pg_bound psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d "$PGDATABASE" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || true
  pg_bound psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d "$PGDATABASE" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>/dev/null || true
  PGPASSWORD="$PGPASSWORD" pg_bound psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 --single-transaction -f "$ROOT_DIR/server/scripts/init-db.sql"
  log "Schema applied"

  echo ""
  log "Native PostgreSQL is ready!"
  info "Using system PostgreSQL on port $PGPORT"
  info "Database: $PGDATABASE (user: $PGUSER)"
  info "Provisioning only: the selected mode is unchanged; Docker data has not been migrated."
  info "To move existing data, use Settings → Database for a coordinated cutover."
}

# Scope inherited libpq settings out of explicit transfers. PGHOSTADDR takes
# precedence over -h's network destination, PGSERVICE can supply another
# endpoint, and PGOPTIONS can redirect statements (search_path). Only the
# password crosses; every connection parameter is an explicit argument.
run_explicit_pg() {
  local binary="$1" host="$PGHOST" port="$PGPORT" user="$PGUSER" database="$PGDATABASE" password="$PGPASSWORD"
  shift
  local name
  for name in $(compgen -e); do
    case "$name" in PG*) unset "$name" ;; esac
  done
  PGPASSWORD="$password" exec "$binary" -h "$host" -p "$port" -U "$user" -d "$database" "$@"
}

# Admission uses the same host client and credentials as import. Replacing the
# probe shell lets the caller's timeout terminate psql itself.
cmd_probe_target() {
  [ "${1:-}" = "--endpoint" ] || return 1
  shift
  set_explicit_endpoint "$@" || return 1
  run_explicit_pg psql -X -w -At -v ON_ERROR_STOP=1 -c \
    "SELECT pg_catalog.current_setting('transaction_read_only') = 'off'
      AND pg_catalog.has_schema_privilege('public', 'USAGE')
      AND pg_catalog.has_schema_privilege('public', 'CREATE')"
}

# Run psql command, using Docker exec in Docker mode if host psql is unavailable
run_psql() {
  if [ "$EXPLICIT_ENDPOINT" = true ]; then
    # Never fall back to container-local psql: that is a different endpoint.
    (run_explicit_pg psql "$@")
    return $?
  fi
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$PGPASSWORD" pg_bound psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "$@"
  elif uses_local_docker_endpoint && docker_running; then
    PGPASSWORD="$PGPASSWORD" docker exec -i -e PGPASSWORD portos-db psql -U "$PGUSER" -d "$PGDATABASE" "$@"
  else
    err "psql not found on host and Docker DB is not running"
    exit 1
  fi
}

# Run pg_dump, preferring Docker exec in Docker mode to avoid version mismatch
run_pg_dump() {
  if [ "$EXPLICIT_ENDPOINT" = true ]; then
    (run_explicit_pg pg_dump "$@")
    return $?
  fi
  if uses_local_docker_endpoint && docker_running; then
    PGPASSWORD="$PGPASSWORD" docker exec -e PGPASSWORD portos-db pg_dump -U "$PGUSER" -d "$PGDATABASE" "$@"
  elif command -v pg_dump >/dev/null 2>&1; then
    PGPASSWORD="$PGPASSWORD" pg_bound pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "$@"
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
  shift

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
  run_psql -v ON_ERROR_STOP=1 --single-transaction "$@" < "$replay" || return $?

  log "Import complete"
)

# Do not snapshot and change mode while PortOS can still accept writes.
# The coordinator behind Settings → Database fences writers and verifies restart.
cmd_migrate() {
  err "This command refuses direct database migration or switching. Use Settings → Database for a coordinated cutover." >&2
  echo "Backups remain available via scripts/db.sh export." >&2
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
  use-docker     Legacy command. Use Settings → Database
  use-native     Legacy command. Use Settings → Database

  migrate        Legacy command. Use Settings → Database
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
  probe-target) shift; cmd_probe_target "$@" ;;
  logs)         cmd_logs ;;
  help|--help|-h) cmd_help ;;
  *)            err "Unknown command: $1"; cmd_help; exit 1 ;;
esac
