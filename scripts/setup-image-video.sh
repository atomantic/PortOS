#!/usr/bin/env bash
# Bootstrap local image + video generation stack (mflux on Apple Silicon,
# diffusers on Windows). Optional — only needed if you want PortOS to render
# images/videos locally instead of (or in addition to) talking to an external
# AUTOMATIC1111 server. Models are downloaded on first use into HF's standard
# cache (~/.cache/huggingface) and surfaced in the PortOS Models manager.
#
# Env overrides:
#   PYTHON_BIN     Python 3 binary to use (default: python3)
#   PORTOS_DATA    Path to PortOS data dir (default: ./data, resolved from $REPO_ROOT)
#   INSTALL_VIDEO  '1' to also install mlx_video for LTX video generation (default: 1 on macOS, 0 on Windows)
#   INSTALL_LTX2   '1' to also clone + uv-sync dgrauet/ltx-2-mlx at ~/.portos/ltx-2-mlx for the second-gen LTX-2.3 pipeline (proper keyframe interpolation, true video extend, audio-to-video). Default: 0; opt in with INSTALL_LTX2=1.
#   INSTALL_LTX25  '1' to clone + uv-sync MrMofer's ltx-2.5 fork at ~/.portos/ltx-2.5-mlx (Apple Silicon). The 2.3 pin cannot load LTX-2.5 weights. Default: 0.
#   INSTALL_FASTVIDEO '1' to clone hao-ai-lab/FastVideo at ~/.portos/fastvideo and build an MLX venv for native Apple Silicon video generation (FastMetal models). Default: 0; opt in with INSTALL_FASTVIDEO=1.
#   INSTALL_MINIMAX_H3 '1' to install the pinned MiniMax H3 MLX runtime at ~/.portos/minimax-h3-mlx (Apple Silicon). Weights remain a separate explicit Video Gen download. Default: 0.
#   INSTALL_MERERUN '1' to install the signed mere.run v0.47.0 runtime at ~/.portos/mere-run for MiniMax H3 Ref2VA image+audio generation (Apple Silicon). Weights remain a separate explicit Video Gen download. Default: 0.
#   INSTALL_MINIMAX_H3_CUDA '1' to install the MiniMax H3 CUDA runtime at ~/.portos/minimax-h3-cuda (Windows/Linux + NVIDIA), via diffusers' MiniMaxH3ModularPipeline. Weights remain a separate explicit Video Gen download (~144 GB). Default: 0.
#   INSTALL_LTX25_CUDA '1' to install the official LTX-2.5 CUDA runtime at ~/.portos/ltx-2.5-cuda (Windows/Linux + NVIDIA). Weights remain a separate explicit Video Gen download. Default: 0.
#   INSTALL_WAN22_CUDA '1' to install the official Wan 2.2 Diffusers runtime at ~/.portos/wan2.2-cuda (Windows/Linux + NVIDIA). Weights remain a separate explicit Video Gen download. Default: 0.
#   INSTALL_FLUX2  '1' to also bootstrap a separate venv at ~/.portos/venv-flux2 for FLUX.2-klein (Apple Silicon, or x86_64 Windows/Linux via a hash-locked CUDA runtime; default: 1 on Apple Silicon, 0 elsewhere)
#   INSTALL_MUSICGEN '1' to bootstrap a venv at ~/.portos/venv-musicgen + clone ml-explore/mlx-examples to ~/.portos/mlx-examples for local MusicGen (MLX) background-music generation (pipeline audio stage). Default: 0; opt in with INSTALL_MUSICGEN=1 (macOS / Apple Silicon only).
#   MLX_EXAMPLES_PIN  commit SHA of ml-explore/mlx-examples to check out for MusicGen (default: main).
#   INSTALL_MINIMAX_MUSIC3_MLX '1' to bootstrap a separate venv at ~/.portos/venv-minimax-music3-mlx for native MiniMax Music 3 MLX generation (Music studio). Default: 0; opt in with INSTALL_MINIMAX_MUSIC3_MLX=1 (macOS / Apple Silicon only).
#   INSTALL_AUDIOLDM2 '1' to bootstrap a venv at ~/.portos/venv-audioldm2 (torch + diffusers) for local AudioLDM2 long-form background-music generation (pipeline audio stage, second backend alongside MusicGen). Default: 0; opt in with INSTALL_AUDIOLDM2=1 (runs on MPS / CUDA / CPU; Apple Silicon or x86_64 Windows/Linux, hash-locked).
#   INSTALL_ACESTEP '1' to bootstrap a venv at ~/.portos/venv-acestep (torch + the acestep package) for local ACE-Step full-song generation with vocals (Music studio, third backend). Default: 0; opt in with INSTALL_ACESTEP=1 (runs on MPS / CUDA / CPU; checkpoints auto-download to ~/.cache/ace-step on first run).
#   ACESTEP_PIN    commit SHA of ace-step/ACE-Step to check out for ACE-Step (default: 1bee4c9f5b43e30995f8d4d33b3919197ce1bd68).
#   INSTALL_ACESTEP15 '1' to bootstrap a venv at ~/.portos/venv-acestep15 (the ACE-Step 1.5 package + torch) for local ACE-Step 1.5 full-song generation (Music studio). Default: 0; opt in with INSTALL_ACESTEP15=1 (runs on MPS / CUDA / CPU; model weights are installed separately from Music).
#   ACESTEP15_PIN  commit SHA of ace-step/ACE-Step-1.5 to check out for ACE-Step 1.5 (default: dce621408bee8c31b4fcf4811682eb9359e1bc94).
#   INSTALL_MINIMAX_MUSIC3 '1' to bootstrap a venv at ~/.portos/venv-minimax-music3 (CUDA torch + a pinned diffusers) for local MiniMax Music 3 full-song generation up to five minutes (Music studio, fourth backend). Default: 0; opt in with INSTALL_MINIMAX_MUSIC3=1 (NVIDIA CUDA only; the ~29 GB of weights install separately from Music → Generate).
#   INSTALL_MUSCRIPTOR '1' to bootstrap a venv at ~/.portos/venv-muscriptor (the muscriptor pip package + its torch stack) for local audio → MIDI transcription (Rounds reference audio + Music Video parsing). Default: 0; opt in with INSTALL_MUSCRIPTOR=1 (runs on MPS / CUDA / CPU; model weights auto-download from HuggingFace on first transcription).

set -euo pipefail

PYTHON_BIN="${PYTHON_BIN:-python3}"
# CUDA wheel index for every runtime that needs torch on Windows, where the
# default PyPI wheel is CPU-only. One definition: a cu126 → cu130 bump has to
# move in lockstep with WIN_TORCH_CUDA_INDEX in server/lib/pythonSetup.js, and
# a per-block copy makes that a grep instead of an edit.
TORCH_CUDA_INDEX="${PORTOS_TORCH_CUDA_INDEX:-https://download.pytorch.org/whl/cu126}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PORTOS_DATA="${PORTOS_DATA:-${REPO_ROOT}/data}"

have() { command -v "$1" >/dev/null 2>&1; }

# Run an install probe, and on failure show WHY. Every probe here fails for more
# than one reason — a missing system library, a wheel resolved for the wrong
# arch, a moved pin — and the traceback is the only thing that tells them apart.
# Captured rather than re-run: a probe that fails non-deterministically must not
# report a different cause than the one that failed.
probe_or_fail() {
  local headline="$1" hint="$2"; shift 2
  local out
  if ! out="$("$@" 2>&1)"; then
    echo "❌ ${headline}" >&2
    printf '%s\n' "$out" | tail -n 5 | sed 's/^/   /' >&2
    echo "   ${hint}" >&2
    exit 1
  fi
}

is_macos() { [[ "$(uname -s)" == "Darwin" ]]; }
# Apple Silicon, including a shell translated by Rosetta. `uname -m` is
# x86_64 under Rosetta; hw.optional.arm64 is the hardware bit (same probe as
# isAppleSilicon() in server/lib/platform.js).
is_apple_silicon() {
  [[ "$(uname -s)" == "Darwin" ]] || return 1
  case "$(uname -m)" in
    arm64|aarch64) return 0 ;;
  esac
  [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" == "1" ]]
}
# A Rosetta-translated shell runs universal python3/uv as x86_64, and the
# venvs they build cannot install arm64-only mlx wheels. Re-exec natively
# once. PORTOS_SETUP_NATIVE stops a loop when arch cannot change uname.
# An existing universal venv still holds x86_64 wheels. reset_universal_venv
# deletes it before the create check only when the interpreter that will
# rebuild it can run as arm64 — an Intel-only python3 still runs under this
# re-exec and would replace a working venv with wheels mlx cannot install.
# pin_venv_arm64 then drops the x86_64 slice. Pinning before pip leaves the
# old wheels installed: pip --upgrade treats them as satisfied.
if is_apple_silicon && [[ -z "${PORTOS_SETUP_NATIVE:-}" ]]; then
  case "$(uname -m)" in
    arm64|aarch64) ;;
    *) PORTOS_SETUP_NATIVE=1 exec /usr/bin/arch -arm64 /bin/bash "$0" "$@" ;;
  esac
fi
# Git-bash / MSYS / Cygwin all report a prefixed uname; PortOS runs the
# in-app installer through git-bash on Windows, so match all three.
is_windows() { case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) return 0;; *) return 1;; esac; }

# A universal venv interpreter follows its parent's slice. After this script
# installs arm64 wheels, drop the x86_64 slice so a Rosetta Node process
# cannot launch that interpreter as x86_64. The copy replaces the venv
# symlink; lipo never rewrites the binary it points at. Framework Pythons
# load @executable_path/../Python3, which only exists beside that original
# binary — point the copy at the absolute library, or leave the symlink.
pin_venv_arm64() {
  is_apple_silicon || return 0
  case "$(uname -m)" in
    arm64|aarch64) ;;
    *) return 0 ;;
  esac
  local root="$1/bin" py base arches tmp link origin origin_dir dep rel abs failed extensions_checked=0 ext ext_arches
  [[ -d "$root" ]] || return 0
  for py in "$root"/python "$root"/python3 "$root"/python3.[0-9] "$root"/python3.[0-9][0-9]; do
    [[ -e "$py" && ! -d "$py" ]] || continue
    base="${py##*/}"
    [[ "$base" =~ ^python(3(\.[0-9]+)?)?$ ]] || continue
    arches="$(lipo -archs "$py" 2>/dev/null || true)"
    case " $arches " in
      *" arm64 "*|*" aarch64 "*) ;;
      *) continue ;;
    esac
    case " $arches " in
      *" x86_64 "*|*" i386 "*) ;;
      *) continue ;;
    esac
    # A skipped rebuild can leave x86_64 wheels that pip --upgrade treats as
    # current. Thinning the launcher then makes that venv unimportable.
    if [[ "$extensions_checked" -eq 0 ]]; then
      extensions_checked=1
      if [[ -d "$1/lib" ]]; then
        while IFS= read -r ext; do
          ext_arches="$(lipo -archs "$ext" 2>/dev/null || true)"
          [[ -n "$ext_arches" ]] || continue
          case " $ext_arches " in
            *" arm64 "*|*" aarch64 "*) continue ;;
          esac
          case " $ext_arches " in
            *" x86_64 "*|*" i386 "*) return 0 ;;
          esac
        done < <(find "$1/lib" -type f \( -name '*.so' -o -name '*.dylib' \) 2>/dev/null)
      fi
    fi
    origin="$py"
    while [[ -L "$origin" ]]; do
      link="$(readlink "$origin")" || continue 2
      case "$link" in
        /*) origin="$link" ;;
        *) origin="$(cd "$(dirname "$origin")" && pwd)/$link" ;;
      esac
    done
    [[ -e "$origin" && ! -d "$origin" ]] || continue
    origin_dir="$(cd "$(dirname "$origin")" && pwd)" || continue
    tmp="$(mktemp)"
    if ! lipo -thin arm64 "$py" -output "$tmp"; then
      rm -f "$tmp"
      continue
    fi
    failed=0
    while IFS= read -r dep; do
      case "$dep" in
        @executable_path/*) rel="${dep#@executable_path/}" ;;
        @loader_path/*) rel="${dep#@loader_path/}" ;;
        @rpath/*) failed=1; break ;;
        *) continue ;;
      esac
      if ! abs="$(cd "$origin_dir" && cd "$(dirname "$rel")" && pwd)"; then
        failed=1
        break
      fi
      abs="$abs/$(basename "$rel")"
      if [[ ! -e "$abs" ]] || ! install_name_tool -change "$dep" "$abs" "$tmp" >/dev/null 2>&1 || ! codesign -s - -f "$tmp" >/dev/null 2>&1; then
        failed=1
        break
      fi
    done < <(otool -L "$origin" 2>/dev/null | awk 'NR>1 { print $1 }')
    if [[ "$failed" -ne 0 ]]; then
      rm -f "$tmp"
      continue
    fi
    rm -f "$py"
    mv "$tmp" "$py"
    chmod +x "$py"
  done
}

# Whether path $2, or any symlink it passes through, lies under real directory
# $1. The venv's own python3 is usually a symlink out to its base interpreter,
# so the final target alone cannot prove a path does not depend on the venv.
# Every leading directory is resolved on its own, so venv/bin/alias/python3
# routes through the venv even when alias links back out of it.
# An unreadable hop or a link loop answers yes, which keeps the venv.
path_routes_through() {
  local root="$1" path="$2" dir link hops=0 abs prefix comp real
  local -a parts
  while :; do
    dir="${path%/*}"
    [[ "$dir" == "$path" ]] && dir="."
    [[ -n "$dir" ]] || dir="/"
    abs="$dir"
    [[ "$abs" == /* ]] || abs="$PWD/$abs"
    prefix=""
    IFS=/ read -ra parts <<< "$abs"
    for comp in "${parts[@]}"; do
      [[ -n "$comp" ]] || continue
      prefix="$prefix/$comp"
      real="$(cd -P "$prefix" 2>/dev/null && pwd)" || return 0
      case "$real" in
        "$root"|"$root"/*) return 0 ;;
      esac
    done
    dir="$(cd -P "$dir" 2>/dev/null && pwd)" || return 0
    path="${dir%/}/${path##*/}"
    case "$path" in
      "$root"/*) return 0 ;;
    esac
    [[ -L "$path" ]] || return 1
    hops=$((hops + 1))
    [[ "$hops" -le 40 ]] || return 0
    link="$(readlink "$path")" || return 0
    case "$link" in
      /*) path="$link" ;;
      *) path="$dir/$link" ;;
    esac
  done
}

# Delete a venv whose interpreter is still universal, before the create check.
# $2 is the interpreter the caller will rebuild with. The default is the
# command name python3; [[ -x python3 ]] looks in the current directory, so
# resolve a bare name on PATH or the reset never runs and pin later leaves
# x86_64 wheels under an arm64 launcher. An Intel-only binary still runs
# under this arm64 shell and cannot install arm64-only wheels, so a working
# venv is left in place. Apple's /usr/bin/python3 is 3.9 and still universal;
# ACE-Step 1.5 and MiniMax Music 3 need 3.10+, so a replacement below that
# floor is also left alone. An arm64-only interpreter is not universal.
# No-op until uname -m is arm64.
reset_universal_venv() {
  is_apple_silicon || return 0
  case "$(uname -m)" in
    arm64|aarch64) ;;
    *) return 0 ;;
  esac
  [[ -n "${1:-}" && -n "${2:-}" ]] || return 0
  local py="$1/bin/python3" arches base_arches base="$2" original="$2" outside="" dir path_rest root_real real given
  case "$base" in
    */*) ;;
    *) base="$(command -v "$base" 2>/dev/null || true)" ;;
  esac
  [[ -n "$base" && -x "$base" ]] || return 0
  # Containment has to compare real paths. A relative PYTHON_BIN such as
  # venv-audioldm2/bin/python3 does not match an absolute $1, and a symlink
  # (the directory or the interpreter itself) would hide the venv the caller
  # still invokes.
  root_real="$1"
  if real="$(cd -P "$1" 2>/dev/null && pwd)"; then root_real="$real"; fi
  given="$base"
  real="${base%/*}"
  [[ "$real" == "$base" ]] && real="."
  if real="$(cd -P "$real" 2>/dev/null && pwd)"; then
    base="$real/${base##*/}"
  fi
  # An activated venv is the first python on PATH. A caller that stored that
  # path cannot recreate the venv after it is deleted. A bare command name is
  # resolved again. Delete only when that same command exists later on PATH;
  # a different version would make the caller's venv command fail.
  # Check the path as given: collapsing its directory first would hide a
  # directory link inside the venv that resolves back out of it.
  if path_routes_through "$root_real" "$given"; then
    case "$original" in
      */*) return 0 ;;
    esac
    path_rest="$PATH"
    while [[ -n "$path_rest" ]]; do
      dir="${path_rest%%:*}"
      if [[ "$path_rest" == *:* ]]; then path_rest="${path_rest#*:}"; else path_rest=""; fi
      [[ -n "$dir" ]] || continue
      case "$dir" in
        "$1"|"$1"/*|"$root_real"|"$root_real"/*) continue ;;
      esac
      if [[ -x "$dir/$original" && ! -d "$dir/$original" ]] && ! path_routes_through "$root_real" "$dir/$original"; then
        outside="$dir/$original"
        break
      fi
    done
    [[ -n "$outside" ]] || return 0
    base="$outside"
  fi
  [[ -e "$py" && ! -d "$py" ]] || return 0
  arches="$(lipo -archs "$py" 2>/dev/null || true)"
  case " $arches " in
    *" arm64 "*|*" aarch64 "*) ;;
    *) return 0 ;;
  esac
  case " $arches " in
    *" x86_64 "*|*" i386 "*) ;;
    *) return 0 ;;
  esac
  base_arches="$(lipo -archs "$base" 2>/dev/null || true)"
  case " $base_arches " in
    *" arm64 "*|*" aarch64 "*) ;;
    *)
      "$base" -c 'import platform,sys; sys.exit(0 if platform.machine() in ("arm64","aarch64") else 1)' >/dev/null 2>&1 || return 0
      ;;
  esac
  # The arch check above accepts /usr/bin/python3. Recreating a 3.10+ venv
  # with that 3.9 interpreter makes the next pip install fail.
  python_at_least_310 "$base" || return 0
  echo "♻️  Recreating ${1} so native wheels replace the universal interpreter's x86_64 packages."
  rm -rf "$1"
  # An earlier `python3 -m venv` in this script hashed the deleted interpreter.
  # The next caller would otherwise execute that pathname and exit 127.
  hash -r
}

# Resolve a venv interpreter from the layout its creating Python used. Git Bash
# keeps its POSIX shell paths on Windows, but Python still creates Scripts/.
# Do not pin here: callers install packages after this returns, and a thinned
# launcher must not precede that install.
venv_python() {
  if [[ -x "$1/bin/python3" ]]; then
    printf '%s\n' "$1/bin/python3"
  else
    printf '%s\n' "$1/Scripts/python.exe"
  fi
}

# True if a venv at $1 already has an interpreter under either layout —
# shared with venv_python so the two probes can't drift apart.
venv_exists() { [[ -x "$1/bin/python3" || -x "$1/Scripts/python.exe" ]]; }

# Use the same private, hash-verified uv as server/lib/privateUv.js. Never
# execute or upgrade a user-wide PATH copy. This stays lazy for installs that
# only need pip (and for the Python-free mere.run lane).
portos_uv() {
  local tool_dir="${HOME}/.portos/tools/uv-0.13.6" bin banner candidate bootstrap_python=""
  if is_windows; then bin="$tool_dir/Scripts/uv.exe"; else bin="$tool_dir/bin/uv"; fi
  banner="$("$bin" --version 2>/dev/null || true)"
  if [[ ! "$banner" =~ ^uv\ 0\.13\.6($|[[:space:]]) ]]; then
    # A runtime may need recovery precisely because PYTHON_BIN is an old or
    # minimal system Python. Select a complete interpreter for this tool only;
    # runtime interpreter selection stays with its lane below.
    for candidate in "$PYTHON_BIN" python3.14 python3.13 python3.12 python3.11 python3.10 python3.9 python3.8 python3; do
      if have "$candidate" && "$candidate" -c 'import ensurepip, sys, venv; sys.exit(sys.version_info[:2] < (3, 8))' >/dev/null 2>&1; then
        bootstrap_python="$candidate"
        break
      fi
    done
    if [[ -z "$bootstrap_python" ]]; then
      echo "❌ PortOS-private uv needs Python 3.8+ with venv and ensurepip. Install Python with venv support or set PYTHON_BIN to a complete Python installation, then retry Repair." >&2
      return 1
    fi
    echo "📦 Bootstrapping PortOS-private uv 0.13.6..." >&2
    "$bootstrap_python" -m venv --clear "$tool_dir" >&2 || return
    "$(venv_python "$tool_dir")" -m pip install --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r "$SCRIPT_DIR/requirements-uv-bootstrap.lock.txt" >&2 || return
    banner="$("$bin" --version 2>/dev/null || true)"
    if [[ ! "$banner" =~ ^uv\ 0\.13\.6($|[[:space:]]) ]]; then
      echo "❌ PortOS-private uv did not report the locked version 0.13.6. Retry Repair." >&2
      exit 1
    fi
  fi
  "$bin" "$@"
}

# Runtimes installed from x86_64 Windows/Linux cu126 hash locks
# (scripts/requirements-<name>-cuda-{windows,linux}.lock.txt) share this flow.
# $1 = label for messages, $2 = doc that explains regenerating the locks.
require_cuda_lock_host() {
  case "$(uname -m)" in
    x86_64|amd64|AMD64) ;;
    *) echo "❌ $1 CUDA hash locks support x86_64 Windows/Linux only." >&2; exit 1 ;;
  esac
  if [[ "$TORCH_CUDA_INDEX" != "https://download.pytorch.org/whl/cu126" ]]; then
    echo "❌ $1 CUDA is locked to cu126. Unset PORTOS_TORCH_CUDA_INDEX; see $2." >&2
    exit 1
  fi
}

# $1 = label, $2 = venv, $3 = lock name prefix (requirements-<prefix>-<os>.lock.txt),
# remaining args = extra `uv pip sync` flags (e.g. --no-binary <sdist-only dep>).
# The locks target 3.11. Repair keeps a standalone 3.11 venv and rebuilds other
# minors and Conda bases, whose DLL search path can stop CUDA torch loading on
# Windows. Sync removes packages outside the lock.
sync_cuda_lock_venv() {
  local label="$1" venv="$2" lock py
  local sync_args=("${@:4}")
  if is_windows; then lock="${SCRIPT_DIR}/$3-windows.lock.txt"; else lock="${SCRIPT_DIR}/$3-linux.lock.txt"; fi
  if venv_exists "$venv"; then
    py="$(venv_python "$venv")"
    if ! "$py" -c "import sys; from pathlib import Path; sys.exit(sys.version_info[:2] != (3, 11) or (Path(sys.base_prefix) / 'conda-meta').is_dir())"; then
      echo "♻️ Rebuilding ${label} CUDA with its locked Python 3.11..."
      portos_uv venv --clear --managed-python --python 3.11 "$venv"
    fi
  fi
  if ! venv_exists "$venv"; then
    echo "📦 Creating ${label} CUDA venv (Python 3.11) at ${venv}..."
    portos_uv venv --managed-python --python 3.11 "$venv"
  fi
  py="$(venv_python "$venv")"
  echo "📦 Syncing the hash-pinned ${label} CUDA runtime into ${venv}..."
  portos_uv pip sync --require-hashes --only-binary :all: ${sync_args[@]+"${sync_args[@]}"} --index-strategy unsafe-best-match --python "$py" "$lock"
}

# True when $1 is a Python 3.10+ interpreter. Mirrors MIN_VENV_PYTHON in
# server/lib/pythonSetup.js, and for the same reason: below 3.10 pip resolves an
# old setuptools (<77) inside its build isolation, which rejects the PEP 639
# *string* form of `project.license`. A git-sourced dependency that uses it
# (sdnq declares `license = "GPL-3.0-only"`) then dies in "Getting requirements
# to build wheel" — after the multi-GB torch download, with a schema error that
# reads like a pip bug. mflux/mlx need the same floor.
python_at_least_310() {
  [[ -n "${1:-}" ]] && "$1" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)' 2>/dev/null
}

# Echo the first Python 3.10+ on PATH, preferring $PYTHON_BIN. $1, when set,
# is a venv to skip: its interpreter cannot recreate itself. Empty when the
# machine has none outside that directory.
newest_supported_python() {
  local candidate found exclude="${1:-}"
  if python_at_least_310 "$PYTHON_BIN"; then
    found="$(command -v "$PYTHON_BIN" 2>/dev/null || true)"
    if [[ -n "$exclude" && "$found" == "$exclude"/* ]]; then found=""; fi
    if [[ -n "$found" ]]; then printf '%s\n' "$found"; return 0; fi
  fi
  for candidate in python3.14 python3.13 python3.12 python3.11 python3.10; do
    if have "$candidate" && python_at_least_310 "$candidate"; then
      found="$(command -v "$candidate")"
      if [[ -n "$exclude" && "$found" == "$exclude"/* ]]; then continue; fi
      printf '%s\n' "$found"
      return 0
    fi
  done
  return 1
}

# mere.run is a signed native binary and is the one setup path that does not
# need Python. Keep the bare-script default and every mixed install strict: only
# an explicit INSTALL_MERERUN=1 request with no other runtime selected may run
# on a machine without Python.
python_required() {
  local non_mere_requests
  non_mere_requests="${INSTALL_MFLUX:-0}${INSTALL_VIDEO:-0}${INSTALL_LTX2:-0}${INSTALL_LTX25:-0}${INSTALL_LTX25_CUDA:-0}${INSTALL_FASTVIDEO:-0}${INSTALL_WAN22:-0}${INSTALL_WAN22_CUDA:-0}${INSTALL_MINIMAX_H3:-0}${INSTALL_MINIMAX_H3_CUDA:-0}${INSTALL_MUSICGEN:-0}${INSTALL_AUDIOLDM2:-0}${INSTALL_ACESTEP:-0}${INSTALL_ACESTEP15:-0}${INSTALL_MINIMAX_MUSIC3:-0}${INSTALL_MINIMAX_MUSIC3_MLX:-0}${INSTALL_MUSCRIPTOR:-0}${INSTALL_FLUX2:-0}"
  [[ "${INSTALL_MERERUN:-0}" != "1" || "$non_mere_requests" == *[!0]* ]]
}

# Check out a pin (a commit SHA, tag, or branch name) in an already-fetched
# clone. A bare `git checkout <branch>` lands on the *local* branch created at
# clone time, which `git fetch origin` never advances — so re-running with a
# branch pin like `main` would stick on a stale commit. When the pin names a
# remote branch, hard-reset to `origin/<pin>` so branch pins always track the
# freshly-fetched upstream tip; SHA / tag pins (no matching `origin/<pin>`)
# fall through to the detached checkout untouched.
git_checkout_pin() {
  local dir="$1" pin="$2"
  if git -C "$dir" show-ref --verify --quiet "refs/remotes/origin/${pin}"; then
    git -C "$dir" checkout --quiet -B "$pin" "origin/${pin}"
  else
    git -C "$dir" checkout --quiet "$pin"
  fi
}

require_mlx_video_profile() {
  local label="$1" pin="$2" audited_revision="$3"
  if ! is_apple_silicon; then
    echo "❌ ${label} requires an Apple-Silicon Mac." >&2
    return 1
  fi
  if [[ "$pin" != "$audited_revision" ]]; then
    echo "❌ ${label} has no audited install profile for revision '${pin}'. Use the shipped revision ${audited_revision}." >&2
    return 1
  fi
}

sync_locked_mlx_video() (
  local label="$1" dir="$2" python="$3" pin="$4" base_python checkout_status
  shift 4
  cd "$dir"
  checkout_status="$(git status --porcelain=v1 --untracked-files=all)"
  if [[ "$(git rev-parse HEAD)" != "$pin" || ! -f uv.lock || -n "$checkout_status" ]]; then
    echo "❌ ${label} requires the clean pinned source and uv.lock at ${pin}. Preserve any local changes separately, then retry Repair." >&2
    return 1
  fi

  # Keep both steps in this checkout and prevent inherited uv settings from
  # bypassing isolation or redirecting the verified dependency install.
  unset UV_PROJECT UV_WORKING_DIR UV_NO_BUILD_ISOLATION UV_NO_VERIFY_HASHES
  export UV_PROJECT_ENVIRONMENT="$PWD/.venv"
  base_python="$(portos_uv --no-config python find 3.11 2>/dev/null || true)"
  reset_universal_venv "$UV_PROJECT_ENVIRONMENT" "$base_python"
  if [[ ! -x "$python" ]]; then
    echo "📦 Creating ${label} venv with Python 3.11..."
    portos_uv --no-config venv --python 3.11 "$UV_PROJECT_ENVIRONMENT"
  fi
  # Upstream uv.lock supplies the runtime hashes. Build workspace packages in
  # a second step because uv.lock doesn't pin their isolated PEP 517 backends.
  echo "📦 Syncing ${label} wheels from the pinned upstream lock..."
  portos_uv --no-config --no-cache sync --locked --no-build --no-install-workspace --python "$python"
  echo "📦 Building pinned ${label} source with hash-locked build tools..."
  portos_uv --no-config --no-cache pip install --no-deps --only-binary :all: --preview-features build-dependency-hashes --require-build-hashes --build-constraints "$SCRIPT_DIR/requirements-mlx-video-build.lock.txt" --python "$python" --reinstall "$@"
  pin_venv_arm64 "$UV_PROJECT_ENVIRONMENT"
)

if python_required && ! have "$PYTHON_BIN"; then
  echo "❌ $PYTHON_BIN not found. Install Python 3.10+ first." >&2
  exit 1
fi

mkdir -p "${PORTOS_DATA}/loras"
mkdir -p "${PORTOS_DATA}/videos"
mkdir -p "${PORTOS_DATA}/video-thumbnails"

# When the user only wants a specific BYOV runtime (set via INSTALL_LTX2 /
# INSTALL_WAN22 / INSTALL_MINIMAX_H3 / INSTALL_MERERUN / INSTALL_MINIMAX_H3_CUDA — or one of the self-contained MUSIC venvs
# INSTALL_MUSICGEN / INSTALL_AUDIOLDM2 / INSTALL_ACESTEP / INSTALL_ACESTEP15 / INSTALL_MINIMAX_MUSIC3_MLX — typically from the
# in-app installer), skip the mflux + legacy mlx_video preamble. Those
# bring-your-own-venv runtimes are self-contained and don't depend on mflux;
# running the preamble unprompted hits PEP 668 ("externally-managed-environment")
# on Homebrew Python and aborts the whole script before the requested runtime
# install ever starts — which on Linux/CPU/CUDA blocks the advertised
# `INSTALL_ACESTEP=1 bash …` path. A bare `bash setup-image-video.sh` still
# installs mflux as before.
ANY_BYOV="${INSTALL_LTX2:-0}${INSTALL_LTX25:-0}${INSTALL_LTX25_CUDA:-0}${INSTALL_FASTVIDEO:-0}${INSTALL_WAN22:-0}${INSTALL_WAN22_CUDA:-0}${INSTALL_MINIMAX_H3:-0}${INSTALL_MERERUN:-0}${INSTALL_MINIMAX_H3_CUDA:-0}${INSTALL_MUSICGEN:-0}${INSTALL_AUDIOLDM2:-0}${INSTALL_ACESTEP:-0}${INSTALL_ACESTEP15:-0}${INSTALL_MINIMAX_MUSIC3:-0}${INSTALL_MINIMAX_MUSIC3_MLX:-0}${INSTALL_MUSCRIPTOR:-0}"
# "no BYOV runtime was requested" = the concatenation contains no non-zero
# character. Matching a literal string of zeros instead made this a counting
# exercise that the string and the variable list had to agree on — and they had
# already fallen out of step, so a bare `bash setup-image-video.sh` was taking
# the BYOV-only branch and skipping the mflux + flux2 preamble it advertises.
# This form cannot drift as runtimes are added.
if [[ "$ANY_BYOV" != *[!0]* ]]; then
  DEFAULT_INSTALL_MFLUX=1
  DEFAULT_INSTALL_VIDEO=$(is_macos && echo 1 || echo 0)
  DEFAULT_INSTALL_FLUX2=$(is_apple_silicon && echo 1 || echo 0)
else
  DEFAULT_INSTALL_MFLUX=0
  DEFAULT_INSTALL_VIDEO=0
  # An in-app "install LTX-2" click must NOT silently run the multi-GB
  # FLUX.2 setup too — gate flux2 off the same BYOV-only signal as mflux /
  # mlx_video. A bare `bash setup-image-video.sh` (no env) still installs
  # flux2 on macOS as before.
  DEFAULT_INSTALL_FLUX2=0
fi
INSTALL_MFLUX="${INSTALL_MFLUX:-$DEFAULT_INSTALL_MFLUX}"
INSTALL_VIDEO="${INSTALL_VIDEO:-$DEFAULT_INSTALL_VIDEO}"

if [[ "$INSTALL_MFLUX" == "1" ]]; then
  # Install via pip --user so we don't pollute the system or require a venv.
  # mflux comes with the mflux-generate CLI which the local image backend
  # spawns directly. The shared inference runtime remains supported.
  echo "📦 Installing image generation packages (mflux + deps)..."
  # Direct pins and the complete closure live in requirements-mflux-mlx{,.lock}.txt.
  if ! is_apple_silicon; then
    echo "❌ mflux requires Apple Silicon; no locked mflux profile exists for this host. Use INSTALL_MFLUX=0 and select a supported CUDA runtime instead." >&2
    exit 1
  fi
  # Complete Apple Silicon closure; never resolve a fallback on other hosts.
  MFLUX_LOCK="$SCRIPT_DIR/requirements-mflux-mlx.lock.txt"
  MFLUX_MIN_MINOR=11
  MFLUX_PROBE='from mflux.models.flux.cli.flux_generate import main; from mflux.models.common.cli.train import main'
  # The historical layout installs mflux with `pip install --user` against
  # $PYTHON_BIN, and PortOS discovers the shared console scripts beside that
  # interpreter. But when $PYTHON_BIN is too old (e.g. a system python3.8) or
  # externally-managed (PEP 668) so the --user install fails or can't be
  # imported, fall back to a dedicated venv at ~/.portos/venv-mflux — the same
  # pattern the flux2/ltx/wan runtimes use. PortOS's resolveMfluxPython()
  # auto-discovers that venv, so no Settings change is needed either way.
  MFLUX_USE_VENV=0
  if "$PYTHON_BIN" -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3, ${MFLUX_MIN_MINOR}) else 1)" 2>/dev/null; then
    # Step 1: force-reinstall mflux's OWN files with --no-deps to flush a stale
    # file layout left by a partial reinstall (we hit this on 0.12.1, where
    # `mflux/models/flux/cli/` went missing, breaking the entry-point shim)
    # WITHOUT re-downloading the heavy torch/mlx tree.
    # Step 2: every other package at its locked version and hash. --no-deps
    # because the lock is already the complete closure.
    MFLUX_SELF_REQ="$(mktemp)"
    awk '/^[^ #]/ { keep = /^mflux==/ } keep' "$MFLUX_LOCK" > "$MFLUX_SELF_REQ"
    "$PYTHON_BIN" -m pip install --user --require-hashes --no-deps --force-reinstall -r "$MFLUX_SELF_REQ" \
      && "$PYTHON_BIN" -m pip install --user --require-hashes --no-deps -r "$MFLUX_LOCK" \
      || MFLUX_USE_VENV=1
    rm -f "$MFLUX_SELF_REQ"
    # A satisfied-looking pip run can still leave an unimportable stack on an odd
    # system Python — verify mflux actually imports before trusting the --user path.
    if [[ "$MFLUX_USE_VENV" == "0" ]] && ! "$PYTHON_BIN" -c "$MFLUX_PROBE" 2>/dev/null; then
      echo "⚠️  mflux installed under $PYTHON_BIN but does not import — falling back to a dedicated venv."
      MFLUX_USE_VENV=1
    fi
  else
    MFLUX_PYVER="$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo unknown)"
    echo "⚠️  $PYTHON_BIN is Python ${MFLUX_PYVER} — mflux needs 3.${MFLUX_MIN_MINOR}+; using a dedicated venv."
    MFLUX_USE_VENV=1
  fi

  if [[ "$MFLUX_USE_VENV" == "1" ]]; then
    # Dedicated mflux venv (Python 3.11) built with uv, mirroring the flux2/ltx/
    # wan runtimes. uv provisions a managed 3.11 even when the system Python is
    # unusable, which is exactly the case we're recovering from.
    MFLUX_VENV="${HOME}/.portos/venv-mflux"
    MFLUX_VENV_PY="${MFLUX_VENV}/bin/python3"
    MFLUX_BASE_PY="$(portos_uv python find 3.11 2>/dev/null || true)"
    reset_universal_venv "$MFLUX_VENV" "$MFLUX_BASE_PY"
    if [[ ! -x "$MFLUX_VENV_PY" ]]; then
      echo "📦 Creating mflux venv at ${MFLUX_VENV} (Python 3.11)..."
      mkdir -p "${HOME}/.portos"
      portos_uv venv --python 3.11 "$MFLUX_VENV"
    fi
    # The venv is mflux's alone, so sync it to exactly the lock.
    echo "📦 Installing the hash-pinned mflux lock into ${MFLUX_VENV}..."
    portos_uv pip sync --python "$MFLUX_VENV_PY" --require-hashes "$MFLUX_LOCK"
    pin_venv_arm64 "$MFLUX_VENV"
    probe_or_fail \
      "mflux venv built but its CLIs failed to import." \
      "Check that mflux and its MLX dependencies installed cleanly in ${MFLUX_VENV}." \
      "$MFLUX_VENV_PY" -c "$MFLUX_PROBE"
    echo "✅ mflux venv ready: ${MFLUX_VENV_PY} (PortOS auto-discovers it — no Settings change needed)."
  fi
fi

if [[ "$INSTALL_VIDEO" == "1" ]]; then
  if is_apple_silicon; then
    echo "📦 Installing video generation packages (mlx-video-with-audio + mlx_vlm)..."
    # NOTE: the package on PyPI named just 'mlx_video' is unrelated (video
    # loading utilities). The LTX-2 generation backend lives at
    # mlx-video-with-audio (provides the `mlx_video.generate_av` module).
    # Pinned >=0.1.35 — earlier versions silently broke I2V on split-format /
    # quantized models like LTX-2.3 distilled-Q4 by failing to load the VAE
    # encoder, causing the conditioned frame to render as gray fog.
    # Both packages provide an `import mlx_video` module, so a prior install
    # of the wrong one shadows the right one. Uninstall first to remove the
    # ambiguity for users upgrading from earlier setup-image-video.sh runs.
    "$PYTHON_BIN" -m pip uninstall --yes mlx_video >/dev/null 2>&1 || true
    # Installed only from the hash-pinned lock (a superset of the mflux lock,
    # CPython 3.11+): no install-time resolution, so a new or compromised
    # transitive release cannot land on the next Repair.
    VIDEO_PYVER="$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>&1 || true)"
    case "$VIDEO_PYVER" in
      3.1[1-9]|3.[2-9][0-9]) ;;
      *)
        echo "❌ INSTALL_VIDEO=1 needs Python 3.11+ for its hash-pinned lock; $PYTHON_BIN reports: ${VIDEO_PYVER:-no version}." >&2
        echo "   Point PYTHON_BIN at a Python 3.11+ and re-run." >&2
        exit 1
        ;;
    esac
    VIDEO_LOCK="$SCRIPT_DIR/requirements-mflux-video-mlx.lock.txt"
    # Uninstalling the wrong-namesake `mlx_video` can delete files the real
    # package shares, and a satisfied-looking lock install would not restore
    # them. Force-reinstall mlx-video-with-audio's OWN files (--no-deps, so the
    # heavy tree is untouched), then install the rest of the lock.
    VIDEO_SELF_REQ="$(mktemp)"
    awk '/^[^ #]/ { keep = /^mlx-video-with-audio==/ } keep' "$VIDEO_LOCK" > "$VIDEO_SELF_REQ"
    VIDEO_STATUS=0
    "$PYTHON_BIN" -m pip install --user --require-hashes --no-deps --force-reinstall -r "$VIDEO_SELF_REQ" || VIDEO_STATUS=$?
    if [[ "$VIDEO_STATUS" == "0" ]]; then
      "$PYTHON_BIN" -m pip install --user --require-hashes --no-deps -r "$VIDEO_LOCK" || VIDEO_STATUS=$?
    fi
    rm -f "$VIDEO_SELF_REQ"
    [[ "$VIDEO_STATUS" == "0" ]] || exit "$VIDEO_STATUS"
  elif is_macos; then
    # mlx ships arm64-only wheels and the lock covers only arm64 macOS.
    echo "❌ INSTALL_VIDEO=1 needs Apple Silicon: mlx ships arm64-only wheels and this Mac has no hash-pinned lock." >&2
    exit 1
  else
    # No hash-pinned lock covers a bare-interpreter torch + diffusers install.
    # The CUDA video runtimes each own a locked venv instead (INSTALL_LTX25_CUDA,
    # INSTALL_WAN22_CUDA, INSTALL_MINIMAX_H3_CUDA); this legacy path no longer
    # resolves unpinned packages.
    echo "❌ INSTALL_VIDEO=1 has no hash-pinned lock for this platform; unpinned torch/diffusers installs are no longer supported." >&2
    echo "   Use a locked runtime instead: INSTALL_LTX25_CUDA=1, INSTALL_WAN22_CUDA=1 or INSTALL_MINIMAX_H3_CUDA=1." >&2
    exit 1
  fi
fi

INSTALL_LTX2="${INSTALL_LTX2:-0}"

if [[ "$INSTALL_LTX2" == "1" ]]; then
  # dgrauet/ltx-2-mlx: a more capable community port of LTX-2.3 with
  # proper KeyframeInterpolationPipeline (true FFLF), video Extend (not
  # last-frame conditioning), retake, ic-lora, audio-to-video.
  # Requires Python 3.11+ and ships as a multi-package monorepo we sync
  # via `uv sync --locked` from a local clone. Lives at
  # ~/.portos/ltx-2-mlx/ (sibling to the FLUX.2 venv pattern).
  #
  # The runtime is pinned to a known-good commit in PortOS releases for
  # reproducibility — upstream changes cannot break installs without a
  # PortOS release. Source build inputs are documented in docs/MLX_VIDEO_LOCKS.md.
  #
  # The notapalindrome `mlx-video-with-audio` install above is unaffected
  # — both pipelines coexist; dispatch is per-model via media-models.json's
  # `runtime` field (`mlx_video` vs `ltx2`).
  if ! have git; then
    echo "❌ INSTALL_LTX2=1 requires git." >&2
    exit 1
  fi
  # Pinned to v0.14.19 (2026-07-19). To upgrade: bump this SHA and verify with
  # PortOS's video gen smoke tests (text/image/fflf/extend/a2v).
  # NOTE: v0.14.x renamed every public pipeline class (TextToVideoPipeline →
  # TI2VidOneStagePipeline, ExtendPipeline → RetakePipeline, etc.) and switched
  # the output-rate kwarg from `fps` to `frame_rate`. generate_ltx2.py resolves
  # pipeline classes and the rate kwarg defensively so it works against this pin
  # AND older pre-rename pins an install may still have checked out.
  LTX2_AUDITED_REVISION="1192051fd380e0501adb5f3c0e9a216e679cb123"
  LTX2_PIN="${LTX2_PIN:-$LTX2_AUDITED_REVISION}"
  require_mlx_video_profile "LTX-2 MLX" "$LTX2_PIN" "$LTX2_AUDITED_REVISION"
  LTX2_DIR="${HOME}/.portos/ltx-2-mlx"
  LTX2_PY="${LTX2_DIR}/.venv/bin/python3"
  mkdir -p "${HOME}/.portos"
  if [[ ! -d "${LTX2_DIR}/.git" ]]; then
    echo "📦 Cloning dgrauet/ltx-2-mlx (pinned to ${LTX2_PIN:0:12})..."
    git clone --progress https://github.com/dgrauet/ltx-2-mlx.git "${LTX2_DIR}"
  else
    echo "📦 Fetching ltx-2-mlx updates..."
    (cd "${LTX2_DIR}" && git fetch --progress origin)
  fi
  echo "📦 Checking out pinned commit ${LTX2_PIN:0:12}..."
  git_checkout_pin "${LTX2_DIR}" "${LTX2_PIN}"
  sync_locked_mlx_video "LTX-2 MLX" "$LTX2_DIR" "$LTX2_PY" "$LTX2_PIN" \
    -e packages/ltx-core-mlx -e packages/ltx-pipelines-mlx
  probe_or_fail \
    "ltx-2-mlx synced but 'import ltx_pipelines_mlx' failed." \
    "Re-run with: rm -rf ${LTX2_DIR}/.venv && bash $0" \
    "${LTX2_PY}" -c "import ltx_pipelines_mlx"
  echo "✅ ltx-2-mlx venv ready: ${LTX2_PY}"
fi

INSTALL_LTX25="${INSTALL_LTX25:-0}"
if [[ "$INSTALL_LTX25" == "1" ]]; then
  # MrMofer's ltx25 fork of dgrauet/ltx-2-mlx. Same pipeline API as the 2.3
  # runtime (generate_ltx2.py), different checkout — LTX-2.5 weights do not
  # load on the frozen 2.3 pin.
  if ! have git; then
    echo "❌ INSTALL_LTX25=1 requires git." >&2
    exit 1
  fi
  # VERIFIED PIN — image-to-video frame-one anchor (#5422). This fork samples
  # distilled stage 1 with the ancestral (SDE) Euler loop, which renoises the
  # whole latent every step. This revision's `ancestral_denoise_loop`
  # (packages/ltx-pipelines-mlx/.../utils/samplers.py) re-applies the
  # conditioning mask AFTER that renoise, so the frame-0 tokens stay equal to
  # the supplied image at every step rather than only the last. A revision that
  # does not renders a coherent clip unrelated to the picture the user handed
  # in. Moving this pin means re-reading that loop and moving
  # `i2vAnchorVerifiedRevision` in server/services/videoGen/runtimes.js with it
  # (runtimes.test.js fails until both agree); scripts/generate_ltx2.py also
  # checks the LIVE checkout at render time and refuses rather than drifting.
  LTX25_AUDITED_REVISION="57952288076766abe27dda3a774b2c24f7346977"
  LTX25_PIN="${LTX25_PIN:-$LTX25_AUDITED_REVISION}"
  require_mlx_video_profile "LTX-2.5 MLX" "$LTX25_PIN" "$LTX25_AUDITED_REVISION"
  LTX25_DIR="${HOME}/.portos/ltx-2.5-mlx"
  LTX25_PY="${LTX25_DIR}/.venv/bin/python3"
  mkdir -p "${HOME}/.portos"
  if [[ ! -d "${LTX25_DIR}/.git" ]]; then
    echo "📦 Cloning MrMoferFRAN/ltx-2-mlx (pinned to ${LTX25_PIN:0:12})..."
    git clone --progress https://github.com/MrMoferFRAN/ltx-2-mlx.git "${LTX25_DIR}"
  else
    echo "📦 Fetching ltx-2.5-mlx updates..."
    (cd "${LTX25_DIR}" && git fetch --progress origin)
  fi
  echo "📦 Checking out pinned commit ${LTX25_PIN:0:12}..."
  git_checkout_pin "${LTX25_DIR}" "${LTX25_PIN}"
  sync_locked_mlx_video "LTX-2.5 MLX" "$LTX25_DIR" "$LTX25_PY" "$LTX25_PIN" \
    -e packages/ltx-core-mlx -e packages/ltx-pipelines-mlx
  probe_or_fail \
    "ltx-2.5-mlx synced but 'import ltx_pipelines_mlx' failed." \
    "Re-run with: rm -rf ${LTX25_DIR}/.venv && bash $0" \
    "${LTX25_PY}" -c "import ltx_pipelines_mlx"
  echo "✅ ltx-2.5-mlx venv ready: ${LTX25_PY}"
fi

INSTALL_FASTVIDEO="${INSTALL_FASTVIDEO:-0}"
if [[ "$INSTALL_FASTVIDEO" == "1" ]]; then
  # FastVideo provides native Apple Silicon inference for Wan and FastMetal models
  # via MLX/Metal. Reached only when the user chooses Install/Repair in Video Gen.
  if ! is_apple_silicon; then
    echo "❌ FastVideo MLX requires an Apple-Silicon Mac." >&2
    exit 1
  fi
  if ! have git; then
    echo "❌ INSTALL_FASTVIDEO=1 requires git." >&2
    exit 1
  fi

  FASTVIDEO_PIN="${FASTVIDEO_PIN:-fa2d1324c60050cd65209c6aaeac470e7fb412f5}"
  FASTVIDEO_DIR="${HOME}/.portos/fastvideo"
  FASTVIDEO_PY="${FASTVIDEO_DIR}/.venv/bin/python3"
  FASTVIDEO_LOCK="${SCRIPT_DIR}/requirements-fastvideo-mlx.lock.txt"
  mkdir -p "${HOME}/.portos"
  if [[ ! -d "${FASTVIDEO_DIR}/.git" ]]; then
    echo "📦 Cloning hao-ai-lab/FastVideo..."
    git clone --progress https://github.com/hao-ai-lab/FastVideo.git "${FASTVIDEO_DIR}"
  else
    echo "📦 Fetching FastVideo updates..."
    (cd "${FASTVIDEO_DIR}" && git fetch --progress origin)
  fi
  git_checkout_pin "${FASTVIDEO_DIR}" "${FASTVIDEO_PIN}"
  FASTVIDEO_BASE_PY="$(portos_uv python find 3.11 2>/dev/null || true)"
  reset_universal_venv "${FASTVIDEO_DIR}/.venv" "$FASTVIDEO_BASE_PY"
  if [[ ! -x "${FASTVIDEO_PY}" ]]; then
    echo "📦 Creating FastVideo venv with Python 3.11..."
    (cd "${FASTVIDEO_DIR}" && portos_uv venv --python 3.11)
  fi
  if ! "$FASTVIDEO_PY" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 11) else 1)'; then
    echo "❌ FastVideo on Apple Silicon needs Python 3.11+; ${FASTVIDEO_PY} is older." >&2
    echo "   Re-run with PYTHON_BIN pointing at a 3.11+ interpreter (e.g. 'brew install python@3.12')." >&2
    exit 1
  fi
  # FastVideo MLX on Apple Silicon installs only from the hash-pinned lock
  # (scripts/requirements-fastvideo-mlx.lock.txt): no install-time resolution,
  # so a new or compromised transitive release can't land on the next Repair.
  # Direct pins: scripts/requirements-fastvideo-mlx.txt. The checkout itself
  # is installed with --no-deps so no unpinned dependencies resolve.
  # --python is mandatory: `uv pip sync` and `uv pip install` resolve their
  # target interpreter from VIRTUAL_ENV/CONDA_PREFIX if --python is omitted.
  echo "📦 Installing FastVideo MLX packages from hash-pinned lock into ${FASTVIDEO_DIR}/.venv..."
  portos_uv pip sync --require-hashes --python "${FASTVIDEO_PY}" "$FASTVIDEO_LOCK"
  portos_uv pip install --no-deps --python "${FASTVIDEO_PY}" -e "${FASTVIDEO_DIR}"
  pin_venv_arm64 "${FASTVIDEO_DIR}/.venv"
  probe_or_fail \
    "FastVideo synced but the runtime import failed in ${FASTVIDEO_PY}." \
    "Delete ${FASTVIDEO_DIR}/.venv and use Repair / Upgrade from the Video Gen runtime panel to retry." \
    "${FASTVIDEO_PY}" -c "import fastvideo; import mlx.core"
  # The decoders come straight off raw.githubusercontent.com through urllib with
  # no retry of its own, so one reset handshake ends the whole install in a bare
  # Python traceback. Retry, and if it still fails say what is and isn't
  # installed instead of leaving the last SSL frame as the only explanation.
  echo "📦 Preparing FastMetal preview decoders..."
  fastvideo_decoder_attempt=1
  until "${FASTVIDEO_PY}" -c "from fastvideo.mlx_runtime.wan_vae import ensure_taehv_checkpoint; ensure_taehv_checkpoint(z_dim=16); ensure_taehv_checkpoint(z_dim=48)"; do
    if (( fastvideo_decoder_attempt >= 3 )); then
      echo "❌ FastMetal preview decoders could not be downloaded after 3 attempts." >&2
      echo "   The FastVideo runtime itself installed fine at ${FASTVIDEO_PY} — only the TAEHV preview decoders are missing." >&2
      echo "   This is usually a transient network failure reaching raw.githubusercontent.com; retry with Repair / Upgrade from the Video Gen runtime panel." >&2
      exit 1
    fi
    echo "⚠️  Decoder download attempt ${fastvideo_decoder_attempt} failed; retrying in 5s..." >&2
    sleep 5
    fastvideo_decoder_attempt=$(( fastvideo_decoder_attempt + 1 ))
  done
  echo "✅ FastVideo MLX runtime ready: ${FASTVIDEO_PY}"
fi

INSTALL_WAN22="${INSTALL_WAN22:-0}"
if [[ "$INSTALL_WAN22" == "1" ]]; then
  # MLX-Gen provides the validated Apple-Silicon Wan 2.2 TI2V-5B and A14B
  # q8 routes. This path runs only after the user chooses Install in Video Gen;
  # the regular PortOS install/update path never provisions it automatically.
  if ! have git; then
    echo "❌ INSTALL_WAN22=1 requires git." >&2
    exit 1
  fi
  # v0.25.0 exact commit, statically audited before integration. Keep the full
  # SHA so existing installs get an explicit, reproducible UI-driven upgrade.
  WAN22_AUDITED_REVISION="2452f0c12edcc8886eebf15772205ce9c417a618"
  WAN22_PIN="${WAN22_PIN:-$WAN22_AUDITED_REVISION}"
  require_mlx_video_profile "Wan 2.2 MLX" "$WAN22_PIN" "$WAN22_AUDITED_REVISION"
  WAN22_DIR="${HOME}/.portos/mlx-gen"
  WAN22_PY="${WAN22_DIR}/.venv/bin/python3"
  mkdir -p "${HOME}/.portos"
  if [[ ! -d "${WAN22_DIR}/.git" ]]; then
    echo "📦 Cloning MLX-Gen..."
    git clone --progress https://github.com/lpalbou/mlx-gen.git "${WAN22_DIR}"
  else
    echo "📦 Fetching MLX-Gen updates..."
    (cd "${WAN22_DIR}" && git fetch --progress origin)
  fi
  git_checkout_pin "${WAN22_DIR}" "${WAN22_PIN}"
  sync_locked_mlx_video "Wan 2.2 MLX" "$WAN22_DIR" "$WAN22_PY" "$WAN22_PIN" -e .
  probe_or_fail \
    "MLX-Gen synced but the Wan runtime import failed." \
    "Use Repair / Upgrade from the Video Gen runtime panel to retry." \
    "${WAN22_PY}" -c "import mflux.models.wan.cli.wan_generate"
  echo "✅ MLX-Gen Wan runtime ready: ${WAN22_PY}"
fi

INSTALL_MINIMAX_H3="${INSTALL_MINIMAX_H3:-0}"
if [[ "$INSTALL_MINIMAX_H3" == "1" ]]; then
  # PipeNetwork/minimax-h3-mlx is a source checkout rather than a wheel. Keep
  # both its commit and the complete Python dependency graph immutable; an MLX
  # or transformers drift on a ~100 GB model is expensive to diagnose after a
  # long render. This block is reached only from the explicit runtime Install /
  # Repair action (or the matching terminal opt-in), never from PortOS boot.
  if ! is_apple_silicon; then
    echo "❌ MiniMax H3 MLX requires an Apple-Silicon Mac." >&2
    exit 1
  fi
  if ! have git; then
    echo "❌ INSTALL_MINIMAX_H3=1 requires git." >&2
    exit 1
  fi

  MINIMAX_H3_PIN="${MINIMAX_H3_PIN:-fcd9e9b79a1d6018d91ac477c0968de1fa067e49}"
  MINIMAX_H3_DIR="${HOME}/.portos/minimax-h3-mlx"
  MINIMAX_H3_PY="${MINIMAX_H3_DIR}/.venv/bin/python3"
  MINIMAX_H3_LOCK="${SCRIPT_DIR}/requirements-minimax-h3-mlx.lock.txt"
  mkdir -p "${HOME}/.portos"
  if [[ ! -d "${MINIMAX_H3_DIR}/.git" ]]; then
    echo "📦 Cloning MiniMax H3 MLX..."
    git clone --progress https://github.com/PipeNetwork/minimax-h3-mlx.git "$MINIMAX_H3_DIR"
  else
    echo "📦 Fetching MiniMax H3 MLX updates..."
    git -C "$MINIMAX_H3_DIR" fetch --progress origin
  fi
  git_checkout_pin "$MINIMAX_H3_DIR" "$MINIMAX_H3_PIN"
  # This runtime imports directly from the checkout, so HEAD alone is not an
  # integrity guarantee: tracked edits or an untracked Python module inside
  # the package would execute ahead of the pinned source. Install / Repair is
  # an explicit user action, so restore and clean only the executable package
  # (never the whole checkout, where large model/output folders may live).
  git -C "$MINIMAX_H3_DIR" restore --source=HEAD --staged --worktree -- minimax_h3_mlx
  git -C "$MINIMAX_H3_DIR" clean -fd -- minimax_h3_mlx
  MINIMAX_H3_BASE_PY="$(portos_uv python find 3.11 2>/dev/null || true)"
  reset_universal_venv "${MINIMAX_H3_DIR}/.venv" "$MINIMAX_H3_BASE_PY"
  if [[ ! -x "$MINIMAX_H3_PY" ]]; then
    echo "📦 Creating MiniMax H3 MLX venv with Python 3.11..."
    portos_uv venv --python 3.11 "${MINIMAX_H3_DIR}/.venv"
  fi
  echo "📦 Syncing pinned MiniMax H3 MLX packages..."
  portos_uv pip sync --require-hashes --python "$MINIMAX_H3_PY" "$MINIMAX_H3_LOCK"
  pin_venv_arm64 "${MINIMAX_H3_DIR}/.venv"
  # --verify-seams is Install/Repair-only strictness: it also asserts the encoder
  # seams generate_minimax_h3.py patches, which the readiness probe deliberately
  # skips (a moved seam must not mark a text-only-capable runtime unready). That
  # message is then the one thing telling a pin bump apart from a broken sync, so
  # capture stderr instead of discarding it and show the tail — the exception
  # line, under whatever traceback preceded it.
  probe_or_fail \
    "MiniMax H3 MLX synced but its runtime probe failed." \
    "Use Repair / Upgrade from the Video Gen runtime panel to retry." \
    "$MINIMAX_H3_PY" "${SCRIPT_DIR}/minimax_h3_runtime_probe.py" "$MINIMAX_H3_DIR" --verify-seams
  echo "✅ MiniMax H3 MLX runtime ready: ${MINIMAX_H3_PY}"
  echo "   Weights remain uninstalled until you accept the model terms and choose Download in Video Gen."
fi

INSTALL_MERERUN="${INSTALL_MERERUN:-0}"
if [[ "$INSTALL_MERERUN" == "1" ]]; then
  if ! is_apple_silicon; then
    echo "❌ MiniMax H3 Ref2VA through mere.run requires an Apple-Silicon Mac." >&2
    exit 1
  fi
  for command_name in curl hdiutil shasum; do
    if ! have "$command_name"; then
      echo "❌ INSTALL_MERERUN=1 requires ${command_name}." >&2
      exit 1
    fi
  done

  MERE_RUN_VERSION="0.47.0"
  MERE_RUN_DMG_SHA256="91833e45c5c4eda019eafbbc4a634ca7399c3bfb431822aaaa994fb404e603e2"
  MERE_RUN_URL="https://github.com/sawfwair/mere-run/releases/download/v${MERE_RUN_VERSION}/MereRun-${MERE_RUN_VERSION}.dmg"
  MERE_RUN_DIR="${HOME}/.portos/mere-run"
  MERE_RUN_BIN="${MERE_RUN_DIR}/mere.run"
  MERE_RUN_TMP="$(mktemp -d "${TMPDIR:-/tmp}/portos-mere-run.XXXXXX")"
  MERE_RUN_DMG="${MERE_RUN_TMP}/MereRun-${MERE_RUN_VERSION}.dmg"
  MERE_RUN_MOUNT="${MERE_RUN_TMP}/mount"
  mkdir -p "$MERE_RUN_MOUNT"
  mere_run_cleanup() {
    hdiutil detach "$MERE_RUN_MOUNT" -quiet >/dev/null 2>&1 || true
    rm -rf -- "$MERE_RUN_TMP"
  }
  trap mere_run_cleanup EXIT

  echo "📦 Downloading signed mere.run v${MERE_RUN_VERSION} release..."
  curl --fail --location --progress-bar "$MERE_RUN_URL" --output "$MERE_RUN_DMG"
  echo "${MERE_RUN_DMG_SHA256}  ${MERE_RUN_DMG}" | shasum -a 256 --check
  hdiutil attach "$MERE_RUN_DMG" -nobrowse -readonly -mountpoint "$MERE_RUN_MOUNT" -quiet
  MERERUN_INSTALL_BIN_DEST="$MERE_RUN_BIN" bash "$MERE_RUN_MOUNT/.mere-run/install.sh"
  if [[ "$($MERE_RUN_BIN --version 2>/dev/null || true)" != "$MERE_RUN_VERSION" ]]; then
    echo "❌ mere.run installed, but its version does not match ${MERE_RUN_VERSION}." >&2
    exit 1
  fi
  hdiutil detach "$MERE_RUN_MOUNT" -quiet
  trap - EXIT
  rm -rf -- "$MERE_RUN_TMP"
  echo "✅ mere.run v${MERE_RUN_VERSION} ready: ${MERE_RUN_BIN}"
  echo "   Weights remain uninstalled until you accept the model terms and choose Download in Video Gen."
fi

INSTALL_MINIMAX_H3_CUDA="${INSTALL_MINIMAX_H3_CUDA:-0}"
if [[ "$INSTALL_MINIMAX_H3_CUDA" == "1" ]]; then
  # Reached only from explicit Install / Repair, never from PortOS boot.
  if is_macos; then
    echo "❌ MiniMax H3 CUDA needs an NVIDIA GPU. On Apple Silicon use INSTALL_MINIMAX_H3=1 (the MLX port) instead." >&2
    exit 1
  fi
  case "$(uname -m)" in
    x86_64|amd64|AMD64) ;;
    *) echo "❌ MiniMax H3 CUDA hash locks support x86_64 Windows/Linux only." >&2; exit 1 ;;
  esac
  if [[ "$TORCH_CUDA_INDEX" != "https://download.pytorch.org/whl/cu126" ]]; then
    echo "❌ MiniMax H3 CUDA is locked to cu126. Unset PORTOS_TORCH_CUDA_INDEX for this runtime; see docs/MINIMAX_H3_CUDA.md." >&2
    exit 1
  fi
  MINIMAX_H3_CUDA_DIR="${HOME}/.portos/minimax-h3-cuda"
  MINIMAX_H3_CUDA_VENV="${MINIMAX_H3_CUDA_DIR}/.venv"
  if is_windows; then
    MINIMAX_H3_CUDA_LOCK="${SCRIPT_DIR}/requirements-minimax-h3-cuda-windows.lock.txt"
  else
    MINIMAX_H3_CUDA_LOCK="${SCRIPT_DIR}/requirements-minimax-h3-cuda-linux.lock.txt"
  fi
  mkdir -p "${MINIMAX_H3_CUDA_DIR}"
  reset_universal_venv "$MINIMAX_H3_CUDA_VENV" "$PYTHON_BIN"
  # Locks target 3.11. Rebuild other minors and Conda bases whose DLL search
  # path can prevent the Windows CUDA torch wheel from loading.
  if venv_exists "$MINIMAX_H3_CUDA_VENV"; then
    MINIMAX_H3_CUDA_PY="$(venv_python "$MINIMAX_H3_CUDA_VENV")"
    if ! "$MINIMAX_H3_CUDA_PY" -c "import sys; from pathlib import Path; sys.exit(sys.version_info[:2] != (3, 11) or (Path(sys.base_prefix) / 'conda-meta').is_dir())"; then
      echo "♻️ Rebuilding MiniMax H3 CUDA with its locked Python 3.11..."
      portos_uv venv --clear --managed-python --python 3.11 "$MINIMAX_H3_CUDA_VENV"
    fi
  fi
  if ! venv_exists "$MINIMAX_H3_CUDA_VENV"; then
    echo "📦 Creating MiniMax H3 CUDA venv (Python 3.11)..."
    portos_uv venv --managed-python --python 3.11 "$MINIMAX_H3_CUDA_VENV"
  fi
  MINIMAX_H3_CUDA_PY="$(venv_python "$MINIMAX_H3_CUDA_VENV")"
  echo "📦 Syncing the hash-pinned MiniMax H3 CUDA runtime..."
  portos_uv pip sync --require-hashes --only-binary :all: --index-strategy unsafe-best-match --python "$MINIMAX_H3_CUDA_PY" "$MINIMAX_H3_CUDA_LOCK"
  pin_venv_arm64 "$MINIMAX_H3_CUDA_VENV"

  # Three separate ways this install can look complete and not be: a CPU-only
  # torch, a diffusers without the H3 integration, or a missing torchao. Check
  # all three here so the failure names itself, instead of surfacing hours later
  # as an ImportError inside a render. Same assertions as the runtime's
  # `importProbe` in server/services/videoGen/runtimes.js.
  if ! "$MINIMAX_H3_CUDA_PY" -c "import torch; from diffusers import MiniMaxH3Transformer3DModel; from diffusers.modular_pipelines.minimax_h3 import MiniMaxH3ImageReference; import torchao; assert torch.cuda.is_available(), 'no CUDA device'"; then
    echo "❌ MiniMax H3 CUDA installed but its readiness check failed (see the error above)." >&2
    echo "   A 'no CUDA device' assertion means torch cannot see your GPU; anything else means the" >&2
    echo "   diffusers pin does not carry the MiniMax-H3 integration. Use Repair from the Video Gen runtime panel." >&2
    exit 1
  fi
  echo "✅ MiniMax H3 CUDA runtime ready: ${MINIMAX_H3_CUDA_PY}"
  echo "   Weights remain uninstalled until you accept the model terms and choose Download in Video Gen."
  echo "   That download is ~144 GB, and rendering needs ~24 GB VRAM plus ~75 GB of system RAM for offloaded weights."
fi

INSTALL_LTX25_CUDA="${INSTALL_LTX25_CUDA:-0}"
if [[ "$INSTALL_LTX25_CUDA" == "1" ]]; then
  # Reached only from explicit Install / Repair, never from PortOS boot.
  if is_macos; then
    echo "❌ LTX-2.5 CUDA needs an NVIDIA GPU. On Apple Silicon use INSTALL_LTX25=1 (the MLX port) instead." >&2
    exit 1
  fi
  case "$(uname -m)" in
    x86_64|amd64|AMD64) ;;
    *) echo "❌ LTX-2.5 CUDA hash locks support x86_64 Windows/Linux only." >&2; exit 1 ;;
  esac
  LTX25_CUDA_TORCH_INDEX="${PORTOS_LTX25_CUDA_TORCH_INDEX:-https://download.pytorch.org/whl/cu132}"
  if [[ "$LTX25_CUDA_TORCH_INDEX" != "https://download.pytorch.org/whl/cu132" ]]; then
    echo "❌ LTX-2.5 CUDA is locked to cu132. Unset PORTOS_LTX25_CUDA_TORCH_INDEX for this runtime; see docs/LTX25_CUDA.md." >&2
    exit 1
  fi
  LTX25_CUDA_DIR="${HOME}/.portos/ltx-2.5-cuda"
  LTX25_CUDA_VENV="${LTX25_CUDA_DIR}/.venv"
  if is_windows; then
    LTX25_CUDA_LOCK="${SCRIPT_DIR}/requirements-ltx25-cuda-windows.lock.txt"
  else
    LTX25_CUDA_LOCK="${SCRIPT_DIR}/requirements-ltx25-cuda-linux.lock.txt"
  fi
  mkdir -p "${LTX25_CUDA_DIR}"
  reset_universal_venv "$LTX25_CUDA_VENV" "$PYTHON_BIN"
  # Locks target 3.11. Rebuild other minors and Conda bases whose DLL search
  # path can prevent the Windows CUDA torch wheel from loading.
  if venv_exists "$LTX25_CUDA_VENV"; then
    LTX25_CUDA_PY="$(venv_python "$LTX25_CUDA_VENV")"
    if ! "$LTX25_CUDA_PY" -c "import sys; from pathlib import Path; sys.exit(sys.version_info[:2] != (3, 11) or (Path(sys.base_prefix) / 'conda-meta').is_dir())"; then
      echo "♻️ Rebuilding LTX-2.5 CUDA with its locked Python 3.11..."
      portos_uv venv --clear --managed-python --python 3.11 "$LTX25_CUDA_VENV"
    fi
  fi
  if ! venv_exists "$LTX25_CUDA_VENV"; then
    echo "📦 Creating LTX-2.5 CUDA venv (Python 3.11)..."
    portos_uv venv --managed-python --python 3.11 "$LTX25_CUDA_VENV"
  fi
  LTX25_CUDA_PY="$(venv_python "$LTX25_CUDA_VENV")"
  echo "📦 Syncing the hash-pinned LTX-2.5 CUDA runtime..."
  # Only the two hash-verified LTX archives may build. Bootstrap their sole
  # backend from its own hash lock, then disable isolated build resolution.
  portos_uv pip install --require-hashes --only-binary :all: --no-deps --python "$LTX25_CUDA_PY" -r "${SCRIPT_DIR}/requirements-ltx25-cuda-build.lock.txt"
  portos_uv pip sync --require-hashes --only-binary :all: --no-binary ltx-core,ltx-pipelines --no-build-isolation --index-strategy unsafe-best-match --python "$LTX25_CUDA_PY" "$LTX25_CUDA_LOCK"
  pin_venv_arm64 "$LTX25_CUDA_VENV"

  probe_or_fail \
    "LTX-2.5 CUDA installed but its runtime probe failed." \
    "Check the CUDA torch and LTX package errors above, then use Repair in Video Gen." \
    "$LTX25_CUDA_PY" -c "import torch; import ltx_core, ltx_pipelines; from ltx_pipelines.distilled import DistilledPipeline; assert torch.cuda.is_available(), 'no CUDA device'"
  echo "✅ LTX-2.5 CUDA runtime ready: ${LTX25_CUDA_PY}"
  echo "   Weights remain uninstalled until you accept the LTX license and choose Download in Video Gen."
fi

INSTALL_WAN22_CUDA="${INSTALL_WAN22_CUDA:-0}"
if [[ "$INSTALL_WAN22_CUDA" == "1" ]]; then
  if is_macos; then
    echo "❌ Wan 2.2 CUDA needs an NVIDIA GPU. Use the Wan 2.2 MLX runtime on Apple Silicon." >&2
    exit 1
  fi
  case "$(uname -m)" in
    x86_64|amd64|AMD64) ;;
    *) echo "❌ Wan 2.2 CUDA hash locks support x86_64 Windows/Linux only." >&2; exit 1 ;;
  esac
  if [[ "$TORCH_CUDA_INDEX" != "https://download.pytorch.org/whl/cu126" ]]; then
    echo "❌ Wan 2.2 CUDA is locked to the cu126 stack. Unset PORTOS_TORCH_CUDA_INDEX for this runtime; see docs/WAN22_CUDA.md." >&2
    exit 1
  fi
  WAN22_CUDA_DIR="${HOME}/.portos/wan2.2-cuda"
  WAN22_CUDA_VENV="${WAN22_CUDA_DIR}/.venv"
  if is_windows; then
    WAN22_CUDA_LOCK="${SCRIPT_DIR}/requirements-wan22-cuda-windows.lock.txt"
  else
    WAN22_CUDA_LOCK="${SCRIPT_DIR}/requirements-wan22-cuda-linux.lock.txt"
  fi
  mkdir -p "$WAN22_CUDA_DIR"
  reset_universal_venv "$WAN22_CUDA_VENV" "$PYTHON_BIN"
  # Keep an existing standalone 3.11, but rebuild older minors and Conda bases
  # whose DLL search path can prevent CUDA torch from loading on Windows.
  if venv_exists "$WAN22_CUDA_VENV"; then
    WAN22_CUDA_PY="$(venv_python "$WAN22_CUDA_VENV")"
    if ! "$WAN22_CUDA_PY" -c "import sys; from pathlib import Path; sys.exit(sys.version_info[:2] != (3, 11) or (Path(sys.base_prefix) / 'conda-meta').is_dir())"; then
      echo "♻️ Rebuilding Wan 2.2 CUDA with its locked Python 3.11..."
      portos_uv venv --clear --managed-python --python 3.11 "$WAN22_CUDA_VENV"
    fi
  fi
  if ! venv_exists "$WAN22_CUDA_VENV"; then
    echo "📦 Creating Wan 2.2 CUDA venv (Python 3.11)..."
    portos_uv venv --managed-python --python 3.11 "$WAN22_CUDA_VENV"
  fi
  WAN22_CUDA_PY="$(venv_python "$WAN22_CUDA_VENV")"
  echo "📦 Syncing the hash-pinned Wan 2.2 CUDA runtime..."
  portos_uv pip sync --require-hashes --only-binary :all: --index-strategy unsafe-best-match --python "$WAN22_CUDA_PY" "$WAN22_CUDA_LOCK"
  pin_venv_arm64 "$WAN22_CUDA_VENV"
  probe_or_fail \
    "Wan 2.2 CUDA installed but its runtime probe failed." \
    "Check the CUDA torch errors above, then use Repair in Video Gen." \
    "$WAN22_CUDA_PY" -c "import torch, hf_xet; from diffusers import AutoencoderKLWan, WanPipeline; assert torch.cuda.is_available(), 'no CUDA device'"
  echo "✅ Wan 2.2 CUDA runtime ready: ${WAN22_CUDA_PY}"
  echo "   Weights remain uninstalled until Download is chosen in Video Gen."
fi

INSTALL_MUSICGEN="${INSTALL_MUSICGEN:-0}"
if [[ "$INSTALL_MUSICGEN" == "1" ]]; then
  # Local background-music generation for the pipeline audio stage (Phase
  # 4c.2). Meta's MusicGen runs on Apple Silicon via MLX, but the MLX
  # implementation lives in ml-explore/mlx-examples (`musicgen/`), which isn't
  # a pip package — so we clone the repo and build a sibling venv. The sidecar
  # `scripts/generate_musicgen.py` imports `MusicGen` from the clone;
  # server/lib/pythonSetup.js (resolveMusicgenPython) looks for python3 here.
  if ! is_apple_silicon; then
    echo "⚠️ INSTALL_MUSICGEN=1 is macOS / Apple-Silicon only (MLX). Skipping." >&2
  else
    if ! have git; then
      echo "❌ INSTALL_MUSICGEN=1 requires git." >&2
      exit 1
    fi
    MUSICGEN_VENV="${HOME}/.portos/venv-musicgen"
    MUSICGEN_PY="$MUSICGEN_VENV/bin/python3"
    MLX_EXAMPLES_DIR="${HOME}/.portos/mlx-examples"
    MLX_EXAMPLES_PIN="${MLX_EXAMPLES_PIN:-main}"
    mkdir -p "${HOME}/.portos"

    if [[ ! -d "${MLX_EXAMPLES_DIR}/.git" ]]; then
      echo "📦 Cloning ml-explore/mlx-examples → ${MLX_EXAMPLES_DIR}..."
      git clone --progress https://github.com/ml-explore/mlx-examples.git "${MLX_EXAMPLES_DIR}"
    fi
    # Pin to a known commit when MLX_EXAMPLES_PIN is set to a SHA; default
    # 'main' tracks HEAD (the musicgen example is stable, but a pin keeps new
    # installs reproducible — mirror of the LTX2_PIN pattern above).
    git -C "${MLX_EXAMPLES_DIR}" fetch --quiet origin
    git_checkout_pin "${MLX_EXAMPLES_DIR}" "${MLX_EXAMPLES_PIN}"

    reset_universal_venv "$MUSICGEN_VENV" "$PYTHON_BIN"
    if [[ ! -x "$MUSICGEN_PY" ]]; then
      echo "📦 Creating MusicGen venv at ${MUSICGEN_VENV}..."
      "$PYTHON_BIN" -m venv "$MUSICGEN_VENV"
    fi
    echo "📦 Installing MusicGen (MLX) packages into ${MUSICGEN_VENV}..."
    # Install only from the hash-pinned lock (scripts/requirements-musicgen-mlx.lock.txt):
    # no install-time resolution, so a new or compromised transitive release can't
    # land on the next Repair. Direct pins: scripts/requirements-musicgen-mlx.txt.
    # mlx + numpy run the model; transformers (<5 for MLX compat) + sentencepiece
    # provide the T5 text conditioner's tokenizer; scipy is imported by the
    # mlx-examples musicgen utils. torch is required because MusicGen.from_pretrained
    # loads the upstream PyTorch checkpoints (torch.load) before converting to MLX —
    # without it generation fails at model-load even though the class imports fine.
    # We write WAV via the stdlib `wave` module in the sidecar, so no soundfile dep.
    "$MUSICGEN_PY" -m pip install --require-hashes --no-deps -r "$SCRIPT_DIR/requirements-musicgen-mlx.lock.txt"
    pin_venv_arm64 "$MUSICGEN_VENV"
    # Verify BOTH that the class imports AND that torch loaded — the import alone
    # passed even when torch was missing, so install used to report ready and
    # then fail on the first generation.
    probe_or_fail \
      "MusicGen venv built but 'import torch; from musicgen import MusicGen' failed." \
      "Check that ${MLX_EXAMPLES_DIR}/musicgen exists and torch installed cleanly." \
      env "PORTOS_MUSICGEN_RUNTIME_DIR=${MLX_EXAMPLES_DIR}/musicgen" \
      "$MUSICGEN_PY" -c "import sys, os, torch; sys.path.insert(0, os.environ['PORTOS_MUSICGEN_RUNTIME_DIR']); from musicgen import MusicGen"
    echo "✅ MusicGen venv ready: $MUSICGEN_PY (runtime: ${MLX_EXAMPLES_DIR}/musicgen @ ${MLX_EXAMPLES_PIN:0:12})"
  fi
fi

INSTALL_AUDIOLDM2="${INSTALL_AUDIOLDM2:-0}"
if [[ "$INSTALL_AUDIOLDM2" == "1" ]]; then
  # Local long-form background-music generation for the pipeline audio stage
  # (Phase 4c.2, second backend alongside MusicGen). AudioLDM2 is a latent
  # diffusion text-to-audio model shipped in HuggingFace `diffusers` (a pip
  # package — no clone needed), so this is just a sibling torch venv. The sidecar
  # `scripts/generate_audioldm2.py` imports `AudioLDM2Pipeline` from diffusers;
  # server/lib/pythonSetup.js (resolveAudioldm2Python) discovers this venv.
  # Runs on Apple-Silicon MPS, CUDA, or CPU — not gated to macOS like MusicGen.
  # Git Bash on Windows creates Scripts/python.exe even though this is a bash
  # installer; venv_python keeps the installer aligned with the JS resolver.
  AUDIOLDM2_VENV="${HOME}/.portos/venv-audioldm2"
  if ! is_apple_silicon; then
    # Linux/Windows install only from a hash lock, which covers x86_64 with the
    # cu126 torch build (it also runs on CPU). Other hosts have no lock.
    if is_macos; then
      echo "❌ AudioLDM2 hash locks cover Apple Silicon and x86_64 Windows/Linux; Intel macOS is unsupported." >&2
      exit 1
    fi
    require_cuda_lock_host AudioLDM2 docs/AUDIOLDM2_CUDA.md
  fi
  mkdir -p "${HOME}/.portos"
  reset_universal_venv "$AUDIOLDM2_VENV" "$PYTHON_BIN"

  if is_apple_silicon; then
    if ! venv_exists "$AUDIOLDM2_VENV"; then
      echo "📦 Creating AudioLDM2 venv at ${AUDIOLDM2_VENV}..."
      "$PYTHON_BIN" -m venv "$AUDIOLDM2_VENV"
    fi
    AUDIOLDM2_PY="$(venv_python "$AUDIOLDM2_VENV")"
    echo "📦 Installing AudioLDM2 (diffusers) packages into ${AUDIOLDM2_VENV}..."
    # Apple Silicon installs only from the hash-pinned lock
    # (scripts/requirements-audioldm2-mlx.lock.txt): no install-time resolution,
    # so a new or compromised transitive release can't land on the next Repair.
    # Direct pins: scripts/requirements-audioldm2-mlx.txt.
    # The lock needs CPython 3.11+: its filelock fix for advisory GHSA-2g95-wg33-c5x2
    # (4.2.1) dropped 3.10, and 4.1.0, the last 3.10 release, is affected.
    if ! "$AUDIOLDM2_PY" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 11) else 1)'; then
      echo "❌ AudioLDM2 on Apple Silicon needs Python 3.11+; ${AUDIOLDM2_PY} is older." >&2
      echo "   Re-run with PYTHON_BIN pointing at a 3.11+ interpreter (e.g. 'brew install python@3.12')." >&2
      exit 1
    fi
    "$AUDIOLDM2_PY" -m pip install --require-hashes --no-deps -r "$SCRIPT_DIR/requirements-audioldm2-mlx.lock.txt"
  else
    # Direct pins: scripts/requirements-audioldm2-cuda.txt.
    sync_cuda_lock_venv AudioLDM2 "$AUDIOLDM2_VENV" requirements-audioldm2-cuda
    AUDIOLDM2_PY="$(venv_python "$AUDIOLDM2_VENV")"
  fi
  pin_venv_arm64 "$AUDIOLDM2_VENV"
  # Verify the pipeline class imports — a clean import means generation only
  # needs the one-time weight download, not a broken venv.
  probe_or_fail \
    "AudioLDM2 venv built but 'import torch; from diffusers import AudioLDM2Pipeline' failed." \
    "Check that torch + diffusers installed cleanly in ${AUDIOLDM2_VENV}." \
    "$AUDIOLDM2_PY" -c "import torch; from diffusers import AudioLDM2Pipeline"
  echo "✅ AudioLDM2 venv ready: $AUDIOLDM2_PY"
fi

INSTALL_ACESTEP="${INSTALL_ACESTEP:-0}"
if [[ "$INSTALL_ACESTEP" == "1" ]]; then
  # Local full-song generation for the Music studio (Phase 4 — third backend
  # alongside MusicGen + AudioLDM2). ACE-Step is a music FOUNDATION model that
  # takes a style/tags prompt AND lyrics and renders a structured song with
  # vocals. It installs as the `acestep` pip package (from git — no clone to
  # import from), so this is a sibling torch venv. The sidecar
  # `scripts/generate_acestep.py` imports `ACEStepPipeline` from acestep;
  # server/lib/pythonSetup.js (resolveAcestepPython) discovers this venv.
  # Runs on Apple-Silicon MPS, CUDA, or CPU. Git Bash on Windows creates
  # Scripts/python.exe, so resolve the venv path after it is created.
  # ACE-Step auto-downloads its 3.5B checkpoints to ~/.cache/ace-step on first
  # run, so this only builds the venv — no weights are fetched here.
  ACESTEP_VENV="${HOME}/.portos/venv-acestep"
  ACESTEP_PIN="${ACESTEP_PIN:-1bee4c9f5b43e30995f8d4d33b3919197ce1bd68}"
  ACESTEP_DIR="${HOME}/.portos/acestep"
  if ! is_apple_silicon; then
    # Linux/Windows install only from a hash lock, which covers x86_64 with the
    # cu126 torch build. Other hosts have no lock.
    if is_macos; then
      echo "❌ ACE-Step hash locks cover Apple Silicon and x86_64 Windows/Linux; Intel macOS is unsupported." >&2
      exit 1
    fi
    require_cuda_lock_host ACE-Step docs/ACESTEP_CUDA.md
  fi
  mkdir -p "${HOME}/.portos"
  reset_universal_venv "$ACESTEP_VENV" "$PYTHON_BIN"

  if is_apple_silicon; then
    if ! venv_exists "$ACESTEP_VENV"; then
      echo "📦 Creating ACE-Step venv at ${ACESTEP_VENV}..."
      "$PYTHON_BIN" -m venv "$ACESTEP_VENV"
    fi
    ACESTEP_PY="$(venv_python "$ACESTEP_VENV")"
    echo "📦 Installing ACE-Step into ${ACESTEP_VENV}..."
    # Apple Silicon installs only from the hash-pinned lock
    # (scripts/requirements-acestep-mlx.lock.txt): no install-time resolution,
    # so a new or compromised transitive release can't land on the next Repair.
    # Direct pins: scripts/requirements-acestep-mlx.txt.
    # The lock needs CPython 3.11+: its filelock fix for advisory GHSA-2g95-wg33-c5x2
    # dropped 3.10.
    if ! "$ACESTEP_PY" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 11) else 1)'; then
      echo "❌ ACE-Step on Apple Silicon needs Python 3.11+; ${ACESTEP_PY} is older." >&2
      echo "   Re-run with PYTHON_BIN pointing at a 3.11+ interpreter (e.g. 'brew install python@3.12')." >&2
      exit 1
    fi
    if [[ ! -d "${ACESTEP_DIR}/.git" ]]; then
      echo "📦 Cloning ace-step/ACE-Step..."
      git clone --progress https://github.com/ace-step/ACE-Step.git "${ACESTEP_DIR}"
    fi
    git_checkout_pin "${ACESTEP_DIR}" "${ACESTEP_PIN}"
    "$ACESTEP_PY" -m pip install --require-hashes --no-deps -r "$SCRIPT_DIR/requirements-acestep-mlx.lock.txt"
    "$ACESTEP_PY" -m pip install --no-deps --no-build-isolation "${ACESTEP_DIR}"
  else
    # Direct pins: scripts/requirements-acestep-cuda.txt. docopt and unidic-lite
    # publish only (hashed) source distributions, so exactly those two may build.
    # The acestep package is installed from the ACESTEP_PIN checkout with
    # --no-deps, like Apple Silicon: a git SHA cannot satisfy --require-hashes.
    sync_cuda_lock_venv ACE-Step "$ACESTEP_VENV" requirements-acestep-cuda --no-binary docopt --no-binary unidic-lite
    ACESTEP_PY="$(venv_python "$ACESTEP_VENV")"
    if [[ ! -d "${ACESTEP_DIR}/.git" ]]; then
      echo "📦 Cloning ace-step/ACE-Step..."
      git clone --progress https://github.com/ace-step/ACE-Step.git "${ACESTEP_DIR}"
    fi
    git_checkout_pin "${ACESTEP_DIR}" "${ACESTEP_PIN}"
    portos_uv pip install --no-deps --no-build-isolation --python "$ACESTEP_PY" "${ACESTEP_DIR}"
  fi
  pin_venv_arm64 "$ACESTEP_VENV"
  # Verify the pipeline class imports — a clean import means generation only
  # needs the one-time checkpoint download, not a broken venv.
  probe_or_fail \
    "ACE-Step venv built but 'import torch; from acestep.pipeline_ace_step import ACEStepPipeline' failed." \
    "Check that torch + the acestep package installed cleanly in ${ACESTEP_VENV}." \
    "$ACESTEP_PY" -c "import torch; from acestep.pipeline_ace_step import ACEStepPipeline"
  echo "✅ ACE-Step venv ready: $ACESTEP_PY"
fi

INSTALL_ACESTEP15="${INSTALL_ACESTEP15:-0}"
if [[ "$INSTALL_ACESTEP15" == "1" ]]; then
  # ACE-Step 1.5 is a separate architecture from v1. The package supplies the
  # multi-component pipeline whose DiT loads custom Transformers code with
  # trust_remote_code, so it must never share v1's `acestep` venv.
  ACESTEP15_VENV="${HOME}/.portos/venv-acestep15"
  ACESTEP15_PIN="${ACESTEP15_PIN:-dce621408bee8c31b4fcf4811682eb9359e1bc94}"
  ACESTEP15_DIR="${HOME}/.portos/acestep15"
  if ! is_apple_silicon; then
    # Linux/Windows install only from a hash lock, which covers x86_64 with the
    # cu126 torch build. Other hosts have no lock.
    if is_macos; then
      echo "❌ ACE-Step 1.5 hash locks cover Apple Silicon and x86_64 Windows/Linux; Intel macOS is unsupported." >&2
      exit 1
    fi
    require_cuda_lock_host "ACE-Step 1.5" docs/ACESTEP15_CUDA.md
  fi
  mkdir -p "${HOME}/.portos"
  reset_universal_venv "$ACESTEP15_VENV" "$PYTHON_BIN"

  if is_apple_silicon; then
    if ! venv_exists "$ACESTEP15_VENV"; then
      echo "📦 Creating ACE-Step 1.5 venv at ${ACESTEP15_VENV}..."
      "$PYTHON_BIN" -m venv "$ACESTEP15_VENV"
    fi
    ACESTEP15_PY="$(venv_python "$ACESTEP15_VENV")"
    echo "📦 Installing ACE-Step 1.5 into ${ACESTEP15_VENV}..."
    # Apple Silicon installs only from the hash-pinned lock
    # (scripts/requirements-acestep15-mlx.lock.txt): no install-time resolution,
    # so a new or compromised transitive release can't land on the next Repair.
    # Direct pins: scripts/requirements-acestep15-mlx.txt.
    # The lock needs CPython 3.11+: its filelock fix for advisory GHSA-2g95-wg33-c5x2
    # dropped 3.10.
    if ! "$ACESTEP15_PY" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 11) else 1)'; then
      echo "❌ ACE-Step 1.5 on Apple Silicon needs Python 3.11+; ${ACESTEP15_PY} is older." >&2
      echo "   Re-run with PYTHON_BIN pointing at a 3.11+ interpreter (e.g. 'brew install python@3.12')." >&2
      exit 1
    fi
    if [[ ! -d "${ACESTEP15_DIR}/.git" ]]; then
      echo "📦 Cloning ace-step/ACE-Step-1.5..."
      git clone --progress https://github.com/ace-step/ACE-Step-1.5.git "${ACESTEP15_DIR}"
    fi
    git_checkout_pin "${ACESTEP15_DIR}" "${ACESTEP15_PIN}"
    "$ACESTEP15_PY" -m pip install --require-hashes --no-deps -r "$SCRIPT_DIR/requirements-acestep15-mlx.lock.txt"
    "$ACESTEP15_PY" -m pip install --no-deps --no-build-isolation --ignore-requires-python "${ACESTEP15_DIR}"
  else
    # Direct pins: scripts/requirements-acestep15-cuda.txt. The package is
    # installed from the ACESTEP15_PIN checkout (the v0.1.8 release commit) with
    # --no-deps, like Apple Silicon: a git SHA cannot satisfy --require-hashes.
    # --no-deps also keeps the package's own cu128 torch pins from displacing the
    # shared cu126 lock.
    sync_cuda_lock_venv "ACE-Step 1.5" "$ACESTEP15_VENV" requirements-acestep15-cuda
    ACESTEP15_PY="$(venv_python "$ACESTEP15_VENV")"
    if [[ ! -d "${ACESTEP15_DIR}/.git" ]]; then
      echo "📦 Cloning ace-step/ACE-Step-1.5..."
      git clone --progress https://github.com/ace-step/ACE-Step-1.5.git "${ACESTEP15_DIR}"
    fi
    git_checkout_pin "${ACESTEP15_DIR}" "${ACESTEP15_PIN}"
    portos_uv pip install --no-deps --no-build-isolation --ignore-requires-python --python "$ACESTEP15_PY" "${ACESTEP15_DIR}"
  fi
  pin_venv_arm64 "$ACESTEP15_VENV"
  probe_or_fail \
    "ACE-Step 1.5 venv built but its Transformers runtime failed to import." \
    "Check that torch, transformers, and ACE-Step 1.5 installed cleanly in ${ACESTEP15_VENV}." \
    "$ACESTEP15_PY" -c "import torch; from transformers import AutoModel; from acestep.handler import AceStepHandler; from acestep.inference import GenerationConfig, GenerationParams, generate_music"
  echo "✅ ACE-Step 1.5 venv ready: $ACESTEP15_PY"
fi

INSTALL_MINIMAX_MUSIC3="${INSTALL_MINIMAX_MUSIC3:-0}"
if [[ "$INSTALL_MINIMAX_MUSIC3" == "1" ]]; then
  if is_macos; then
    echo "❌ MiniMax Music 3 CUDA needs an NVIDIA GPU. Use the Music 3 MLX runtime on Apple Silicon." >&2
    exit 1
  fi
  require_cuda_lock_host "MiniMax Music 3" docs/MINIMAX_MUSIC3_CUDA.md
  MINIMAX_MUSIC3_VENV="${HOME}/.portos/venv-minimax-music3"
  mkdir -p "${HOME}/.portos"
  reset_universal_venv "$MINIMAX_MUSIC3_VENV" "$PYTHON_BIN"
  sync_cuda_lock_venv "MiniMax Music 3" "$MINIMAX_MUSIC3_VENV" requirements-minimax-music3-cuda
  MINIMAX_MUSIC3_PY="$(venv_python "$MINIMAX_MUSIC3_VENV")"
  pin_venv_arm64 "$MINIMAX_MUSIC3_VENV"
  probe_or_fail \
    "MiniMax Music 3 CUDA installed but its runtime probe failed." \
    "Check the CUDA torch/import errors above, then use Repair in Music. Use standalone Python if Conda DLLs interfere." \
    "$MINIMAX_MUSIC3_PY" -c "import torch; from diffusers import ModularPipeline; from diffusers.modular_pipelines.minimax_music3 import MiniMaxMusic3Blocks; assert torch.cuda.is_available(), 'no CUDA device'"
  echo "✅ MiniMax Music 3 venv ready: $MINIMAX_MUSIC3_PY"
  echo "   Model weights (~29 GB) install separately from Music → Generate."
fi

INSTALL_MINIMAX_MUSIC3_MLX="${INSTALL_MINIMAX_MUSIC3_MLX:-0}"
if [[ "$INSTALL_MINIMAX_MUSIC3_MLX" == "1" ]]; then
  # Native MLX MiniMax Music 3 is intentionally a sibling of the CUDA
  # Diffusers runtime above: the packages have different dependency stacks and
  # the MLX model loader is Apple-Silicon-only. Model weights stay a separate,
  # explicit Music-studio download so installing a runtime never spends tens of
  # gigabytes without the user's consent.
  if ! is_apple_silicon; then
    echo "⚠️ INSTALL_MINIMAX_MUSIC3_MLX=1 is macOS / Apple-Silicon only. Skipping." >&2
  else
    MINIMAX_MUSIC3_MLX_VENV="${HOME}/.portos/venv-minimax-music3-mlx"
    mkdir -p "${HOME}/.portos"
    reset_universal_venv "$MINIMAX_MUSIC3_MLX_VENV" "$PYTHON_BIN"
    if ! venv_exists "$MINIMAX_MUSIC3_MLX_VENV"; then
      echo "📦 Creating MiniMax Music 3 MLX venv at ${MINIMAX_MUSIC3_MLX_VENV}..."
      "$PYTHON_BIN" -m venv "$MINIMAX_MUSIC3_MLX_VENV"
    fi
    MINIMAX_MUSIC3_MLX_PY="$(venv_python "$MINIMAX_MUSIC3_MLX_VENV")"
    echo "📦 Installing MiniMax Music 3 MLX packages into ${MINIMAX_MUSIC3_MLX_VENV}..."
    # Install only from the hash-pinned lock (scripts/requirements-minimax-music3-mlx.lock.txt):
    # no install-time resolution, so a new or compromised transitive release can't
    # land on the next Repair. Direct pins: scripts/requirements-minimax-music3-mlx.txt
    # (mlx-audio 0.5.0, the first release with the MiniMax Music 3 merge).
    "$MINIMAX_MUSIC3_MLX_PY" -m pip install --require-hashes --no-deps -r "$SCRIPT_DIR/requirements-minimax-music3-mlx.lock.txt"
    pin_venv_arm64 "$MINIMAX_MUSIC3_MLX_VENV"
    probe_or_fail \
      "MiniMax Music 3 MLX venv built but 'import mlx; from mlx_audio.music import load' failed." \
      "Check that mlx-audio installed cleanly in ${MINIMAX_MUSIC3_MLX_VENV}." \
      "$MINIMAX_MUSIC3_MLX_PY" -c "import mlx; from mlx_audio.music import load"
    echo "✅ MiniMax Music 3 MLX venv ready: $MINIMAX_MUSIC3_MLX_PY"
  fi
fi

INSTALL_MUSCRIPTOR="${INSTALL_MUSCRIPTOR:-0}"
if [[ "$INSTALL_MUSCRIPTOR" == "1" ]]; then
  # Local audio → MIDI transcription for the Rounds workbench + Music Video
  # parsing system. MuScriptor is a multi-instrument music-transcription model
  # (https://github.com/muscriptor/muscriptor) that installs as the
  # `muscriptor` pip package — it declares its own torch stack, so this is a
  # sibling venv kept apart from the music-generation piles. The sidecar
  # `scripts/transcribe_muscriptor.py` imports `TranscriptionModel` from
  # muscriptor; server/lib/pythonSetup.js (resolveMuscriptorPython) looks for
  # python3 here. Runs on Apple-Silicon MPS, CUDA, or CPU. Model weights
  # (small/medium/large) auto-download from HuggingFace on first transcription,
  # so this only builds the venv — no weights are fetched here. Weights are
  # CC BY-NC 4.0 (non-commercial).
  MUSCRIPTOR_VENV="${HOME}/.portos/venv-muscriptor"
  if ! is_apple_silicon; then
    # Linux/Windows install only from a hash lock, which covers x86_64 with the
    # cu126 torch build (it also runs on CPU). Other hosts have no lock.
    if is_macos; then
      echo "❌ MuScriptor hash locks cover Apple Silicon and x86_64 Windows/Linux; Intel macOS is unsupported." >&2
      exit 1
    fi
    require_cuda_lock_host MuScriptor docs/MUSCRIPTOR_CUDA.md
  fi
  mkdir -p "${HOME}/.portos"
  reset_universal_venv "$MUSCRIPTOR_VENV" "$PYTHON_BIN"

  if is_apple_silicon; then
    if ! venv_exists "$MUSCRIPTOR_VENV"; then
      echo "📦 Creating MuScriptor venv at ${MUSCRIPTOR_VENV}..."
      "$PYTHON_BIN" -m venv "$MUSCRIPTOR_VENV"
    fi
    MUSCRIPTOR_PY="$(venv_python "$MUSCRIPTOR_VENV")"
    echo "📦 Installing MuScriptor into ${MUSCRIPTOR_VENV} (pulls torch + audio deps)..."
    # Apple Silicon installs only from the hash-pinned lock
    # (scripts/requirements-muscriptor-mlx.lock.txt): no install-time resolution,
    # so a new or compromised transitive release can't land on the next Repair.
    # Direct pins: scripts/requirements-muscriptor-mlx.txt.
    # The lock needs CPython 3.11+: its filelock fix for advisory GHSA-2g95-wg33-c5x2
    # (4.2.1) dropped 3.10, and 4.1.0, the last 3.10 release, is affected.
    if ! "$MUSCRIPTOR_PY" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 11) else 1)'; then
      echo "❌ MuScriptor on Apple Silicon needs Python 3.11+; ${MUSCRIPTOR_PY} is older." >&2
      echo "   Re-run with PYTHON_BIN pointing at a 3.11+ interpreter (e.g. 'brew install python@3.12')." >&2
      exit 1
    fi
    "$MUSCRIPTOR_PY" -m pip install --require-hashes --no-deps -r "$SCRIPT_DIR/requirements-muscriptor-mlx.lock.txt"
  else
    # Direct pins: scripts/requirements-muscriptor-cuda.txt.
    sync_cuda_lock_venv MuScriptor "$MUSCRIPTOR_VENV" requirements-muscriptor-cuda
    MUSCRIPTOR_PY="$(venv_python "$MUSCRIPTOR_VENV")"
  fi
  pin_venv_arm64 "$MUSCRIPTOR_VENV"
  # Verify the model class imports — a clean import means transcription only
  # needs the one-time weight download, not a broken venv.
  probe_or_fail \
    "MuScriptor venv built but 'from muscriptor import TranscriptionModel' failed." \
    "Check that the muscriptor package installed cleanly in ${MUSCRIPTOR_VENV}." \
    "$MUSCRIPTOR_PY" -c "from muscriptor import TranscriptionModel"
  echo "✅ MuScriptor venv ready: $MUSCRIPTOR_PY"
fi

INSTALL_FLUX2="${INSTALL_FLUX2:-$DEFAULT_INSTALL_FLUX2}"

if [[ "$INSTALL_FLUX2" == "1" ]]; then
  # FLUX.2-klein needs torch>=2.5 + diffusers + sdnq + optimum-quanto. Mixing
  # those into the mflux pip --user pile (mflux pulls older torch) is fragile,
  # so we use a sibling venv. server/lib/pythonSetup.js looks for this venv's
  # interpreter when the active model has runner=='flux2'.
  # Every platform installs only from a hash-pinned lock: no install-time
  # resolution, so a new or compromised transitive release can't land on the
  # next Repair. diffusers 0.42.1 is a tagged release carrying Flux2KleinPipeline
  # + QwenImage21Pipeline and sdnq is on PyPI, so no git source (which cannot
  # satisfy --require-hashes) is needed. Every run syncs the lock — a venv built
  # before the locks existed imports fine yet holds unpinned, unhashed packages,
  # and syncing a lock the venv already matches is a no-op. (FLUX2_FORCE_REINSTALL
  # is still accepted, but redundant.)
  FLUX2_VENV="${HOME}/.portos/venv-flux2"
  if ! is_apple_silicon; then
    # Linux/Windows hash locks cover x86_64 with the cu126 torch build (it also
    # runs on CPU). Other hosts have no lock.
    if is_macos; then
      echo "❌ FLUX.2 hash locks cover Apple Silicon and x86_64 Windows/Linux; Intel macOS is unsupported." >&2
      exit 1
    fi
    require_cuda_lock_host FLUX.2 docs/FLUX2_CUDA.md
  fi
  mkdir -p "${HOME}/.portos"

  if is_apple_silicon; then
    # Prefer a base outside the venv. An activated universal venv is the first
    # python3 on PATH; deleting it and then calling that path fails the rebuild.
    # reset also refuses when the only interpreter lives inside the venv.
    if ! FLUX2_BASE_PY="$(newest_supported_python "$FLUX2_VENV")" \
        && ! FLUX2_BASE_PY="$(newest_supported_python)"; then
      echo "❌ FLUX.2 needs Python 3.10+ to build its venv; \`$PYTHON_BIN\` is older and no newer python3.NN is on PATH." >&2
      echo "   Install one (e.g. 'brew install python@3.12' or 'uv python install 3.12'), then re-run with PYTHON_BIN pointing at it." >&2
      exit 1
    fi
    reset_universal_venv "$FLUX2_VENV" "$FLUX2_BASE_PY"
    # A venv left behind by an earlier run against a too-old base can never
    # install these packages, and `python -m venv` reuses it silently — so every
    # retry would fail the same way. Rebuild it instead of pip-ing into it.
    if venv_exists "$FLUX2_VENV" && ! python_at_least_310 "$(venv_python "$FLUX2_VENV")"; then
      echo "♻️  FLUX.2 venv at ${FLUX2_VENV} predates Python 3.10 — recreating it..."
      "$FLUX2_BASE_PY" -m venv --clear "$FLUX2_VENV"
    elif ! venv_exists "$FLUX2_VENV"; then
      echo "📦 Creating FLUX.2 venv at ${FLUX2_VENV} from ${FLUX2_BASE_PY}..."
      "$FLUX2_BASE_PY" -m venv "$FLUX2_VENV"
    fi
    FLUX2_PY="$(venv_python "$FLUX2_VENV")"
    echo "📦 Installing FLUX.2 packages into $FLUX2_VENV..."
    # Direct pins: scripts/requirements-flux2-mlx.txt.
    # The lock needs CPython 3.11+: its filelock fix for advisory GHSA-2g95-wg33-c5x2
    # (4.2.1) dropped 3.10, and 4.1.0, the last 3.10 release, is affected.
    if ! "$FLUX2_PY" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 11) else 1)'; then
      echo "❌ FLUX.2 on Apple Silicon needs Python 3.11+; ${FLUX2_PY} is older." >&2
      echo "   Re-run with PYTHON_BIN pointing at a 3.11+ interpreter (e.g. 'brew install python@3.12')." >&2
      exit 1
    fi
    "$FLUX2_PY" -m pip install --require-hashes --no-deps -r "$SCRIPT_DIR/requirements-flux2-mlx.lock.txt"
  else
    # Direct pins: scripts/requirements-flux2-cuda.txt.
    sync_cuda_lock_venv FLUX.2 "$FLUX2_VENV" requirements-flux2-cuda
    FLUX2_PY="$(venv_python "$FLUX2_VENV")"
  fi
  pin_venv_arm64 "$FLUX2_VENV"
  probe_or_fail \
    "FLUX.2 venv built but 'from diffusers import Flux2KleinPipeline, QwenImage21Pipeline' failed." \
    "Try: INSTALL_FLUX2=1 bash scripts/setup-image-video.sh (re-syncs the hash-pinned lock)" \
    "$FLUX2_PY" -c "from diffusers import Flux2KleinPipeline, QwenImage21Pipeline"
  echo "✅ FLUX.2 venv ready: $FLUX2_PY"
fi

# ffmpeg — required for thumbnails, last-frame extraction, stitch, and the
# Ref2VA continuity wrapper. Its distribution also provides ffprobe.
if ! have ffmpeg || ! have ffprobe; then
  if is_macos && have brew; then
    echo "📦 brew install ffmpeg"
    brew install ffmpeg
  else
    echo "⚠️ ffmpeg not on PATH and could not auto-install — install ffmpeg yourself for video features."
  fi
fi

if [[ "$INSTALL_MERERUN" == "1" ]]; then
  MISSING_REF2VA_TOOLS=()
  for command_name in ffmpeg ffprobe; do
    if ! have "$command_name"; then MISSING_REF2VA_TOOLS+=("$command_name"); fi
  done
  if (( ${#MISSING_REF2VA_TOOLS[@]} > 0 )); then
    echo "❌ MiniMax H3 Ref2VA requires both ffmpeg and ffprobe; missing: ${MISSING_REF2VA_TOOLS[*]}." >&2
    echo "   Install ffmpeg (for example, 'brew install ffmpeg') and retry from the Video Gen runtime panel." >&2
    exit 1
  fi
fi

echo ""
echo "✅ Image/video stack ready."
if python_required; then
  PYTHON_PATH="$(command -v "$PYTHON_BIN")"
  echo "   Python:    $PYTHON_PATH"
else
  echo "   Python:    not required for this mere.run-only install"
fi
echo "   HF cache:  ~/.cache/huggingface (HF default)"
echo "   LoRAs:     ${PORTOS_DATA}/loras"
echo "   Videos:    ${PORTOS_DATA}/videos"
if [[ "$INSTALL_LTX2" == "1" ]]; then
  echo "   LTX-2.3:   ${HOME}/.portos/ltx-2-mlx/.venv/bin/python3 (separate venv, dgrauet pipeline @ ${LTX2_PIN:0:12})"
fi
if [[ "$INSTALL_LTX25" == "1" ]]; then
  echo "   LTX-2.5:   ${HOME}/.portos/ltx-2.5-mlx/.venv/bin/python3 (MrMofer ltx25 fork @ ${LTX25_PIN:0:12})"
fi
if [[ "$INSTALL_FASTVIDEO" == "1" ]]; then
  echo "   FastVideo MLX: ${HOME}/.portos/fastvideo/.venv/bin/python3 (FastVideo @ ${FASTVIDEO_PIN:0:12})"
fi
if [[ "$INSTALL_LTX25_CUDA" == "1" ]]; then
  echo "   LTX-2.5 CUDA: ${HOME}/.portos/ltx-2.5-cuda/.venv (official streamed PyTorch runtime)"
fi
if [[ "$INSTALL_WAN22_CUDA" == "1" ]]; then
  echo "   Wan 2.2 CUDA: ${HOME}/.portos/wan2.2-cuda/.venv (official Diffusers runtime)"
fi
if [[ "$INSTALL_WAN22" == "1" ]]; then
  echo "   Wan 2.2:  ${HOME}/.portos/mlx-gen/.venv/bin/python3 (MLX-Gen @ ${WAN22_PIN:0:12})"
  echo "              Weights remain uninstalled until Download is chosen in Video Gen."
fi
if [[ "$INSTALL_MINIMAX_H3" == "1" ]]; then
  echo "   MiniMax H3: ${HOME}/.portos/minimax-h3-mlx/.venv/bin/python3 (MLX port @ ${MINIMAX_H3_PIN:0:12})"
  echo "                Weights remain uninstalled until accepted and downloaded in Video Gen."
fi
if [[ "$INSTALL_MERERUN" == "1" ]]; then
  echo "   MiniMax H3 Ref2VA: ${HOME}/.portos/mere-run/mere.run (mere.run v${MERE_RUN_VERSION})"
  echo "                       Weights remain uninstalled until accepted and downloaded in Video Gen."
fi
if [[ "$INSTALL_MUSICGEN" == "1" ]] && is_apple_silicon; then
  echo "   MusicGen:  ${HOME}/.portos/venv-musicgen/bin/python3 (separate venv, MLX runtime @ ${HOME}/.portos/mlx-examples/musicgen)"
fi
if [[ "$INSTALL_MINIMAX_MUSIC3_MLX" == "1" ]] && is_apple_silicon; then
  echo "   MiniMax Music 3 MLX: ${MINIMAX_MUSIC3_MLX_PY} (separate venv, mlx-audio; weights install separately in Music)"
fi
if [[ "$INSTALL_AUDIOLDM2" == "1" ]]; then
  echo "   AudioLDM2: ${AUDIOLDM2_PY} (separate venv, diffusers — long-form audio)"
fi
if [[ "$INSTALL_ACESTEP" == "1" ]]; then
  echo "   ACE-Step:  ${ACESTEP_PY} (separate venv, acestep — full song + vocals)"
fi
if [[ "$INSTALL_ACESTEP15" == "1" ]]; then
  echo "   ACE-Step 1.5: ${ACESTEP15_PY} (separate venv, Transformers — full song + vocals)"
fi
if [[ "$INSTALL_MUSCRIPTOR" == "1" ]]; then
  echo "   MuScriptor: ${MUSCRIPTOR_PY} (separate venv, muscriptor — audio → MIDI)"
fi
if [[ "$INSTALL_FLUX2" == "1" ]]; then
  echo "   FLUX.2:    ${FLUX2_PY} (separate venv)"
  echo "   Z-Image:   reuses the FLUX.2 venv (Apache 2.0, no HF login needed)"
  echo "   ERNIE:     reuses the FLUX.2 venv (Apache 2.0, no HF login needed)"
  echo ""
  echo "⚠️  FLUX.2-klein needs HF auth: accept the license at"
  echo "    https://huggingface.co/black-forest-labs/FLUX.2-klein-4B"
  echo "    then save the Hugging Face token in PortOS Media Generation Settings."
fi
echo ""
if [[ "$ANY_BYOV" == *[!0]* ]]; then
  echo "PortOS auto-discovers the requested runtime; no Python path or other manual configuration is needed."
else
  echo "Set this Python path in PortOS Settings → Image Gen → Local."
fi
