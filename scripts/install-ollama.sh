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

# Install from GitHub release assets, never a piped remote shell script from a mutable
# endpoint: the archive is SHA-256 verified against the release's sha256sum.txt
# before anything is extracted or any system directory is touched.
# OLLAMA_VERSION pins a release tag (e.g. v0.12.0); default is the latest.
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m). Install Ollama manually." >&2; exit 1 ;;
esac

asset="ollama-linux-${arch}.tar.zst"
if [ -n "${OLLAMA_VERSION:-}" ]; then
  base="https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}"
else
  base='https://github.com/ollama/ollama/releases/latest/download'
fi

# Pick the destination before downloading: /usr/local as root or with
# passwordless sudo (server installs have no terminal), else ~/.local.
sudo_cmd=()
if [ -n "${OLLAMA_INSTALL_PREFIX:-}" ]; then
  prefix="$OLLAMA_INSTALL_PREFIX"
elif [ "$(id -u)" = 0 ]; then
  prefix=/usr/local
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  prefix=/usr/local
  sudo_cmd=(sudo -n)
else
  prefix="${HOME:?HOME must be set for a user-level Ollama install}/.local"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Downloading ${asset}…"
curl -fsSL -o "$work/$asset" "$base/$asset"
curl -fsSL -o "$work/sha256sum.txt" "$base/sha256sum.txt"

expected="$(grep -E "[[:space:]]\*?(\./)?${asset}\$" "$work/sha256sum.txt" | head -n 1 || true)"
if [ -z "$expected" ]; then
  echo "sha256sum.txt has no entry for ${asset}; refusing to install." >&2
  exit 1
fi
printf '%s\n' "${expected%%[[:space:]]*}  ${asset}" > "$work/expected.sha256"
if ! (cd "$work" && sha256sum --check --status expected.sha256); then
  echo "SHA-256 mismatch for ${asset}; refusing to install." >&2
  exit 1
fi

echo "Installing Ollama into ${prefix}…"
${sudo_cmd[@]+"${sudo_cmd[@]}"} mkdir -p "$prefix"
${sudo_cmd[@]+"${sudo_cmd[@]}"} rm -rf "$prefix/lib/ollama"
${sudo_cmd[@]+"${sudo_cmd[@]}"} tar --zstd -xf "$work/$asset" -C "$prefix"
echo "Ollama installed. Ensure ${prefix}/bin is on PATH."
