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
#   INSTALL_MINIMAX_H3_CUDA '1' to install the MiniMax H3 CUDA runtime at ~/.portos/minimax-h3-cuda (Windows + NVIDIA), via diffusers' MiniMaxH3ModularPipeline. Weights remain a separate explicit Video Gen download (~144 GB). Default: 0.
#   INSTALL_FLUX2  '1' to also bootstrap a separate venv at ~/.portos/venv-flux2 for FLUX.2-klein (default: 1 on macOS, 0 elsewhere)
#   INSTALL_MUSICGEN '1' to bootstrap a venv at ~/.portos/venv-musicgen + clone ml-explore/mlx-examples to ~/.portos/mlx-examples for local MusicGen (MLX) background-music generation (pipeline audio stage). Default: 0; opt in with INSTALL_MUSICGEN=1 (macOS / Apple Silicon only).
#   MLX_EXAMPLES_PIN  commit SHA of ml-explore/mlx-examples to check out for MusicGen (default: main).
#   INSTALL_MINIMAX_MUSIC3_MLX '1' to bootstrap a separate venv at ~/.portos/venv-minimax-music3-mlx for native MiniMax Music 3 MLX generation (Music studio). Default: 0; opt in with INSTALL_MINIMAX_MUSIC3_MLX=1 (macOS / Apple Silicon only).
#   MLX_AUDIO_PIN    commit SHA of Blaizzy/mlx-audio containing MiniMax Music 3 support (default: 784b29e2691a93ca7483147d86f61859dfaa6296).
#   INSTALL_AUDIOLDM2 '1' to bootstrap a venv at ~/.portos/venv-audioldm2 (torch + diffusers) for local AudioLDM2 long-form background-music generation (pipeline audio stage, second backend alongside MusicGen). Default: 0; opt in with INSTALL_AUDIOLDM2=1 (runs on MPS / CUDA / CPU).
#   INSTALL_ACESTEP '1' to bootstrap a venv at ~/.portos/venv-acestep (torch + the acestep package) for local ACE-Step full-song generation with vocals (Music studio, third backend). Default: 0; opt in with INSTALL_ACESTEP=1 (runs on MPS / CUDA / CPU; checkpoints auto-download to ~/.cache/ace-step on first run).
#   INSTALL_ACESTEP15 '1' to bootstrap a venv at ~/.portos/venv-acestep15 (the ACE-Step 1.5 package + torch) for local ACE-Step 1.5 full-song generation (Music studio). Default: 0; opt in with INSTALL_ACESTEP15=1 (runs on MPS / CUDA / CPU; model weights are installed separately from Music).
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
# Git-bash / MSYS / Cygwin all report a prefixed uname; PortOS runs the
# in-app installer through git-bash on Windows, so match all three.
is_windows() { case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) return 0;; *) return 1;; esac; }

# Resolve a venv interpreter from the layout its creating Python used. Git Bash
# keeps its POSIX shell paths on Windows, but Python still creates Scripts/.
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

if ! have "$PYTHON_BIN"; then
  echo "❌ $PYTHON_BIN not found. Install Python 3.10+ first." >&2
  exit 1
fi

mkdir -p "${PORTOS_DATA}/loras"
mkdir -p "${PORTOS_DATA}/videos"
mkdir -p "${PORTOS_DATA}/video-thumbnails"

# When the user only wants a specific BYOV runtime (set via INSTALL_LTX2 /
# INSTALL_WAN22 / INSTALL_MINIMAX_H3 / INSTALL_MINIMAX_H3_CUDA — or one of the self-contained MUSIC venvs
# INSTALL_MUSICGEN / INSTALL_AUDIOLDM2 / INSTALL_ACESTEP / INSTALL_ACESTEP15 / INSTALL_MINIMAX_MUSIC3_MLX — typically from the
# in-app installer), skip the mflux + legacy mlx_video preamble. Those
# bring-your-own-venv runtimes are self-contained and don't depend on mflux;
# running the preamble unprompted hits PEP 668 ("externally-managed-environment")
# on Homebrew Python and aborts the whole script before the requested runtime
# install ever starts — which on Linux/CPU/CUDA blocks the advertised
# `INSTALL_ACESTEP=1 bash …` path. A bare `bash setup-image-video.sh` still
# installs mflux as before.
ANY_BYOV="${INSTALL_LTX2:-0}${INSTALL_LTX25:-0}${INSTALL_FASTVIDEO:-0}${INSTALL_WAN22:-0}${INSTALL_MINIMAX_H3:-0}${INSTALL_MINIMAX_H3_CUDA:-0}${INSTALL_MUSICGEN:-0}${INSTALL_AUDIOLDM2:-0}${INSTALL_ACESTEP:-0}${INSTALL_ACESTEP15:-0}${INSTALL_MINIMAX_MUSIC3:-0}${INSTALL_MINIMAX_MUSIC3_MLX:-0}${INSTALL_MUSCRIPTOR:-0}"
# "no BYOV runtime was requested" = the concatenation contains no non-zero
# character. Matching a literal string of zeros instead made this a counting
# exercise that the string and the variable list had to agree on — and they had
# already fallen out of step, so a bare `bash setup-image-video.sh` was taking
# the BYOV-only branch and skipping the mflux + flux2 preamble it advertises.
# This form cannot drift as runtimes are added.
if [[ "$ANY_BYOV" != *[!0]* ]]; then
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
  # spawns directly. Pin >=0.17: that's the first release with FLUX.2 LoRA
  # training (`mflux-train --config`, `flux2-klein-*` base models). Older
  # mflux (0.12.x) wants `--train-config` and has no flux2 models, so its
  # trainer dies with a bare "exited with code 2" — see train_mflux_lora.py.
  #
  echo "📦 Installing image generation packages (mflux + deps)..."
  # VALIDATED TRIO (issue #1329) — pin the MLX/Metal backend, do NOT leave it a
  # floor. The original three M5 Max GPU-watchdog kernel panics
  # (docs/research/2026-06-13-mflux-training-watchdog-panic.md) happened on
  # mlx/mlx-metal 0.30.6. A `>=` floor lets pip resolve mlx silently under
  # mflux's `mlx<0.32` cap, so the stack can drift back onto a known-bad build.
  # The surviving trio is mflux 0.17.5 · mlx 0.31.2 · mlx-metal 0.31.2:
  # run d36562a0 (flux2-klein-4b, bf16, 768px) completed a full LoRA training to
  # adapter extraction on this stack on the panicking M5 Max (Mac17,7/T6050,
  # macOS 26.5.1) with no panic — see the bisect log in the incident doc.
  # (mflux's `dev` extra itself pins mlx==0.31.0, so 0.31.2 is in-range and
  # closer to what mflux develops against than the old 0.30.6.) Bump these only
  # after re-validating with another full run on the M5; record the proving run.
  MFLUX_PIN='mflux==0.17.5'
  MLX_PIN='mlx==0.31.2'
  MLX_METAL_PIN='mlx-metal==0.31.2'
  # mflux/mlx need Python 3.10+. The historical layout installs mflux with
  # `pip install --user` against $PYTHON_BIN, and PortOS finds `mflux-train`
  # beside that interpreter. But when $PYTHON_BIN is too old (e.g. a system
  # python3.8) or externally-managed (PEP 668) so the --user install fails or
  # can't be imported, fall back to a dedicated venv at ~/.portos/venv-mflux —
  # the same pattern the flux2/ltx/wan runtimes use. PortOS's resolveMfluxPython()
  # auto-discovers that venv, so no Settings change is needed either way.
  MFLUX_USE_VENV=0
  if "$PYTHON_BIN" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)' 2>/dev/null; then
    # Step 1: force-reinstall mflux's OWN files with --no-deps to flush a stale
    # file layout left by a partial reinstall (we hit this on 0.12.1, where
    # `mflux/models/flux/cli/` went missing, breaking the entry-point shim)
    # WITHOUT re-downloading the heavy torch/mlx tree.
    #
    # Step 2: let pip install mflux's DECLARED runtime deps — pip is the source
    # of truth, not a hand-kept list. mflux 0.17 imports packages the 0.12.x set
    # omitted (pillow, matplotlib, platformdirs, sentencepiece, piexif, …) and
    # constrains transformers>=5,<6 and mlx<0.32; a hand list silently drifts and
    # leaves `mflux-train` failing at import before it can reach the trainer.
    # No --no-deps (so missing deps ARE pulled) and no --upgrade (so an
    # already-satisfied heavyweight like torch isn't re-resolved/re-downloaded on
    # repeat runs); a dep that violates mflux's constraints is still corrected.
    # The explicit mlx/mlx-metal pins ride alongside mflux so pip resolves the
    # proven backend rather than the latest in-range build.
    "$PYTHON_BIN" -m pip install --upgrade --user --force-reinstall --no-deps "$MFLUX_PIN" \
      && "$PYTHON_BIN" -m pip install --user "$MFLUX_PIN" "$MLX_PIN" "$MLX_METAL_PIN" \
      || MFLUX_USE_VENV=1
    # A satisfied-looking pip run can still leave an unimportable stack on an odd
    # system Python — verify mflux actually imports before trusting the --user path.
    if [[ "$MFLUX_USE_VENV" == "0" ]] && ! "$PYTHON_BIN" -c 'import mflux' 2>/dev/null; then
      echo "⚠️  mflux installed under $PYTHON_BIN but does not import — falling back to a dedicated venv."
      MFLUX_USE_VENV=1
    fi
  else
    MFLUX_PYVER="$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo unknown)"
    echo "⚠️  $PYTHON_BIN is Python ${MFLUX_PYVER} — mflux needs 3.10+; using a dedicated venv."
    MFLUX_USE_VENV=1
  fi

  if [[ "$MFLUX_USE_VENV" == "1" ]]; then
    # Dedicated mflux venv (Python 3.11) built with uv, mirroring the flux2/ltx/
    # wan runtimes. uv provisions a managed 3.11 even when the system Python is
    # unusable, which is exactly the case we're recovering from.
    if ! have uv; then
      echo "❌ Need 'uv' to build the mflux venv (system Python can't host mflux)." >&2
      echo "   Install uv (https://docs.astral.sh/uv/) or point PYTHON_BIN at a Python 3.10+, then re-run." >&2
      exit 1
    fi
    MFLUX_VENV="${HOME}/.portos/venv-mflux"
    MFLUX_VENV_PY="${MFLUX_VENV}/bin/python3"
    if [[ ! -x "$MFLUX_VENV_PY" ]]; then
      echo "📦 Creating mflux venv at ${MFLUX_VENV} (Python 3.11)..."
      mkdir -p "${HOME}/.portos"
      uv venv --python 3.11 "$MFLUX_VENV"
    fi
    echo "📦 Installing ${MFLUX_PIN} · ${MLX_PIN} · ${MLX_METAL_PIN} into ${MFLUX_VENV}..."
    uv pip install --python "$MFLUX_VENV_PY" "$MFLUX_PIN" "$MLX_PIN" "$MLX_METAL_PIN"
    probe_or_fail \
      "mflux venv built but 'import mflux' failed." \
      "Check that mflux and its MLX dependencies installed cleanly in ${MFLUX_VENV}." \
      "$MFLUX_VENV_PY" -c 'import mflux'
    echo "✅ mflux venv ready: ${MFLUX_VENV_PY} (PortOS auto-discovers it — no Settings change needed)."
  fi
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
  # Pinned to v0.14.19 (2026-07-19). To upgrade: bump this SHA and verify with
  # PortOS's video gen smoke tests (text/image/fflf/extend/a2v). Set
  # LTX2_PIN=main to bypass the pin and track upstream HEAD for development.
  # NOTE: v0.14.x renamed every public pipeline class (TextToVideoPipeline →
  # TI2VidOneStagePipeline, ExtendPipeline → RetakePipeline, etc.) and switched
  # the output-rate kwarg from `fps` to `frame_rate`. generate_ltx2.py resolves
  # pipeline classes and the rate kwarg defensively so it works against this pin
  # AND older pre-rename pins an install may still have checked out.
  LTX2_PIN="${LTX2_PIN:-1192051fd380e0501adb5f3c0e9a216e679cb123}"
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
  if ! have uv; then
    echo "❌ INSTALL_LTX25=1 requires the 'uv' Python installer. Install with:" >&2
    echo "   curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
    exit 1
  fi
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
  LTX25_PIN="${LTX25_PIN:-57952288076766abe27dda3a774b2c24f7346977}"
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
  if [[ ! -x "${LTX25_PY}" ]]; then
    echo "📦 Creating ltx-2.5-mlx venv with Python 3.11..."
    (cd "${LTX25_DIR}" && uv venv --python 3.11)
  fi
  echo "📦 Syncing ltx-2.5-mlx packages (uv sync, no extras)..."
  (cd "${LTX25_DIR}" && uv sync)
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
  if ! is_macos || [[ "$(uname -m)" != "arm64" ]]; then
    echo "❌ FastVideo MLX requires an Apple-Silicon Mac." >&2
    exit 1
  fi
  if ! have git; then
    echo "❌ INSTALL_FASTVIDEO=1 requires git." >&2
    exit 1
  fi

  FASTVIDEO_UV_TOOL_DIR="${HOME}/.portos/tools/uv-0.8.14"
  FASTVIDEO_UV="${FASTVIDEO_UV_TOOL_DIR}/bin/uv"
  if [[ ! -x "$FASTVIDEO_UV" ]] || [[ "$("$FASTVIDEO_UV" --version 2>/dev/null || true)" != "uv 0.8.14" ]]; then
    echo "📦 Bootstrapping pinned uv 0.8.14 for FastVideo..."
    "$PYTHON_BIN" -m venv --clear "$FASTVIDEO_UV_TOOL_DIR"
    "${FASTVIDEO_UV_TOOL_DIR}/bin/python3" -m pip install --disable-pip-version-check "uv==0.8.14"
  fi

  FASTVIDEO_PIN="${FASTVIDEO_PIN:-main}"
  FASTVIDEO_DIR="${HOME}/.portos/fastvideo"
  FASTVIDEO_PY="${FASTVIDEO_DIR}/.venv/bin/python3"
  mkdir -p "${HOME}/.portos"
  if [[ ! -d "${FASTVIDEO_DIR}/.git" ]]; then
    echo "📦 Cloning hao-ai-lab/FastVideo..."
    git clone --progress https://github.com/hao-ai-lab/FastVideo.git "${FASTVIDEO_DIR}"
  else
    echo "📦 Fetching FastVideo updates..."
    (cd "${FASTVIDEO_DIR}" && git fetch --progress origin)
  fi
  git_checkout_pin "${FASTVIDEO_DIR}" "${FASTVIDEO_PIN}"
  if [[ ! -x "${FASTVIDEO_PY}" ]]; then
    echo "📦 Creating FastVideo venv with Python 3.11..."
    (cd "${FASTVIDEO_DIR}" && "$FASTVIDEO_UV" venv --python 3.11)
  fi
  echo "📦 Installing FastVideo MLX packages (uv pip install -e '.[mlx]')..."
  (cd "${FASTVIDEO_DIR}" && "$FASTVIDEO_UV" pip install -e '.[mlx]')
  probe_or_fail \
    "FastVideo synced but the runtime import failed." \
    "Use Repair / Upgrade from the Video Gen runtime panel to retry." \
    "${FASTVIDEO_PY}" -c "import fastvideo; import mlx.core"
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
  # Keep uv itself on-demand too. A machine that updated PortOS but never used
  # a BYOV model should gain no global package or tool. If uv is not already
  # available, bootstrap a pinned copy inside ~/.portos using the Python that
  # PortOS already validated above; all output streams back to the install UI.
  WAN22_UV_TOOL_DIR="${HOME}/.portos/tools/uv-0.8.14"
  WAN22_UV="${WAN22_UV_TOOL_DIR}/bin/uv"
  # Always use the PortOS-owned exact uv version. A random PATH copy can be too
  # old for this lockfile or a future release with different sync semantics,
  # which would defeat the reproducible runtime pin even though MLX-Gen itself
  # is checked out at an immutable commit.
  if [[ ! -x "$WAN22_UV" ]] || [[ "$("$WAN22_UV" --version 2>/dev/null || true)" != "uv 0.8.14" ]]; then
    echo "📦 Bootstrapping pinned uv 0.8.14 for MLX-Gen..."
    "$PYTHON_BIN" -m venv --clear "$WAN22_UV_TOOL_DIR"
    "${WAN22_UV_TOOL_DIR}/bin/python3" -m pip install --disable-pip-version-check "uv==0.8.14"
  fi
  # v0.25.0 exact commit, statically audited before integration. Keep the full
  # SHA so existing installs get an explicit, reproducible UI-driven upgrade.
  WAN22_PIN="${WAN22_PIN:-2452f0c12edcc8886eebf15772205ce9c417a618}"
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
  if [[ ! -x "${WAN22_PY}" ]]; then
    echo "📦 Creating MLX-Gen venv with Python 3.11..."
    (cd "${WAN22_DIR}" && "$WAN22_UV" venv --python 3.11)
  fi
  echo "📦 Syncing pinned MLX-Gen packages..."
  (cd "${WAN22_DIR}" && "$WAN22_UV" sync --locked)
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
  if ! is_macos || [[ "$(uname -m)" != "arm64" ]]; then
    echo "❌ MiniMax H3 MLX requires an Apple-Silicon Mac." >&2
    exit 1
  fi
  if ! have git; then
    echo "❌ INSTALL_MINIMAX_H3=1 requires git." >&2
    exit 1
  fi

  MINIMAX_H3_UV_TOOL_DIR="${HOME}/.portos/tools/uv-0.8.14"
  MINIMAX_H3_UV="${MINIMAX_H3_UV_TOOL_DIR}/bin/uv"
  if [[ ! -x "$MINIMAX_H3_UV" ]] || [[ "$("$MINIMAX_H3_UV" --version 2>/dev/null || true)" != "uv 0.8.14" ]]; then
    echo "📦 Bootstrapping pinned uv 0.8.14 for MiniMax H3 MLX..."
    "$PYTHON_BIN" -m venv --clear "$MINIMAX_H3_UV_TOOL_DIR"
    "${MINIMAX_H3_UV_TOOL_DIR}/bin/python3" -m pip install --disable-pip-version-check "uv==0.8.14"
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
  if [[ ! -x "$MINIMAX_H3_PY" ]]; then
    echo "📦 Creating MiniMax H3 MLX venv with Python 3.11..."
    "$MINIMAX_H3_UV" venv --python 3.11 "${MINIMAX_H3_DIR}/.venv"
  fi
  echo "📦 Syncing pinned MiniMax H3 MLX packages..."
  "$MINIMAX_H3_UV" pip sync --python "$MINIMAX_H3_PY" "$MINIMAX_H3_LOCK"
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

INSTALL_MINIMAX_H3_CUDA="${INSTALL_MINIMAX_H3_CUDA:-0}"
if [[ "$INSTALL_MINIMAX_H3_CUDA" == "1" ]]; then
  # MiniMax H3 on NVIDIA, through diffusers' MiniMaxH3ModularPipeline. Unlike
  # the MLX sibling above there is no source checkout to pin — everything this
  # runtime executes is an installed distribution, so the pin is the exact
  # `==` set in requirements-minimax-h3-cuda.txt. Reached only from the
  # explicit runtime Install / Repair action, never from PortOS boot.
  if is_macos; then
    echo "❌ MiniMax H3 CUDA needs an NVIDIA GPU. On Apple Silicon use INSTALL_MINIMAX_H3=1 (the MLX port) instead." >&2
    exit 1
  fi
  # Windows and Linux both reach this model: since #4142 the catalog picks
  # video.cuda[] vs video.mlx[] on `process.platform === 'darwin'`, so a Linux
  # install is served the same CUDA list a Windows one is.
  MINIMAX_H3_CUDA_DIR="${HOME}/.portos/minimax-h3-cuda"
  MINIMAX_H3_CUDA_VENV="${MINIMAX_H3_CUDA_DIR}/.venv"
  MINIMAX_H3_CUDA_REQS="${SCRIPT_DIR}/requirements-minimax-h3-cuda.txt"
  mkdir -p "${MINIMAX_H3_CUDA_DIR}"
  # A Windows venv puts the interpreter under Scripts/, a POSIX one under bin/.
  # Probe for either rather than branching on `uname`, so an MSYS/Cygwin bash on
  # Windows (which is what the in-app installer runs) resolves correctly.
  if ! venv_exists "$MINIMAX_H3_CUDA_VENV"; then
    echo "📦 Creating MiniMax H3 CUDA venv..."
    "$PYTHON_BIN" -m venv "$MINIMAX_H3_CUDA_VENV"
  fi
  MINIMAX_H3_CUDA_PY="$(venv_python "$MINIMAX_H3_CUDA_VENV")"

  "$MINIMAX_H3_CUDA_PY" -m pip install --disable-pip-version-check --upgrade pip wheel setuptools
  # torch comes from PyTorch's own CUDA index on Windows — the default PyPI
  # Windows wheel is CPU-only, which on a 33B model is not "slower" but
  # unusable. Linux's PyPI torch already bundles CUDA, so it needs no swap.
  # Mirrors WIN_TORCH_CUDA_INDEX in server/lib/pythonSetup.js.
  if is_windows; then
    echo "📦 Installing CUDA torch from ${TORCH_CUDA_INDEX}..."
    "$MINIMAX_H3_CUDA_PY" -m pip install --upgrade --index-url "$TORCH_CUDA_INDEX" torch
  else
    echo "📦 Installing torch..."
    "$MINIMAX_H3_CUDA_PY" -m pip install --upgrade torch
  fi
  echo "📦 Installing pinned MiniMax H3 CUDA packages..."
  "$MINIMAX_H3_CUDA_PY" -m pip install --upgrade --progress-bar on -r "$MINIMAX_H3_CUDA_REQS"

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
      git clone --progress https://github.com/ml-explore/mlx-examples.git "${MLX_EXAMPLES_DIR}"
    fi
    # Pin to a known commit when MLX_EXAMPLES_PIN is set to a SHA; default
    # 'main' tracks HEAD (the musicgen example is stable, but a pin keeps new
    # installs reproducible — mirror of the LTX2_PIN pattern above).
    git -C "${MLX_EXAMPLES_DIR}" fetch --quiet origin
    git_checkout_pin "${MLX_EXAMPLES_DIR}" "${MLX_EXAMPLES_PIN}"

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
  mkdir -p "${HOME}/.portos"

  if ! venv_exists "$AUDIOLDM2_VENV"; then
    echo "📦 Creating AudioLDM2 venv at ${AUDIOLDM2_VENV}..."
    "$PYTHON_BIN" -m venv "$AUDIOLDM2_VENV"
  fi
  AUDIOLDM2_PY="$(venv_python "$AUDIOLDM2_VENV")"
  echo "📦 Installing AudioLDM2 (diffusers) packages into ${AUDIOLDM2_VENV}..."
  "$AUDIOLDM2_PY" -m pip install --upgrade pip wheel setuptools >/dev/null
  # torch runs the model; diffusers provides AudioLDM2Pipeline; transformers +
  # sentencepiece supply the text encoders (T5 / GPT-2 / CLAP) AudioLDM2 chains;
  # accelerate speeds device placement; numpy/scipy back the audio math. We write
  # WAV via the stdlib `wave` module in the sidecar, so no soundfile dep.
  "$AUDIOLDM2_PY" -m pip install --upgrade \
    torch \
    diffusers \
    "transformers<5" \
    sentencepiece \
    accelerate \
    numpy \
    scipy \
    "huggingface_hub[hf_xet]"
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
  mkdir -p "${HOME}/.portos"

  if ! venv_exists "$ACESTEP_VENV"; then
    echo "📦 Creating ACE-Step venv at ${ACESTEP_VENV}..."
    "$PYTHON_BIN" -m venv "$ACESTEP_VENV"
  fi
  ACESTEP_PY="$(venv_python "$ACESTEP_VENV")"
  echo "📦 Installing ACE-Step into ${ACESTEP_VENV} (this pulls torch + the acestep package)..."
  "$ACESTEP_PY" -m pip install --upgrade pip wheel setuptools >/dev/null
  # The acestep package declares its own deps (torch, diffusers, transformers,
  # audio I/O, etc.), so installing it from git pulls the matching stack. Pinning
  # nothing here keeps us on the upstream-tested set; the import probe below
  # catches a broken resolve before generation depends on it.
  "$ACESTEP_PY" -m pip install --upgrade \
    "git+https://github.com/ace-step/ACE-Step.git" \
    "huggingface_hub[hf_xet]"
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
  mkdir -p "${HOME}/.portos"

  if ! venv_exists "$ACESTEP15_VENV"; then
    echo "📦 Creating ACE-Step 1.5 venv at ${ACESTEP15_VENV}..."
    "$PYTHON_BIN" -m venv "$ACESTEP15_VENV"
  fi
  ACESTEP15_PY="$(venv_python "$ACESTEP15_VENV")"
  echo "📦 Installing ACE-Step 1.5 into ${ACESTEP15_VENV}..."
  "$ACESTEP15_PY" -m pip install --upgrade pip wheel setuptools >/dev/null
  # ACE-Step 1.5's Linux/Windows torch pins are published on PyTorch's CUDA
  # index. Passing it as an extra index remains harmless on macOS, where the
  # package selects its native MPS-compatible torch dependency.
  # Pin the runtime to a vendor release. The model snapshot is installed
  # separately through Music, but its custom-code loader depends on this
  # package's handler contract.
  ACESTEP15_TORCH_INDEX="${PORTOS_TORCH_CUDA_INDEX:-https://download.pytorch.org/whl/cu128}"
  "$ACESTEP15_PY" -m pip install --upgrade --extra-index-url "$ACESTEP15_TORCH_INDEX" \
    "git+https://github.com/ace-step/ACE-Step-1.5.git@v0.1.8" \
    "huggingface_hub[hf_xet]"
  probe_or_fail \
    "ACE-Step 1.5 venv built but its Transformers runtime failed to import." \
    "Check that torch, transformers, and ACE-Step 1.5 installed cleanly in ${ACESTEP15_VENV}." \
    "$ACESTEP15_PY" -c "import torch; from transformers import AutoModel; from acestep.handler import AceStepHandler; from acestep.inference import GenerationConfig, GenerationParams, generate_music"
  echo "✅ ACE-Step 1.5 venv ready: $ACESTEP15_PY"
fi

INSTALL_MINIMAX_MUSIC3="${INSTALL_MINIMAX_MUSIC3:-0}"
if [[ "$INSTALL_MINIMAX_MUSIC3" == "1" ]]; then
  # MiniMax Music 3 (Music studio, CUDA-only) — full songs with vocals up to five
  # minutes. diffusers is pinned to a git commit until a release carries the
  # MiniMax-Music3 modular pipeline, so pip needs git to build that wheel. Say so
  # up front rather than failing several minutes into a torch download.
  if ! have git; then
    echo "❌ INSTALL_MINIMAX_MUSIC3=1 requires git (the diffusers pin is a git commit)." >&2
    exit 1
  fi
  MINIMAX_MUSIC3_VENV="${HOME}/.portos/venv-minimax-music3"
  mkdir -p "${HOME}/.portos"
  # A venv built from a conda/anaconda base is the sticky Windows failure: pip
  # installs torch happily, then `import torch` dies with
  # "WinError 1114 ... c10.dll initialization routine failed" because conda's
  # MKL/OpenMP DLLs poison the search path. Re-running never helped, because the
  # venv already existed and got reused. Rebuild it when its recorded base is
  # conda and the interpreter we'd build from is not.
  if [[ -f "$MINIMAX_MUSIC3_VENV/pyvenv.cfg" ]] \
     && grep -qiE '^home *=.*(miniconda|anaconda)' "$MINIMAX_MUSIC3_VENV/pyvenv.cfg" \
     && [[ ! "$PYTHON_BIN" =~ [Mm]ini?conda|[Aa]naconda ]]; then
    echo "♻️  Existing MiniMax Music 3 venv was built from a conda base (torch can't load there) — rebuilding from ${PYTHON_BIN}."
    rm -rf "$MINIMAX_MUSIC3_VENV"
  fi
  if ! venv_exists "$MINIMAX_MUSIC3_VENV"; then
    "$PYTHON_BIN" -m venv "$MINIMAX_MUSIC3_VENV"
  fi
  MINIMAX_MUSIC3_PY="$(venv_python "$MINIMAX_MUSIC3_VENV")"
  "$MINIMAX_MUSIC3_PY" -m pip install --upgrade pip wheel setuptools
  # torch comes from PyTorch's own CUDA index on Windows — the default PyPI
  # Windows wheel is CPU-only, which fails the cuda assert below. Linux's PyPI
  # torch already bundles CUDA. Mirrors the MiniMax H3 CUDA block above.
  MINIMAX_MUSIC3_TORCH_INDEX="${PORTOS_TORCH_CUDA_INDEX:-https://download.pytorch.org/whl/cu126}"
  if is_windows; then
    echo "📦 Installing CUDA torch from ${MINIMAX_MUSIC3_TORCH_INDEX}..."
    "$MINIMAX_MUSIC3_PY" -m pip install --upgrade --index-url "$MINIMAX_MUSIC3_TORCH_INDEX" torch
  else
    "$MINIMAX_MUSIC3_PY" -m pip install --upgrade torch
  fi
  # Fail here, with the cause named, rather than 400 MB of diffusers later. The
  # conda-base check above is a heuristic (a venv can inherit a poisoned DLL path
  # other ways); this is the ground truth.
  probe_or_fail \
    "torch installed into ${MINIMAX_MUSIC3_VENV} but cannot be imported." \
    "On Windows, use a standalone Python instead of a conda/anaconda base, then retry the install." \
    "$MINIMAX_MUSIC3_PY" -c "import torch"
  # Pinned to the main commit that merged MiniMax Music 3 (diffusers PR #14456,
  # 2026-08-13) — the integration is in no tagged release yet. The pin must be a
  # commit reachable from main: pip clones the default branch, so a PR-branch
  # head SHA fails with "pathspec ... did not match any file(s) known to git".
  "$MINIMAX_MUSIC3_PY" -m pip install --upgrade transformers accelerate huggingface_hub numpy \
    'diffusers @ git+https://github.com/huggingface/diffusers.git@2da7040be1a2e5f2fcbc8b985083342a308f5a86'
  "$MINIMAX_MUSIC3_PY" -c "import torch; from diffusers import ModularPipeline; assert torch.cuda.is_available()"
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
  if ! is_macos || [[ "$(uname -m)" != "arm64" ]]; then
    echo "⚠️ INSTALL_MINIMAX_MUSIC3_MLX=1 is macOS / Apple-Silicon only. Skipping." >&2
  else
    MINIMAX_MUSIC3_MLX_VENV="${HOME}/.portos/venv-minimax-music3-mlx"
    mkdir -p "${HOME}/.portos"
    if ! venv_exists "$MINIMAX_MUSIC3_MLX_VENV"; then
      echo "📦 Creating MiniMax Music 3 MLX venv at ${MINIMAX_MUSIC3_MLX_VENV}..."
      "$PYTHON_BIN" -m venv "$MINIMAX_MUSIC3_MLX_VENV"
    fi
    MINIMAX_MUSIC3_MLX_PY="$(venv_python "$MINIMAX_MUSIC3_MLX_VENV")"
    MLX_AUDIO_PIN="${MLX_AUDIO_PIN:-784b29e2691a93ca7483147d86f61859dfaa6296}"
    echo "📦 Installing MiniMax Music 3 MLX packages into ${MINIMAX_MUSIC3_MLX_VENV}..."
    "$MINIMAX_MUSIC3_MLX_PY" -m pip install --upgrade pip wheel setuptools >/dev/null
    # MiniMax Music 3 support merged into mlx-audio after its latest release;
    # pin the merge commit until a release containing it is published. The model
    # cards themselves document this same upstream commit as the required API.
    "$MINIMAX_MUSIC3_MLX_PY" -m pip install --upgrade \
      "mlx-audio @ git+https://github.com/Blaizzy/mlx-audio.git@${MLX_AUDIO_PIN}" \
      "huggingface_hub[hf_xet]"
    probe_or_fail \
      "MiniMax Music 3 MLX venv built but 'import mlx; from mlx_audio.music import load' failed." \
      "Check that mlx-audio installed cleanly in ${MINIMAX_MUSIC3_MLX_VENV}." \
      "$MINIMAX_MUSIC3_MLX_PY" -c "import mlx; from mlx_audio.music import load"
    echo "✅ MiniMax Music 3 MLX venv ready: $MINIMAX_MUSIC3_MLX_PY (mlx-audio @ ${MLX_AUDIO_PIN:0:12})"
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
  mkdir -p "${HOME}/.portos"

  if ! venv_exists "$MUSCRIPTOR_VENV"; then
    echo "📦 Creating MuScriptor venv at ${MUSCRIPTOR_VENV}..."
    "$PYTHON_BIN" -m venv "$MUSCRIPTOR_VENV"
  fi
  MUSCRIPTOR_PY="$(venv_python "$MUSCRIPTOR_VENV")"
  echo "📦 Installing MuScriptor into ${MUSCRIPTOR_VENV} (pulls torch + audio deps)..."
  "$MUSCRIPTOR_PY" -m pip install --upgrade pip wheel setuptools >/dev/null
  # muscriptor declares its own deps (torch, soundfile, etc.), so installing the
  # package pulls the matching stack. The import probe below catches a broken
  # resolve before a transcription depends on it.
  "$MUSCRIPTOR_PY" -m pip install --upgrade \
    muscriptor \
    "huggingface_hub[hf_xet]"
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
  # FLUX.2-klein needs torch>=2.5 + diffusers-from-git + sdnq + optimum-quanto.
  # Mixing those into the mflux pip --user pile (mflux pulls older torch) is
  # fragile, so we use a sibling venv. server/lib/pythonSetup.js looks for
  # this venv's interpreter when the active model has runner=='flux2'.
  FLUX2_VENV="${HOME}/.portos/venv-flux2"
  if ! venv_exists "$FLUX2_VENV"; then
    echo "📦 Creating FLUX.2 venv at ${FLUX2_VENV}..."
    mkdir -p "${HOME}/.portos"
    "$PYTHON_BIN" -m venv "$FLUX2_VENV"
  fi
  FLUX2_PY="$(venv_python "$FLUX2_VENV")"

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
    probe_or_fail \
      "flux2 venv built but 'from diffusers import Flux2KleinPipeline' failed." \
      "Try: $FLUX2_PY -m pip install --upgrade --force-reinstall 'diffusers @ git+https://github.com/huggingface/diffusers'" \
      "$FLUX2_PY" -c "from diffusers import Flux2KleinPipeline"
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
if [[ "$INSTALL_LTX25" == "1" ]]; then
  echo "   LTX-2.5:   ${HOME}/.portos/ltx-2.5-mlx/.venv/bin/python3 (MrMofer ltx25 fork @ ${LTX25_PIN:0:12})"
fi
if [[ "$INSTALL_FASTVIDEO" == "1" ]]; then
  echo "   FastVideo MLX: ${HOME}/.portos/fastvideo/.venv/bin/python3 (FastVideo @ ${FASTVIDEO_PIN:0:12})"
fi
if [[ "$INSTALL_WAN22" == "1" ]]; then
  echo "   Wan 2.2:  ${HOME}/.portos/mlx-gen/.venv/bin/python3 (MLX-Gen @ ${WAN22_PIN:0:12})"
  echo "              Weights remain uninstalled until Download is chosen in Video Gen."
fi
if [[ "$INSTALL_MINIMAX_H3" == "1" ]]; then
  echo "   MiniMax H3: ${HOME}/.portos/minimax-h3-mlx/.venv/bin/python3 (MLX port @ ${MINIMAX_H3_PIN:0:12})"
  echo "                Weights remain uninstalled until accepted and downloaded in Video Gen."
fi
if [[ "$INSTALL_MUSICGEN" == "1" ]] && is_macos; then
  echo "   MusicGen:  ${HOME}/.portos/venv-musicgen/bin/python3 (separate venv, MLX runtime @ ${HOME}/.portos/mlx-examples/musicgen)"
fi
if [[ "$INSTALL_MINIMAX_MUSIC3_MLX" == "1" ]] && is_macos && [[ "$(uname -m)" == "arm64" ]]; then
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
echo "Set this Python path in PortOS Settings → Image Gen → Local."
