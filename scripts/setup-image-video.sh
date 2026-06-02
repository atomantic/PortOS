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
#   INSTALL_FLUX2  '1' to also bootstrap a separate venv at ~/.portos/venv-flux2 for FLUX.2-klein (default: 1 on macOS, 0 elsewhere)
#   INSTALL_MUSICGEN '1' to bootstrap a venv at ~/.portos/venv-musicgen + clone ml-explore/mlx-examples to ~/.portos/mlx-examples for local MusicGen (MLX) background-music generation (pipeline audio stage). Default: 0; opt in with INSTALL_MUSICGEN=1 (macOS / Apple Silicon only).
#   MLX_EXAMPLES_PIN  commit SHA of ml-explore/mlx-examples to check out for MusicGen (default: main).

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

# When the user only wants a specific BYOV runtime (set via INSTALL_LTX2 /
# INSTALL_WAN22 / INSTALL_HUNYUAN — typically from the in-app installer),
# skip the mflux + legacy mlx_video preamble. Those bring-your-own-venv
# runtimes are self-contained and don't depend on mflux; running the
# preamble unprompted hits PEP 668 ("externally-managed-environment") on
# Homebrew Python and aborts the whole script before the requested runtime
# install ever starts. A bare `bash setup-image-video.sh` still installs
# mflux as before.
ANY_BYOV="${INSTALL_LTX2:-0}${INSTALL_WAN22:-0}${INSTALL_HUNYUAN:-0}"
if [[ "$ANY_BYOV" == "000" ]]; then
  DEFAULT_INSTALL_MFLUX=1
  DEFAULT_INSTALL_VIDEO=$(is_macos && echo 1 || echo 0)
  DEFAULT_INSTALL_FLUX2=$(is_macos && echo 1 || echo 0)
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
  # spawns directly. transformers<5 is required for MLX compatibility.
  #
  # `--force-reinstall --no-deps` on mflux only — earlier setup runs could
  # leave the user-site copy at the right version number but with stale file
  # layout (we hit this in 0.12.1, where `mflux/models/flux/cli/` was missing
  # from a partial reinstall, breaking the entry-point shim). Forcing the
  # reinstall flushes the file tree without re-resolving torch/mlx and friends.
  echo "📦 Installing image generation packages (mflux + deps)..."
  "$PYTHON_BIN" -m pip install --upgrade --user --force-reinstall --no-deps mflux
  # mflux above is installed with --no-deps to flush its file tree without
  # re-resolving torch/mlx — but that means we must explicitly install mflux's
  # own runtime deps here (notably `mlx` on macOS, which it imports at startup).
  # Without this, INSTALL_VIDEO=0 leaves mflux unable to import.
  MFLUX_DEPS=("transformers<5" safetensors huggingface_hub numpy opencv-python tqdm)
  if is_macos; then
    MFLUX_DEPS+=(mlx)
  fi
  "$PYTHON_BIN" -m pip install --upgrade --user "${MFLUX_DEPS[@]}"
fi

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

INSTALL_LTX2="${INSTALL_LTX2:-0}"

if [[ "$INSTALL_LTX2" == "1" ]]; then
  # dgrauet/ltx-2-mlx: a more capable community port of LTX-2.3 with
  # proper KeyframeInterpolationPipeline (true FFLF), video Extend (not
  # last-frame conditioning), retake, ic-lora, audio-to-video.
  # Requires Python 3.11+ and ships as a multi-package monorepo we sync
  # via `uv sync --all-extras` from a local clone. Lives at
  # ~/.portos/ltx-2-mlx/ (sibling to the FLUX.2 venv pattern).
  #
  # The runtime is pinned to a known-good commit in PortOS releases for
  # reproducibility — upstream changes cannot break installs without a
  # PortOS release. Set LTX2_PIN=main to track HEAD for development.
  #
  # The notapalindrome `mlx-video-with-audio` install above is unaffected
  # — both pipelines coexist; dispatch is per-model via media-models.json's
  # `runtime` field (`mlx_video` vs `ltx2`).
  if ! have uv; then
    echo "❌ INSTALL_LTX2=1 requires the 'uv' Python installer. Install with:" >&2
    echo "   curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
    exit 1
  fi
  if ! have git; then
    echo "❌ INSTALL_LTX2=1 requires git." >&2
    exit 1
  fi
  # Pinned to a known-good commit (2026-05-05). To upgrade: bump this SHA
  # and verify with PortOS's video gen smoke tests. Set LTX2_PIN=main to
  # bypass the pin and track upstream HEAD for development.
  LTX2_PIN="${LTX2_PIN:-f8f20c83ab7e2e929f3196f07ec5232ad1660bab}"
  LTX2_DIR="${HOME}/.portos/ltx-2-mlx"
  LTX2_PY="${LTX2_DIR}/.venv/bin/python3"
  mkdir -p "${HOME}/.portos"
  if [[ ! -d "${LTX2_DIR}/.git" ]]; then
    echo "📦 Cloning dgrauet/ltx-2-mlx (pinned to ${LTX2_PIN:0:12})..."
    git clone https://github.com/dgrauet/ltx-2-mlx.git "${LTX2_DIR}"
  else
    echo "📦 Fetching ltx-2-mlx updates..."
    (cd "${LTX2_DIR}" && git fetch origin)
  fi
  echo "📦 Checking out pinned commit ${LTX2_PIN:0:12}..."
  (cd "${LTX2_DIR}" && git checkout --quiet "${LTX2_PIN}")
  # Force Python 3.11 — ltx-core-mlx pins requires-python>=3.11 and the
  # macOS bundled python3 is sometimes 3.10. uv resolves this for us when
  # the env doesn't already exist.
  if [[ ! -x "${LTX2_PY}" ]]; then
    echo "📦 Creating ltx-2-mlx venv with Python 3.11..."
    (cd "${LTX2_DIR}" && uv venv --python 3.11)
  fi
  # `uv sync` is idempotent — already-installed packages are no-ops. The
  # repo's uv.lock pins mlx==0.31.1, which is the safe version (mlx 0.31.2
  # silently regressed audio peaks by ~22 dB; phosphene hit this and ships
  # the same pin). Skip --all-extras — we don't need the trainer or dev
  # extras for inference, and the trainer extra pulls another package we
  # have no use for.
  echo "📦 Syncing ltx-2-mlx packages (uv sync, no extras)..."
  (cd "${LTX2_DIR}" && uv sync)
  if ! "${LTX2_PY}" -c "import ltx_pipelines_mlx" 2>/dev/null; then
    echo "❌ ltx-2-mlx synced but 'import ltx_pipelines_mlx' failed." >&2
    echo "   Re-run with: rm -rf ${LTX2_DIR}/.venv && bash $0" >&2
    exit 1
  fi
  echo "✅ ltx-2-mlx venv ready: ${LTX2_PY}"
fi

INSTALL_WAN22="${INSTALL_WAN22:-0}"
if [[ "$INSTALL_WAN22" == "1" ]]; then
  # osama-ata/Wan2.2-mlx — pure-MLX port of Alibaba's Wan 2.2 video model.
  # MoE-A14B: 14B active params at inference, ~28 GB resident at bf16. The
  # PortOS helper at scripts/generate_wan22.py subprocesses upstream's
  # generate.py from the cloned repo, so PortOS releases own the arg
  # translation layer (PortOS arg stability) while upstream owns the
  # actual inference (upstream-tracked changes).
  #
  # EXPERIMENTAL — upstream CLI hasn't been pinned across releases; if a
  # commit reshapes --task / --ckpt_dir, set `broken: true` on the
  # wan22_* entries in data/media-models.json until generate_wan22.py is
  # updated to match.
  if ! have uv; then
    echo "❌ INSTALL_WAN22=1 requires the 'uv' Python installer." >&2
    echo "   curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
    exit 1
  fi
  if ! have git; then
    echo "❌ INSTALL_WAN22=1 requires git." >&2
    exit 1
  fi
  WAN22_PIN="${WAN22_PIN:-main}"
  WAN22_DIR="${HOME}/.portos/wan2.2-mlx"
  WAN22_PY="${WAN22_DIR}/.venv/bin/python3"
  mkdir -p "${HOME}/.portos"
  if [[ ! -d "${WAN22_DIR}/.git" ]]; then
    echo "📦 Cloning osama-ata/Wan2.2-mlx..."
    git clone https://github.com/osama-ata/Wan2.2-mlx.git "${WAN22_DIR}"
  else
    echo "📦 Fetching Wan2.2-mlx updates..."
    (cd "${WAN22_DIR}" && git fetch origin)
  fi
  (cd "${WAN22_DIR}" && git checkout --quiet "${WAN22_PIN}")
  if [[ ! -x "${WAN22_PY}" ]]; then
    echo "📦 Creating Wan2.2-mlx venv with Python 3.11..."
    (cd "${WAN22_DIR}" && uv venv --python 3.11)
  fi
  # Upstream uses pyproject + requirements rather than a lockfile. Use
  # `uv pip install -r requirements.txt` when present; otherwise `uv sync`
  # falls back to the project config.
  if [[ -f "${WAN22_DIR}/requirements.txt" ]]; then
    echo "📦 Installing Wan2.2-mlx requirements..."
    (cd "${WAN22_DIR}" && uv pip install -r requirements.txt)
  else
    echo "📦 Syncing Wan2.2-mlx packages..."
    (cd "${WAN22_DIR}" && uv sync)
  fi
  echo "✅ Wan2.2-mlx venv ready: ${WAN22_PY}"
fi

INSTALL_HUNYUAN="${INSTALL_HUNYUAN:-0}"
if [[ "$INSTALL_HUNYUAN" == "1" ]]; then
  # gaurav-nelson/HunyuanVideo_MLX — community MLX port of Tencent's
  # HunyuanVideo (13B). ~60 GB resident at bf16. Practical only with the
  # 4-bit Gemma text encoder + everything else evicted (see the Memory
  # Management panel under Settings → Local LLMs).
  #
  # EXPERIMENTAL — same caveat as Wan 2.2: upstream CLI isn't pinned. If
  # sample_video.py args drift, flip `hunyuan_video` broken in
  # data/media-models.json and update scripts/generate_hunyuan.py.
  if ! have uv; then
    echo "❌ INSTALL_HUNYUAN=1 requires the 'uv' Python installer." >&2
    exit 1
  fi
  if ! have git; then
    echo "❌ INSTALL_HUNYUAN=1 requires git." >&2
    exit 1
  fi
  HUNYUAN_PIN="${HUNYUAN_PIN:-main}"
  HUNYUAN_DIR="${HOME}/.portos/hunyuan-video-mlx"
  HUNYUAN_PY="${HUNYUAN_DIR}/.venv/bin/python3"
  mkdir -p "${HOME}/.portos"
  if [[ ! -d "${HUNYUAN_DIR}/.git" ]]; then
    echo "📦 Cloning gaurav-nelson/HunyuanVideo_MLX..."
    git clone https://github.com/gaurav-nelson/HunyuanVideo_MLX.git "${HUNYUAN_DIR}"
  else
    echo "📦 Fetching HunyuanVideo_MLX updates..."
    (cd "${HUNYUAN_DIR}" && git fetch origin)
  fi
  (cd "${HUNYUAN_DIR}" && git checkout --quiet "${HUNYUAN_PIN}")
  if [[ ! -x "${HUNYUAN_PY}" ]]; then
    echo "📦 Creating HunyuanVideo_MLX venv with Python 3.11..."
    (cd "${HUNYUAN_DIR}" && uv venv --python 3.11)
  fi
  # Upstream gaurav-nelson ships requirements as `requirements_mps.txt` (the
  # MPS-specific variant — there's no plain `requirements.txt`). Prefer the
  # MPS one when present, then plain `requirements.txt`, then fall back to
  # `uv sync` for repos that use pyproject + lockfile instead.
  HUNYUAN_REQS=""
  for cand in requirements_mps.txt requirements.txt; do
    if [[ -f "${HUNYUAN_DIR}/${cand}" ]]; then HUNYUAN_REQS="$cand"; break; fi
  done
  if [[ -n "$HUNYUAN_REQS" ]]; then
    echo "📦 Installing HunyuanVideo_MLX requirements from ${HUNYUAN_REQS}..."
    (cd "${HUNYUAN_DIR}" && uv pip install -r "$HUNYUAN_REQS")
  else
    echo "📦 Syncing HunyuanVideo_MLX packages..."
    (cd "${HUNYUAN_DIR}" && uv sync)
  fi
  echo "✅ HunyuanVideo_MLX venv ready: ${HUNYUAN_PY}"
fi

INSTALL_MUSICGEN="${INSTALL_MUSICGEN:-0}"
if [[ "$INSTALL_MUSICGEN" == "1" ]]; then
  # Local background-music generation for the pipeline audio stage (Phase
  # 4c.2). Meta's MusicGen runs on Apple Silicon via MLX, but the MLX
  # implementation lives in ml-explore/mlx-examples (`musicgen/`), which isn't
  # a pip package — so we clone the repo and build a sibling venv. The sidecar
  # `scripts/generate_musicgen.py` imports `MusicGen` from the clone;
  # server/lib/pythonSetup.js (resolveMusicgenPython) looks for python3 here.
  if ! is_macos; then
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
      git clone https://github.com/ml-explore/mlx-examples.git "${MLX_EXAMPLES_DIR}"
    fi
    # Pin to a known commit when MLX_EXAMPLES_PIN is set to a SHA; default
    # 'main' tracks HEAD (the musicgen example is stable, but a pin keeps new
    # installs reproducible — mirror of the LTX2_PIN pattern above).
    (cd "${MLX_EXAMPLES_DIR}" && git fetch --quiet origin && git checkout --quiet "${MLX_EXAMPLES_PIN}")

    if [[ ! -x "$MUSICGEN_PY" ]]; then
      echo "📦 Creating MusicGen venv at ${MUSICGEN_VENV}..."
      "$PYTHON_BIN" -m venv "$MUSICGEN_VENV"
    fi
    echo "📦 Installing MusicGen (MLX) packages into ${MUSICGEN_VENV}..."
    "$MUSICGEN_PY" -m pip install --upgrade pip wheel setuptools >/dev/null
    # mlx + numpy run the model; transformers (<5 for MLX compat) + sentencepiece
    # provide the T5 text conditioner's tokenizer; scipy is imported by the
    # mlx-examples musicgen utils. torch is required because MusicGen.from_pretrained
    # loads the upstream PyTorch checkpoints (torch.load) before converting to MLX —
    # without it generation fails at model-load even though the class imports fine.
    # We write WAV via the stdlib `wave` module in the sidecar, so no soundfile dep.
    "$MUSICGEN_PY" -m pip install --upgrade \
      mlx \
      numpy \
      torch \
      "transformers<5" \
      sentencepiece \
      "huggingface_hub[hf_xet]" \
      scipy
    # Verify BOTH that the class imports AND that torch loaded — the import alone
    # passed even when torch was missing, so install used to report ready and
    # then fail on the first generation.
    if ! PORTOS_MUSICGEN_RUNTIME_DIR="${MLX_EXAMPLES_DIR}/musicgen" \
         "$MUSICGEN_PY" -c "import sys, os, torch; sys.path.insert(0, os.environ['PORTOS_MUSICGEN_RUNTIME_DIR']); from musicgen import MusicGen" 2>/dev/null; then
      echo "❌ MusicGen venv built but 'import torch; from musicgen import MusicGen' failed." >&2
      echo "   Check that ${MLX_EXAMPLES_DIR}/musicgen exists and torch installed cleanly." >&2
      exit 1
    fi
    echo "✅ MusicGen venv ready: $MUSICGEN_PY (runtime: ${MLX_EXAMPLES_DIR}/musicgen @ ${MLX_EXAMPLES_PIN:0:12})"
  fi
fi

INSTALL_FLUX2="${INSTALL_FLUX2:-$DEFAULT_INSTALL_FLUX2}"

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
      "transformers>=4.51" \
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
if [[ "$INSTALL_LTX2" == "1" ]]; then
  echo "   LTX-2.3:   ${HOME}/.portos/ltx-2-mlx/.venv/bin/python3 (separate venv, dgrauet pipeline @ ${LTX2_PIN:0:12})"
fi
if [[ "$INSTALL_MUSICGEN" == "1" ]] && is_macos; then
  echo "   MusicGen:  ${HOME}/.portos/venv-musicgen/bin/python3 (separate venv, MLX runtime @ ${HOME}/.portos/mlx-examples/musicgen)"
fi
if [[ "$INSTALL_FLUX2" == "1" ]]; then
  echo "   FLUX.2:    ${HOME}/.portos/venv-flux2/bin/python3 (separate venv)"
  echo "   Z-Image:   reuses the FLUX.2 venv (Apache 2.0, no HF login needed)"
  echo "   ERNIE:     reuses the FLUX.2 venv (Apache 2.0, no HF login needed)"
  echo ""
  echo "⚠️  FLUX.2-klein needs HF auth: accept the license at"
  echo "    https://huggingface.co/black-forest-labs/FLUX.2-klein-4B"
  echo "    then export HF_TOKEN=... before running PortOS."
fi
echo ""
echo "Set this Python path in PortOS Settings → Image Gen → Local."
