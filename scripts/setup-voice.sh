#!/usr/bin/env bash
# Bootstrap local voice stack: whisper.cpp (STT) + active TTS backend.
# Safe to re-run: installs only what's missing, downloads only what's missing.
#
# Env overrides:
#   STT_ENGINE      'whisper' (default) | 'web-speech' — browser-native STT
#                   skips whisper-cpp install + model download entirely
#   MODEL_NAME      Whisper GGUF to fetch (default: ggml-base.en.bin)
#   VOICE_NAME      Piper voice name      (default: en_GB-jenny_dioco-medium) — only used when TTS_ENGINE=piper
#   TTS_ENGINE      'piper' (default) | 'qwen3-tts'
#   INSTALL_COREML  '1' to download CoreML encoder for Whisper on macOS (default: 0)
#
# Models live under ~/.portos/voice/{models,voices}/.
#
# Model downloads are staged to a unique temp sibling, validated, then promoted
# with an atomic rename; a `<asset>.portos-complete.json` receipt (sizes +
# sha256, see server/lib/voiceModelAssets.js) is written only after the whole
# asset (for Piper: BOTH the .onnx and its .json) is in place. A file without a
# valid receipt is repaired on the next run — existence alone never counts.
set -euo pipefail

VOICE_HOME="${HOME}/.portos/voice"
MODELS_DIR="${VOICE_HOME}/models"
VOICES_DIR="${VOICE_HOME}/voices"
MODEL_NAME="${MODEL_NAME:-ggml-base.en.bin}"
VOICE_NAME="${VOICE_NAME:-en_GB-jenny_dioco-medium}"
TTS_ENGINE="${TTS_ENGINE:-piper}"
STT_ENGINE="${STT_ENGINE:-whisper}"
INSTALL_COREML="${INSTALL_COREML:-0}"

mkdir -p "$MODELS_DIR" "$VOICES_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Unique temp siblings of the final path, removed on any exit so a failed or
# interrupted transfer never leaves a partial file behind.
STAGED_FILES=()
cleanup_staged() { if ((${#STAGED_FILES[@]})); then rm -f "${STAGED_FILES[@]}"; fi; }
trap cleanup_staged EXIT

# Completion contract shared with the server and setup-voice.ps1.
asset() { node "${SCRIPT_DIR}/voice-asset.js" "$@"; }

# Download $1 into a fresh temp sibling of $2; the path is left in STAGED_TMP.
# Global rather than echoed: command substitution would run in a subshell and
# lose the STAGED_FILES registration the EXIT cleanup depends on.
download_staged() {
  local url="$1" final="$2"
  STAGED_TMP="$(mktemp "${final}.part.XXXXXX")"
  STAGED_FILES+=("$STAGED_TMP")
  curl --fail --location --progress-bar "$url" -o "$STAGED_TMP"
  if [[ ! -s "$STAGED_TMP" ]]; then
    echo "❌ Empty download from $url" >&2
    exit 1
  fi
}

# Content-Length of a remote file, or empty when it cannot be determined (offline,
# unknown name). The last header wins so a redirect hop's own length is ignored.
remote_size() {
  { curl --fail --location --silent --head "$1" 2>/dev/null || true; } \
    | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n }'
}
have() { command -v "$1" >/dev/null 2>&1; }
is_macos() { [[ "$(uname -s)" == "Darwin" ]]; }

install_brew_pkg() {
  local pkg="$1"
  if ! have brew; then
    echo "❌ Homebrew not found. Install from https://brew.sh then re-run." >&2
    exit 1
  fi
  echo "📦 brew install $pkg"
  brew install "$pkg"
}

# whisper.cpp provides whisper-cli + whisper-server binaries. Skip entirely
# when STT runs in the browser via Web Speech — no server-side STT needed.
if [[ "$STT_ENGINE" == "whisper" ]]; then
  if ! have whisper-server; then
    install_brew_pkg whisper-cpp
  fi
else
  echo "ℹ️  STT_ENGINE=${STT_ENGINE} — skipping whisper-cpp install and model download"
fi

# piper TTS binary (only when active engine uses it)
# Not available via Homebrew — download pre-built binary + phonemize libs from
# GitHub releases. The piper binary links against libespeak-ng, libpiper_phonemize,
# and libonnxruntime at specific versions bundled in the piper-phonemize release.
PIPER_DIR="${VOICE_HOME}/piper"
PIPER_LIB="${PIPER_DIR}/lib"
if [[ "$TTS_ENGINE" == "piper" ]]; then
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "$OS/$ARCH" in
    darwin/x86_64) OS="macos"; ARCH="x64" ;;
    darwin/arm64|darwin/aarch64) OS="macos"; ARCH="aarch64" ;;
    linux/x86_64) ARCH="x86_64" ;;
    linux/arm64|linux/aarch64) ARCH="aarch64" ;;
    *)
      echo "❌ Unsupported Piper platform: ${OS}/${ARCH}" >&2
      exit 1
      ;;
  esac

  if [[ ! -x "${PIPER_DIR}/piper" ]]; then
    PIPER_VERSION="2023.11.14-2"
    TAR="piper_${OS}_${ARCH}.tar.gz"
    URL="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${TAR}"
    echo "⬇️  Piper TTS → ${PIPER_DIR}/"
    mkdir -p "${PIPER_DIR}"
    curl --fail --location --progress-bar "$URL" | tar xz -C "${VOICE_HOME}"
    chmod +x "${PIPER_DIR}/piper" 2>/dev/null || true
  fi

  # Companion dylibs (espeak-ng, piper_phonemize, onnxruntime) from piper-phonemize
  if [[ ! -f "${PIPER_LIB}/libpiper_phonemize.1.dylib" ]] && [[ ! -f "${PIPER_LIB}/libpiper_phonemize.so.1" ]]; then
    PHONEMIZE_VERSION="2023.11.14-4"
    PTTAR="piper-phonemize_${OS}_${ARCH}.tar.gz"
    PTURL="https://github.com/rhasspy/piper-phonemize/releases/download/${PHONEMIZE_VERSION}/${PTTAR}"
    echo "⬇️  Piper libs → ${PIPER_LIB}/"
    TMPDIR_PT="$(mktemp -d)"
    curl --fail --location --progress-bar "$PTURL" | tar xz -C "$TMPDIR_PT"
    mkdir -p "${PIPER_LIB}"
    # Copy whichever extension is present; let one pattern miss without aborting.
    cp "$TMPDIR_PT"/piper-phonemize/lib/*.dylib "${PIPER_LIB}/" 2>/dev/null || true
    cp "$TMPDIR_PT"/piper-phonemize/lib/*.so "${PIPER_LIB}/" 2>/dev/null || true
    rm -rf "$TMPDIR_PT"
  fi
fi

# Whisper model (GGUF) — only when whisper engine is active.
ensure_whisper_model() {
  local path="${MODELS_DIR}/${MODEL_NAME}"
  local url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}"
  local state want have
  state="$(asset state whisper "$path")"
  if [[ "$state" == "verified" ]]; then
    return 0
  fi
  if [[ "$state" == "unverified" ]]; then
    # Installed before completion receipts (or user-supplied). A partial transfer
    # looks identical to a complete file here, so compare against the remote
    # size: adopt a match, replace a mismatch, and leave the file alone when the
    # remote size cannot be read — never discard a model on a guess.
    want="$(remote_size "$url")"
    have="$(wc -c < "$path" | tr -d ' ')"
    if [[ -z "$want" ]]; then
      echo "⚠️  Cannot verify existing Whisper model (remote size unavailable) — leaving ${path} as is" >&2
      return 0
    fi
    if [[ "$want" == "$have" ]]; then
      asset receipt whisper "$path"
      return 0
    fi
    echo "⚠️  Existing Whisper model is ${have} bytes, expected ${want} — re-downloading" >&2
  fi
  echo "⬇️  Whisper model → ${path}"
  download_staged "$url" "$path"
  mv -f "$STAGED_TMP" "$path"
  asset receipt whisper "$path"
}
if [[ "$STT_ENGINE" == "whisper" ]]; then
  ensure_whisper_model
fi

# CoreML encoder companion (macOS only) — 2–3× faster STT on Apple Silicon.
# Pairs with `<base>.bin` as `<base>-encoder.mlmodelc/`. whisper.cpp loads it
# automatically when present.
if [[ "$STT_ENGINE" == "whisper" && "$INSTALL_COREML" == "1" ]] && is_macos; then
  ENCODER_BASE="${MODEL_NAME%.bin}"
  ENCODER_DIR="${MODELS_DIR}/${ENCODER_BASE}-encoder.mlmodelc"
  ENCODER_ZIP="${MODELS_DIR}/${ENCODER_BASE}-encoder.mlmodelc.zip"
  if [[ ! -d "${ENCODER_DIR}" ]]; then
    echo "⬇️  CoreML encoder → ${ENCODER_DIR}"
    curl --fail --location --progress-bar \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${ENCODER_BASE}-encoder.mlmodelc.zip" \
      -o "${ENCODER_ZIP}"
    (cd "${MODELS_DIR}" && unzip -q -o "${ENCODER_ZIP}" && rm -f "${ENCODER_ZIP}")
  fi
fi

# Piper voice (ONNX + JSON sidecar). Only when active engine uses it.
# Voice names encode path: en_US-ryan-high  →  en/en_US/ryan/high/
# Both halves are staged and validated before either is promoted, so a failed
# replacement leaves the previous (complete) pair untouched.
ONNX_PATH="${VOICES_DIR}/${VOICE_NAME}.onnx"
JSON_PATH="${VOICES_DIR}/${VOICE_NAME}.onnx.json"
ensure_piper_voice() {
  local state locale lang_ rest speaker quality base onnx_tmp json_tmp
  state="$(asset state piper "$ONNX_PATH")"
  if [[ "$state" == "verified" ]]; then
    return 0
  fi
  if [[ "$state" == "unverified" ]]; then
    # Pair predates receipts. The old script fetched the sidecar only after the
    # ONNX finished, so a parseable sidecar next to a non-empty ONNX is a
    # complete pair — adopt it without touching the network.
    asset receipt piper "$ONNX_PATH"
    return 0
  fi
  locale="${VOICE_NAME%%-*}"       # en_US
  lang_="${locale%%_*}"            # en
  rest="${VOICE_NAME#*-}"          # ryan-high
  speaker="${rest%-*}"             # ryan
  quality="${rest##*-}"            # high
  base="https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang_}/${locale}/${speaker}/${quality}"
  echo "⬇️  Piper voice → ${ONNX_PATH}"
  download_staged "${base}/${VOICE_NAME}.onnx" "$ONNX_PATH"
  onnx_tmp="$STAGED_TMP"
  download_staged "${base}/${VOICE_NAME}.onnx.json" "$JSON_PATH"
  json_tmp="$STAGED_TMP"
  if ! asset check-config "$json_tmp"; then
    echo "❌ Downloaded Piper config for ${VOICE_NAME} is not a valid voice config" >&2
    exit 1
  fi
  mv -f "$onnx_tmp" "$ONNX_PATH"
  mv -f "$json_tmp" "$JSON_PATH"
  asset receipt piper "$ONNX_PATH"
}
if [[ "$TTS_ENGINE" == "piper" ]]; then
  ensure_piper_voice
fi

echo "✅ Voice stack ready"
if [[ "$STT_ENGINE" == "whisper" ]]; then
  echo "   whisper-server: $(command -v whisper-server || echo '<not installed>')"
  echo "   stt model:      ${MODELS_DIR}/${MODEL_NAME}"
  if [[ "$INSTALL_COREML" == "1" ]] && is_macos; then
    echo "   coreml encoder: ${MODELS_DIR}/${MODEL_NAME%.bin}-encoder.mlmodelc/"
  fi
else
  echo "   stt engine:     ${STT_ENGINE} (browser-native, no server provisioning)"
fi
echo "   tts engine:     ${TTS_ENGINE}"
if [[ "$TTS_ENGINE" == "piper" ]]; then
  echo "   piper:          ${PIPER_DIR}/piper"
  echo "   piper voice:    ${VOICES_DIR}/${VOICE_NAME}.onnx"
else
  echo "   Qwen3 models: managed in Settings → Voice"
fi
