# Sourced by setup-native for the PostgreSQL 17 Homebrew keg.

# Map supported Homebrew pgvector releases to pinned upstream commit SHAs so
# source builds never compile an unverified mutable remote tag.
pinned_pgvector_commit() {
  case "$1" in
    0.7.0) echo "3849f0fd3d6f7916de26d43e3a3c9f8e6615bc8f" ;;
    0.7.1) echo "0eceaa39662bdcf00925995816f4c176e6be3fec" ;;
    0.7.2) echo "9b89bed70191283585a8ca2753ad08dac38608ef" ;;
    0.7.3) echo "4733cf253b4eff5cc492998b29f099bb304e85a7" ;;
    0.7.4) echo "103ac50f1a90b47a72003e8e8628a55ec372f202" ;;
    0.8.0) echo "2627c5ff775ae6d7aef0c430121ccf857842d2f2" ;;
    0.8.1) echo "778dacf20c07caf904557a88705142631818d8cb" ;;
    0.8.2) echo "cab9da72c04353f143bb06b42ab70a403daac64a" ;;
    0.8.3) echo "586e7515bafe6912c425164d186d56550657c349" ;;
    0.8.4) echo "1d458ad5d73731241e8b912cacc2079beb643d30" ;;
    0.8.5) echo "159b79aaad5983fb7459c1e3df2897fbb2d11788" ;;
    0.8.6) echo "8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c" ;;
    0.8.7) echo "f37c13f68b57d2c3472b2214fbcff699d6d34876" ;;
    *) return 1 ;;
  esac
}

# Homebrew's pgvector bottle only ships builds for the newest PostgreSQL
# majors. A `brew upgrade` can move it past postgresql@17 and unlink the old
# vector library, leaving the running server failing every vector query with
# `could not access file "$libdir/vector"`. When the pg17 keg has no vector
# library, build the same pgvector release from source against that keg.
# `make install` writes real files into the keg's shared lib/extension dirs,
# which later pgvector upgrades (symlink-only) leave alone.
ensure_pgvector_for_pg17() {
  local pg_config pkglibdir version pinned_sha
  pg_config="$(brew --prefix postgresql@17)/bin/pg_config"
  pkglibdir="$("$pg_config" --pkglibdir)"
  if [ -e "$pkglibdir/vector.dylib" ] || [ -e "$pkglibdir/vector.so" ]; then
    log "pgvector library present for PostgreSQL 17"
    return 0
  fi
  version="$(brew list --versions pgvector | awk 'NF >= 2 {v=$NF} END {print v}' | sed 's/_.*//')"
  if [ -z "$version" ]; then
    err "Cannot determine the installed Homebrew pgvector version; run: brew reinstall pgvector"
    exit 1
  fi
  if ! pinned_sha="$(pinned_pgvector_commit "$version")" || [ -z "$pinned_sha" ]; then
    err "Homebrew's pgvector $version has no pinned commit SHA in scripts/lib/dbPgvector.sh (pinned_pgvector_commit); add its verified commit SHA before building from source"
    exit 1
  fi
  warn "Homebrew's pgvector $version has no PostgreSQL 17 library in $pkglibdir; building pinned commit $pinned_sha from source"
  # Subshell so the EXIT trap removes the build dir on any exit path without
  # clobbering the caller's traps.
  (
    build_dir="$(mktemp -d "${TMPDIR:-/tmp}/portos-pgvector.XXXXXX")" || exit 1
    trap 'rm -rf "$build_dir"' EXIT
    src_dir="$build_dir/pgvector"
    if ! git init --quiet "$src_dir" ||
       ! git -C "$src_dir" remote add origin https://github.com/pgvector/pgvector.git ||
       ! git -C "$src_dir" fetch --quiet --depth 1 origin "$pinned_sha" ||
       ! git -C "$src_dir" checkout --quiet FETCH_HEAD; then
      err "Could not fetch pinned pgvector $version commit $pinned_sha (needs git and network access)"
      exit 1
    fi
    if ! actual_sha="$(git -C "$src_dir" rev-parse HEAD)" || [ "$actual_sha" != "$pinned_sha" ]; then
      err "pgvector $version commit verification failed: expected $pinned_sha, got ${actual_sha:-unknown}"
      exit 1
    fi
    if ! make -C "$src_dir" PG_CONFIG="$pg_config" >/dev/null ||
       ! make -C "$src_dir" PG_CONFIG="$pg_config" install >/dev/null; then
      err "Could not build pgvector for PostgreSQL 17 (needs git and the Xcode command line tools)"
      exit 1
    fi
  ) || exit 1
  log "pgvector ${version} built and installed for PostgreSQL 17"
}
