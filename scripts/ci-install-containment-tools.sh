#!/usr/bin/env bash
# Installs bubblewrap before running the native Linux containment contract.
# Ubuntu indexes can briefly fail DNS resolution on hosted workers. Retry that
# specific acquisition failure once; all other install and test failures stay
# visible and fail closed.
set -euo pipefail

if (( $# == 0 )); then
  echo 'Usage: ci-install-containment-tools.sh <containment-test-command> [args...]' >&2
  exit 2
fi

APT_UPDATE_TIMEOUT_SECONDS="${APT_UPDATE_TIMEOUT_SECONDS:-120}"
APT_INSTALL_TIMEOUT_SECONDS="${APT_INSTALL_TIMEOUT_SECONDS:-120}"
log_dir="$(mktemp -d)"
trap 'rm -rf "$log_dir"' EXIT

apt_update() {
  local attempt="$1"
  local output="$log_dir/apt-update-$attempt.log"
  echo "APT index update attempt ${attempt}/2"
  if sudo timeout --kill-after=5 "$APT_UPDATE_TIMEOUT_SECONDS" apt-get \
    -o APT::Update::Error-Mode=any update -qq 2>&1 | tee "$output"; then
    return 0
  fi
  return 1
}

if ! apt_update 1; then
  if ! grep -Eiq 'Temporary failure resolving|Could not resolve' "$log_dir/apt-update-1.log"; then
    echo '::error title=Containment prerequisite unavailable::APT index update failed without a temporary DNS resolution error; no containment test ran.' >&2
    exit 1
  fi
  echo 'Temporary Ubuntu mirror DNS failure; retrying APT index update once.'
  if ! apt_update 2; then
    echo '::error title=Containment prerequisite unavailable::APT index update still failed after one temporary-DNS recovery attempt; no containment test ran.' >&2
    exit 1
  fi
fi

if ! sudo timeout --kill-after=5 "$APT_INSTALL_TIMEOUT_SECONDS" apt-get install -y bubblewrap; then
  echo '::error title=Containment prerequisite unavailable::bubblewrap installation failed; no containment test ran.' >&2
  exit 1
fi

if [[ "$(dpkg-query --show --showformat='${Status}' bubblewrap 2>/dev/null)" != 'install ok installed' ]]; then
  echo '::error title=Containment prerequisite unavailable::APT completed but dpkg does not report bubblewrap installed; no containment test ran.' >&2
  exit 1
fi

if ! command -v bwrap >/dev/null 2>&1 || ! bwrap --version >/dev/null 2>&1; then
  echo '::error title=Containment prerequisite unavailable::APT completed but bubblewrap is not available; no containment test ran.' >&2
  exit 1
fi

"$@"
