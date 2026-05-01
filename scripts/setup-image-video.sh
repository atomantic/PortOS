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

set -euo pipefail

PYTHON_BIN="${PYTHON_BIN:-python3}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PORTOS_DATA="${PORTOS_DATA:-${REPO_ROOT}/data}"

have() { command -v "$1" >/dev/null 2>&1; }
is_macos() { [[ "$(uname -s)" == "Darwin" ]]; }

if ! have "$PYTHON_BIN"; then
  echo "❌ $PYTHON_BIN not found. Install Python 3.10+ first." >&2
  exit 1
fi

mkdir -p "${PORTOS_DATA}/loras"
mkdir -p "${PORTOS_DATA}/videos"
mkdir -p "${PORTOS_DATA}/video-thumbnails"

INSTALL_VIDEO="${INSTALL_VIDEO:-$(is_macos && echo 1 || echo 0)}"

# Install via pip --user so we don't pollute the system or require a venv.
# mflux comes with the mflux-generate CLI which the local image backend
# spawns directly. transformers<5 is required for MLX compatibility.
echo "📦 Installing image generation packages (mflux + deps)..."
"$PYTHON_BIN" -m pip install --upgrade --user \
  mflux \
  "transformers<5" \
  safetensors \
  huggingface_hub \
  numpy \
  opencv-python \
  tqdm

if [[ "$INSTALL_VIDEO" == "1" ]]; then
  if is_macos; then
    echo "📦 Installing video generation packages (mlx-video-with-audio + mlx_vlm)..."
    # NOTE: the package on PyPI named just 'mlx_video' is unrelated (video
    # loading utilities). The LTX-2 generation backend lives at
    # mlx-video-with-audio (provides the `mlx_video.generate_av` module).
    # Pin >=0.1.35 — earlier versions silently broke I2V on split-format /
    # quantized models like LTX-2.3 distilled-Q4 by failing to load the VAE
    # encoder, causing the conditioned frame to render as gray fog.
    "$PYTHON_BIN" -m pip install --upgrade --user \
      mlx \
      mlx_vlm \
      "mlx-video-with-audio>=0.1.35"
  else
    echo "📦 Installing video generation packages (diffusers + torch)..."
    "$PYTHON_BIN" -m pip install --upgrade --user \
      torch \
      diffusers \
      accelerate
  fi
fi

# ffmpeg — required for thumbnails, last-frame extraction, and stitch.
if ! have ffmpeg; then
  if is_macos && have brew; then
    echo "📦 brew install ffmpeg"
    brew install ffmpeg
  else
    echo "⚠️ ffmpeg not on PATH and could not auto-install — install ffmpeg yourself for video features."
  fi
fi

PYTHON_PATH="$(command -v "$PYTHON_BIN")"
echo ""
echo "✅ Image/video stack ready."
echo "   Python:    $PYTHON_PATH"
echo "   HF cache:  ~/.cache/huggingface (HF default)"
echo "   LoRAs:     ${PORTOS_DATA}/loras"
echo "   Videos:    ${PORTOS_DATA}/videos"
echo ""
echo "Set this Python path in PortOS Settings → Image Gen → Local."
