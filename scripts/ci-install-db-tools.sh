#!/usr/bin/env bash
# Installs the DB job's PostgreSQL client (matching the service's major) and
# ffmpeg on a GitHub-hosted Ubuntu runner, within a bounded network budget.
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

: "${PG_MAJOR:?PG_MAJOR must name the PostgreSQL service major}"
ROOT="${APT_ROOT:-}"
PRIMARY_BUDGET="${APT_PRIMARY_BUDGET_SECONDS:-180}"
TOTAL_BUDGET="${APT_TOTAL_BUDGET_SECONDS:-390}"
OFFICIAL_ARCHIVE='http://archive.ubuntu.com/ubuntu/'
# The runner's Azure mirror, by URL or through its mirror list.
RUNNER_MIRROR='(mirror\+file:/etc/apt/apt-mirrors\.txt|https?://[a-z0-9.-]+\.archive\.ubuntu\.com/ubuntu/?)'
PACKAGES=("postgresql-client-${PG_MAJOR}" ffmpeg)
APT_OPTS=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)

fail() {
  echo "::error title=DB tool installation failed::$1 No test ran; this is an installation failure, not a test failure." >&2
  exit 1
}

# Runs a command with whatever remains of the budget ending at second $1.
bounded() {
  local remaining=$(( $1 - SECONDS ))
  shift
  (( remaining > 0 )) || return 124
  timeout --kill-after=10 "$remaining" "$@"
}

download_by() {
  bounded "$1" sudo apt-get "${APT_OPTS[@]}" update &&
    bounded "$1" sudo apt-get "${APT_OPTS[@]}" install -y --download-only "${PACKAGES[@]}"
}

# Ubuntu's default repository only supplies its bundled PostgreSQL major.
# Use PostgreSQL's signed repository for the service's major.
keyring="${ROOT}/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc"
sudo install -d "$(dirname "$keyring")"
sudo curl --fail --silent --show-error --max-time 60 -o "$keyring" https://www.postgresql.org/media/keys/ACCC4CF8.asc
# shellcheck source=/dev/null
. "${ROOT}/etc/os-release"
echo "deb [signed-by=${keyring#"$ROOT"}] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" |
  sudo tee "${ROOT}/etc/apt/sources.list.d/pgdg.list" >/dev/null

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

sudo apt-get install -y --no-download "${PACKAGES[@]}" || fail "Downloaded packages did not install."
echo "/usr/lib/postgresql/${PG_MAJOR}/bin" >> "$GITHUB_PATH"
echo "✅ Installed ${PACKAGES[*]} in ${SECONDS}s"
