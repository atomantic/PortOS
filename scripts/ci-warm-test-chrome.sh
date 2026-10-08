#!/usr/bin/env bash
# Reads the runner's Chrome install into the page cache before the DB suites
# start, within a bounded wall-clock budget, and reports how long that took.
#
# Why (#9641): the recurring "Test Chrome did not start within 20000ms" failures
# captured the owned child in uninterruptible sleep with its lead thread waiting
# on a page-cache folio (leadWait=page) while the runner's I/O pressure
# (ioAvg10) was above 50, and no DevToolsActivePort yet. These samples suggest
# a cold read of the browser tree on a fresh runner that has just written
# ~95 ffmpeg packages and PostgreSQL data. Reading the tree here moves that cost
# out of the 20s startup deadline, which stays unchanged. This is not a retry
# and not a skip; the tests still launch, and must start, the real browser.
#
# Duration is supporting evidence for the cold-read hypothesis, not proof of
# the startup cause. A failed or partial read must never be reported as warmed;
# a passing launch after a completed read is still a non-reproduction.
#
# Never fails the job: a missing browser is reported by the suites themselves
# (PORTOS_REQUIRE_BROWSER_SUITES), and the warm read is only an optimisation.
# CHROME_WARM_BUDGET_SECONDS and CHROME_WARM_CANDIDATES exist for the contract
# test and for runners with a different layout.
set -uo pipefail

BUDGET="${CHROME_WARM_BUDGET_SECONDS:-90}"
read -r -a CANDIDATES <<< "${CHROME_WARM_CANDIDATES:-${CHROME_PATH:-} /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser}"

# Never replace the wall-clock budget with an unbounded read. GNU coreutils
# installs timeout as gtimeout on some developer machines.
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT=(timeout --kill-after=5 "$BUDGET")
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT=(gtimeout --kill-after=5 "$BUDGET")
else
  echo "::notice title=Chrome warm-up skipped::No deadline tool is available; the suites will launch the browser cold."
  exit 0
fi

# Milliseconds since the epoch. BSD date prints a literal N for %N, so fall back
# to whole seconds there rather than failing the arithmetic.
now_ms() {
  local ns
  ns="$(date +%s%N)"
  case "$ns" in
    *[!0-9]*) echo $(( $(date +%s) * 1000 )) ;;
    *) echo $(( ns / 1000000 )) ;;
  esac
}

for candidate in "${CANDIDATES[@]}"; do
  [ -n "$candidate" ] && [ -e "$candidate" ] || continue
  executable="$(readlink -f "$candidate" 2>/dev/null)" || {
    echo "::warning title=Chrome warm-up incomplete::Cannot resolve the browser install; the suites will launch the browser cold."
    exit 0
  }
  # The install directory holds the binary, its resources and its libraries.
  tree="$(dirname "$executable")"
  start="$(now_ms)"
  total="$(mktemp 2>/dev/null)" || {
    echo "::warning title=Chrome warm-up incomplete::Cannot allocate a byte-count file; the suites will launch the browser cold."
    exit 0
  }
  # pipefail must be enabled in the child shell too: wc can count partial
  # output successfully even when find or cat failed. Keep all raw errors
  # private, and report only byte count, duration and pipeline/deadline status.
  "${TIMEOUT[@]}" bash -o pipefail -c 'find "$1" -type f -print0 | xargs -0 cat 2>/dev/null | wc -c > "$2"' _ "$tree" "$total" 2>/dev/null
  status=$?
  bytes="$(tr -d '[:space:]' < "$total")"
  rm -f "$total"
  elapsed_ms=$(( $(now_ms) - start ))
  if [ "$status" -eq 0 ] && [ "${bytes:-0}" -gt 0 ]; then
    echo "🔥 Warmed the Chrome install into the page cache: $(( bytes / 1048576 )) MiB in ${elapsed_ms}ms"
  else
    echo "::warning title=Chrome warm-up incomplete::Read ${bytes:-0} bytes in ${elapsed_ms}ms (exit ${status}, budget ${BUDGET}s); the suites will launch the browser cold."
  fi
  exit 0
done

echo "::notice title=Chrome warm-up skipped::No Chrome install was found to warm; the browser suites report a missing browser themselves."
exit 0
