#!/usr/bin/env bash
# Shared by setup:llm and the server's Linux install/upgrade actions.
set -euo pipefail

if ! command -v zstd >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    install=(apt-get install -y zstd)
  elif command -v dnf >/dev/null 2>&1; then
    install=(dnf install -y zstd)
  elif command -v yum >/dev/null 2>&1; then
    install=(yum install -y zstd)
  elif command -v pacman >/dev/null 2>&1; then
    install=(pacman -S --noconfirm zstd)
  else
    echo 'Ollama requires zstd. Install zstd with your package manager, then retry.' >&2
    exit 1
  fi

  echo 'Installing zstd, required to extract Ollama…'
  # Server installs have no terminal for a password prompt. Fail with a usable
  # command before the upstream installer can remove the existing version.
  install_command=("${install[@]}")
  if [ "$(id -u)" != 0 ]; then
    install_command=(sudo -n "${install[@]}")
  fi
  if ! "${install_command[@]}"; then
    echo "Could not install zstd automatically. Run: sudo ${install[*]}, then retry Ollama." >&2
    exit 1
  fi
  if ! command -v zstd >/dev/null 2>&1; then
    echo 'zstd is still missing from PATH after installation. Make zstd available, then retry Ollama.' >&2
    exit 1
  fi
fi

# pipefail also reports download failures instead of treating an empty sh as success.
curl -fsSL https://ollama.com/install.sh | sh
