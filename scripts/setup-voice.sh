#!/usr/bin/env bash
# Bootstrap local voice stack: whisper.cpp (STT) + active TTS backend.
# Safe to re-run: installs only what's missing, downloads only what's missing.
#
# Env overrides:
#   MODEL_NAME      Whisper GGUF to fetch (default: ggml-base.en.bin)
#   VOICE_NAME      Piper voice name      (default: en_GB-jenny_dioco-medium) — only used when TTS_ENGINE=piper
#   TTS_ENGINE      'kokoro' (default) | 'piper'
#   INSTALL_COREML  '1' to download CoreML encoder for Whisper on macOS (default: 0)
#
# Models live under ~/.portos/voice/{models,voices}/. Kokoro models are managed
# automatically by transformers.js under ~/.cache/huggingface/.

set -euo pipefail

VOICE_HOME="${HOME}/.portos/voice"
MODELS_DIR="${VOICE_HOME}/models"
VOICES_DIR="${VOICE_HOME}/voices"
MODEL_NAME="${MODEL_NAME:-ggml-base.en.bin}"
VOICE_NAME="${VOICE_NAME:-en_GB-jenny_dioco-medium}"
TTS_ENGINE="${TTS_ENGINE:-kokoro}"
INSTALL_COREML="${INSTALL_COREML:-0}"

mkdir -p "$MODELS_DIR" "$VOICES_DIR"

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

# whisper.cpp provides whisper-cli + whisper-server binaries
if ! have whisper-server; then
  install_brew_pkg whisper-cpp
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
  [[ "$OS" == "darwin" ]] && OS="macos"
  [[ "$ARCH" == "arm64" ]] && ARCH="aarch64"
  [[ "$ARCH" == "x86_64" ]] && ARCH="x64"

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
    cp "$TMPDIR_PT"/piper-phonemize/lib/*.dylib "$TMPDIR_PT"/piper-phonemize/lib/*.so 2>/dev/null "${PIPER_LIB}/" || true
    rm -rf "$TMPDIR_PT"
  fi
fi

# Whisper model (GGUF)
if [[ ! -f "${MODELS_DIR}/${MODEL_NAME}" ]]; then
  echo "⬇️  Whisper model → ${MODELS_DIR}/${MODEL_NAME}"
  curl --fail --location --progress-bar \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}" \
    -o "${MODELS_DIR}/${MODEL_NAME}"
fi

# CoreML encoder companion (macOS only) — 2–3× faster STT on Apple Silicon.
# Pairs with `<base>.bin` as `<base>-encoder.mlmodelc/`. whisper.cpp loads it
# automatically when present.
if [[ "$INSTALL_COREML" == "1" ]] && is_macos; then
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
if [[ "$TTS_ENGINE" == "piper" ]]; then
  ONNX_PATH="${VOICES_DIR}/${VOICE_NAME}.onnx"
  JSON_PATH="${VOICES_DIR}/${VOICE_NAME}.onnx.json"
  if [[ ! -f "${ONNX_PATH}" ]]; then
    LOCALE="${VOICE_NAME%%-*}"       # en_US
    LANG_="${LOCALE%%_*}"            # en
    REST="${VOICE_NAME#*-}"          # ryan-high
    SPEAKER="${REST%-*}"             # ryan
    QUALITY="${REST##*-}"            # high
    BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/${LANG_}/${LOCALE}/${SPEAKER}/${QUALITY}"
    echo "⬇️  Piper voice → ${ONNX_PATH}"
    curl --fail --location --progress-bar "${BASE}/${VOICE_NAME}.onnx"      -o "${ONNX_PATH}"
    curl --fail --location --progress-bar "${BASE}/${VOICE_NAME}.onnx.json" -o "${JSON_PATH}"
  fi
fi

echo "✅ Voice stack ready"
echo "   whisper-server: $(command -v whisper-server)"
echo "   stt model:      ${MODELS_DIR}/${MODEL_NAME}"
if [[ "$INSTALL_COREML" == "1" ]] && is_macos; then
  echo "   coreml encoder: ${MODELS_DIR}/${MODEL_NAME%.bin}-encoder.mlmodelc/"
fi
echo "   tts engine:     ${TTS_ENGINE}"
if [[ "$TTS_ENGINE" == "piper" ]]; then
  echo "   piper:          ${PIPER_DIR}/piper"
  echo "   piper voice:    ${VOICES_DIR}/${VOICE_NAME}.onnx"
else
  echo "   kokoro models:  managed by transformers.js (~/.cache/huggingface/)"
fi
