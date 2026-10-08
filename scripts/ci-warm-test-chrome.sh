#!/usr/bin/env bash
# Reads the runner's Chrome install into the page cache before the DB suites
# start, within a bounded wall-clock budget, and reports how long that took.
#
# Why (#9641): the recurring "Test Chrome did not start within 20000ms" failures
# captured the owned child in uninterruptible sleep with its lead thread waiting
# on a page-cache folio (leadWait=page) while the runner's I/O pressure
# (ioAvg10) was above 50, and no DevToolsActivePort yet. That is the first,
# cold read of a ~300MB browser tree on a fresh runner that has just written
# ~95 ffmpeg packages and PostgreSQL data. Reading the tree here moves that cost
# out of the 20s startup deadline, which stays unchanged. This is not a retry
# and not a skip; the tests still launch, and must start, the real browser.
#
# The reported duration is also the evidence: a long warm read confirms the
# cold page-in mechanism, a short one on a failing run refutes it.
#
# Never fails the job: a missing browser is reported by the suites themselves
# (PORTOS_REQUIRE_BROWSER_SUITES), and the warm read is only an optimisation.
# CHROME_WARM_BUDGET_SECONDS and CHROME_WARM_CANDIDATES exist for the contract
# test and for runners with a different layout.
set -uo pipefail

BUDGET="${CHROME_WARM_BUDGET_SECONDS:-90}"
read -r -a CANDIDATES <<< "${CHROME_WARM_CANDIDATES:-${CHROME_PATH:-} /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser}"

# GNU timeout exists on the Ubuntu runner; elsewhere (a developer's macOS) the
# read simply runs unbounded, which is still a bounded local directory.
TIMEOUT=()
if command -v timeout >/dev/null 2>&1; then TIMEOUT=(timeout --kill-after=5 "$BUDGET"); fi

for candidate in "${CANDIDATES[@]}"; do
  [ -n "$candidate" ] && [ -e "$candidate" ] || continue
  executable="$(readlink -f "$candidate")"
  # The install directory holds the binary, its resources and its libraries.
  tree="$(dirname "$executable")"
  start="$(date +%s%N)"
  # cat's exit code is lost behind the pipe, so the byte count is the signal
  # that the read finished and the timeout's 124 is the signal that it did not.
  total="$(mktemp)"
  ${TIMEOUT[@]+"${TIMEOUT[@]}"} bash -c 'find "$1" -type f -print0 | xargs -0 cat 2>/dev/null | wc -c > "$2"' _ "$tree" "$total" 2>/dev/null
  status=$?
  bytes="$(tr -d '[:space:]' < "$total")"
  rm -f "$total"
  elapsed_ms=$(( ($(date +%s%N) - start) / 1000000 ))
  if [ "$status" -eq 0 ] && [ "${bytes:-0}" -gt 0 ]; then
    echo "🔥 Warmed the Chrome install into the page cache: $(( bytes / 1048576 )) MiB in ${elapsed_ms}ms"
  else
    echo "::warning title=Chrome warm-up incomplete::Read ${bytes:-0} bytes in ${elapsed_ms}ms (exit ${status}, budget ${BUDGET}s); the suites will launch the browser cold."
  fi
  exit 0
done

echo "::notice title=Chrome warm-up skipped::No Chrome install was found to warm; the browser suites report a missing browser themselves."
exit 0
