#!/usr/bin/env bash
# Installs ffmpeg and, for DB jobs, the service-major PostgreSQL client on a
# GitHub-hosted Ubuntu runner within a bounded network budget.
#
# apt's own retries and timeouts cannot bound a connection that trickles bytes,
# and a slow runner mirror has eaten the whole step before (#10369, #10562).
# So the download phase runs under a wall-clock budget: the runner's mirror gets
# APT_PRIMARY_BUDGET_SECONDS, then the Ubuntu sources are pointed at the
# official archive and the download resumes (finished .debs stay cached) until
# APT_TOTAL_BUDGET_SECONDS. Repository signing is untouched — only the mirror
# URI changes, so apt still verifies every Release file against its keyring.
# Installation then runs from the local cache with --no-download.
#
# APT_ROOT exists only so the contract test can run this against a fake tree.
set -euo pipefail

INCLUDE_POSTGRES="${INCLUDE_POSTGRES-true}"
ROOT="${APT_ROOT:-}"
PRIMARY_BUDGET="${APT_PRIMARY_BUDGET_SECONDS:-45}"
TOTAL_BUDGET="${APT_TOTAL_BUDGET_SECONDS:-390}"
# The HTTP archive can trickle while the same index is reachable over HTTPS.
OFFICIAL_ARCHIVE='https://archive.ubuntu.com/ubuntu/'
# The runner's Azure mirror, by URL or through its mirror list.
RUNNER_MIRROR='(mirror\+file:/etc/apt/apt-mirrors\.txt|https?://[a-z0-9.-]+\.archive\.ubuntu\.com/ubuntu/?)'
PACKAGES=(ffmpeg)
case "$INCLUDE_POSTGRES" in
  true)
    : "${PG_MAJOR:?PG_MAJOR must name the PostgreSQL service major}"
    PACKAGES=("postgresql-client-${PG_MAJOR}" ffmpeg)
    ;;
  false) ;;
  *) echo "INCLUDE_POSTGRES must be true or false" >&2; exit 1 ;;
esac
APT_OPTS=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Languages=none)
APT_INSTALL_OPTS=(install -y --no-install-recommends)
APT_SOURCE_OPTS=()
APT_SOURCEPARTS_DIR=''
cleanup() {
  if [[ -n "$APT_SOURCEPARTS_DIR" ]]; then
    rm -rf "$APT_SOURCEPARTS_DIR"
  fi
}
trap cleanup EXIT

if [[ "$INCLUDE_POSTGRES" == false ]]; then
  # Browser jobs only need ffmpeg from Ubuntu system repos; omit unrelated
  # third-party runner repos (e.g. packages.microsoft.com) so apt-get update
  # does not spend budget downloading their indexes. Symlink so mirror fallback
  # edits to ubuntu.sources take effect immediately.
  APT_SOURCEPARTS_DIR=$(mktemp -d)
  chmod 755 "$APT_SOURCEPARTS_DIR"
  shopt -s nullglob
  for src in "${ROOT}/etc/apt/sources.list.d/"ubuntu*.sources "${ROOT}/etc/apt/sources.list.d/"ubuntu*.list; do
    [[ -f "$src" ]] || continue
    src_dir=$(cd "$(dirname "$src")" && pwd)
    ln -s "${src_dir}/$(basename "$src")" "${APT_SOURCEPARTS_DIR}/$(basename "$src")"
  done
  shopt -u nullglob
  APT_SOURCE_OPTS=(-o "Dir::Etc::sourceparts=${APT_SOURCEPARTS_DIR}")
  APT_OPTS+=("${APT_SOURCE_OPTS[@]}")
fi
ARCHIVES="${ROOT}/var/cache/apt/archives"

fail() {
  echo "::error title=CI tool installation failed::$1 No test ran; this is an installation failure, not a test failure." >&2
  exit 1
}

# Runs a command with whatever remains of the budget ending at second $1.
bounded() {
  local remaining=$(( $1 - SECONDS ))
  shift
  (( remaining > 0 )) || return 124
  timeout --kill-after=10 "$remaining" "$@"
}

# apt accepts an existing archive by size alone. Only import restored downloads
# whose SHA256 matches the current signed index, never cached indexes or state.
restore_archives() {
  [[ -n "${APT_PACKAGE_CACHE:-}" ]] || return 0
  local manifest _uri filename _size hash result
  local checksums=() verified=()
  manifest=$(bounded "$1" sudo apt-get "${APT_OPTS[@]}" \
    -o "Dir::Cache::archives=${ARCHIVES}/verify-empty" -o Acquire::ForceHash=sha256 \
    --print-uris "${APT_INSTALL_OPTS[@]}" "${PACKAGES[@]}") || return
  while read -r _uri filename _size hash; do
    [[ "$hash" =~ ^SHA256:[a-fA-F0-9]{64}$ && "$filename" =~ ^[a-zA-Z0-9][a-zA-Z0-9.+_~%:-]*\.deb$ ]] || continue
    [[ -f "${APT_PACKAGE_CACHE}/${filename}" ]] || continue
    checksums+=("${hash#SHA256:}  ${filename}")
  done <<< "$manifest"
  (( ${#checksums[@]} > 0 )) || return 0

  # A mismatch makes sha256sum exit nonzero but leaves the other results usable.
  while IFS= read -r result; do
    case "$result" in
      *': OK')
        filename=${result%: OK}
        verified+=("${APT_PACKAGE_CACHE}/${filename}")
        echo "♻️ Reused verified APT package ${filename}"
        ;;
      *': FAILED'*)
        echo "♻️ Ignoring invalid cached APT package ${result%%: FAILED*}; APT will download it again"
        ;;
    esac
  done < <(cd "$APT_PACKAGE_CACHE" && printf '%s\n' "${checksums[@]}" | LC_ALL=C sha256sum --check 2>/dev/null)
  (( ${#verified[@]} > 0 )) || return 0
  sudo install -d "$ARCHIVES" &&
    sudo install -m 644 -t "$ARCHIVES" -- "${verified[@]}"
}

download_by() {
  bounded "$1" sudo apt-get "${APT_OPTS[@]}" update &&
    restore_archives "$1" &&
    bounded "$1" sudo apt-get "${APT_OPTS[@]}" "${APT_INSTALL_OPTS[@]}" --download-only "${PACKAGES[@]}"
}

if [[ "$INCLUDE_POSTGRES" == true ]]; then
  # Ubuntu's default repository only supplies its bundled PostgreSQL major.
  # Use PostgreSQL's signed repository for the service's major.
  keyring="${ROOT}/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc"
  sudo install -d "$(dirname "$keyring")"
  # Retry connection stalls; --retry-max-time caps the total so the apt budgets below still hold.
  sudo curl --fail --silent --show-error --connect-timeout 15 --max-time 30 --retry 4 --retry-all-errors --retry-delay 3 --retry-max-time 100 -o "$keyring" https://www.postgresql.org/media/keys/ACCC4CF8.asc
  # shellcheck source=/dev/null
  . "${ROOT}/etc/os-release"
  echo "deb [signed-by=${keyring#"$ROOT"}] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" |
    sudo tee "${ROOT}/etc/apt/sources.list.d/pgdg.list" >/dev/null
fi

if ! download_by "$PRIMARY_BUDGET"; then
  echo "⚠️ Runner mirror did not deliver packages within ${PRIMARY_BUDGET}s; switching to ${OFFICIAL_ARCHIVE}"
  sources=()
  while IFS= read -r source; do
    sources+=("$source")
  done < <(grep -lE "$RUNNER_MIRROR" "${ROOT}/etc/apt/sources.list" "${ROOT}/etc/apt/sources.list.d/"*.sources 2>/dev/null || true)
  (( ${#sources[@]} > 0 )) || fail "The runner mirror was slow and no Ubuntu source names it, so there is no mirror to replace."
  sudo sed -i -E "s#${RUNNER_MIRROR}#${OFFICIAL_ARCHIVE}#g" "${sources[@]}"
  download_by "$TOTAL_BUDGET" ||
    fail "Packages did not download from the runner mirror or ${OFFICIAL_ARCHIVE} within ${TOTAL_BUDGET}s."
fi

# A disposable runner doesn't need a kernel/service restart scan after installing test tools.
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 \
  apt-get ${APT_SOURCE_OPTS[@]+"${APT_SOURCE_OPTS[@]}"} -o APT::Keep-Downloaded-Packages=true \
  -o Dpkg::Options::=--force-unsafe-io "${APT_INSTALL_OPTS[@]}" --no-download "${PACKAGES[@]}" ||
  fail "Downloaded packages did not install."
if [[ -n "${APT_PACKAGE_CACHE:-}" ]]; then
  mkdir -p "$APT_PACKAGE_CACHE"
  # Only completed .debs enter the Actions cache, never partial downloads/locks.
  for archive in "$ARCHIVES/"*.deb; do
    [[ -f "$archive" ]] || continue
    install -m 644 "$archive" "$APT_PACKAGE_CACHE/"
  done
fi
if [[ "$INCLUDE_POSTGRES" == true ]]; then
  echo "/usr/lib/postgresql/${PG_MAJOR}/bin" >> "$GITHUB_PATH"
fi
echo "✅ Installed ${PACKAGES[*]} in ${SECONDS}s"
