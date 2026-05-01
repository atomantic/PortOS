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
#   INSTALL_FLUX2  '1' to also bootstrap a separate venv at ~/.portos/venv-flux2 for FLUX.2-klein (default: 1 on macOS, 0 elsewhere)

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
    # Both packages provide an `import mlx_video` module, so a prior install
    # of the wrong one shadows the right one. Uninstall first to remove the
    # ambiguity for users upgrading from earlier setup-image-video.sh runs.
    "$PYTHON_BIN" -m pip uninstall --yes mlx_video >/dev/null 2>&1 || true
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

INSTALL_FLUX2="${INSTALL_FLUX2:-$(is_macos && echo 1 || echo 0)}"

if [[ "$INSTALL_FLUX2" == "1" ]]; then
  # FLUX.2-klein needs torch>=2.5 + diffusers-from-git + sdnq + optimum-quanto.
  # Mixing those into the mflux pip --user pile (mflux pulls older torch) is
  # fragile, so we use a sibling venv. server/lib/pythonSetup.js looks for
  # python3 here when the active model has runner=='flux2'.
  FLUX2_VENV="${HOME}/.portos/venv-flux2"
  FLUX2_PY="$FLUX2_VENV/bin/python3"
  if [[ ! -x "$FLUX2_PY" ]]; then
    echo "📦 Creating FLUX.2 venv at ${FLUX2_VENV}..."
    mkdir -p "${HOME}/.portos"
    "$PYTHON_BIN" -m venv "$FLUX2_VENV"
  fi

  # Skip the (slow, network-heavy) pip path when Flux2KleinPipeline already
  # imports — diffusers-from-git is a git clone every run otherwise. Use
  # FLUX2_FORCE_REINSTALL=1 to bypass.
  if [[ "${FLUX2_FORCE_REINSTALL:-}" != "1" ]] && "$FLUX2_PY" -c "from diffusers import Flux2KleinPipeline" 2>/dev/null; then
    echo "✅ FLUX.2 venv already ready: $FLUX2_PY"
  else
    echo "📦 Installing FLUX.2 packages into $FLUX2_VENV..."
    "$FLUX2_PY" -m pip install --upgrade pip wheel setuptools >/dev/null
    # diffusers-from-git is required because Flux2KleinPipeline isn't in any
    # tagged release as of late 2025 / early 2026. sdnq is git-only too —
    # registers a custom config type at import-time which
    # Flux2KleinPipeline.from_pretrained relies on.
    "$FLUX2_PY" -m pip install --upgrade \
      "torch>=2.5" \
      torchvision \
      accelerate \
      "transformers>=4.45" \
      sentencepiece \
      protobuf \
      safetensors \
      "huggingface_hub[hf_xet]" \
      "diffusers @ git+https://github.com/huggingface/diffusers" \
      "sdnq @ git+https://github.com/Disty0/sdnq.git" \
      "peft>=0.17" \
      "optimum-quanto>=0.2.7" \
      pillow
    if ! "$FLUX2_PY" -c "from diffusers import Flux2KleinPipeline" 2>/dev/null; then
      echo "❌ flux2 venv built but 'from diffusers import Flux2KleinPipeline' failed." >&2
      echo "   Try: $FLUX2_PY -m pip install --upgrade --force-reinstall 'diffusers @ git+https://github.com/huggingface/diffusers'" >&2
      exit 1
    fi
    echo "✅ FLUX.2 venv ready: $FLUX2_PY"
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
if [[ "$INSTALL_FLUX2" == "1" ]]; then
  echo "   FLUX.2:    ${HOME}/.portos/venv-flux2/bin/python3 (separate venv)"
  echo ""
  echo "⚠️  FLUX.2-klein needs HF auth: accept the license at"
  echo "    https://huggingface.co/black-forest-labs/FLUX.2-klein-4B"
  echo "    then export HF_TOKEN=... before running PortOS."
fi
echo ""
echo "Set this Python path in PortOS Settings → Image Gen → Local."
