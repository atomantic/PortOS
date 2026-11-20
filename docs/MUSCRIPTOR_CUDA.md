# MuScriptor Windows/Linux runtime

The explicit MuScriptor Install/Repair action (`INSTALL_MUSCRIPTOR=1`) installs
the audio → MIDI transcription runtime in `~/.portos/venv-muscriptor`. Apple
Silicon uses its own lock (`scripts/ml/requirements/requirements-muscriptor-mlx.lock.txt`).
Windows (Git Bash) and Linux are supported on x86_64 and need
[uv](https://docs.astral.sh/uv/), which provisions a dedicated managed CPython
3.11. Repair reuses standalone 3.11 environments and rebuilds other Python
minors or Conda-based environments, which can fail to load torch DLLs on
Windows. Intel macOS and non-x86_64 Windows/Linux hosts have no lock and are
refused.

On Apple Silicon, `update.sh` checks the version in an existing default
MuScriptor venv and refreshes it from the Apple Silicon lock when the pin
changes. If the refresh fails, the next transcription reports the version
mismatch and the manual repair command. On the Music Video Song page, a
transcription failure stays visible with a retry button after navigating away
or reloading. Audio that libsndfile cannot open, including Suno AAC/M4A imports,
is decoded to a temporary WAV with FFmpeg before transcription.

The installer selects `scripts/ml/requirements/requirements-muscriptor-cuda-windows.lock.txt`
or `scripts/ml/requirements/requirements-muscriptor-cuda-linux.lock.txt` and runs
`uv pip sync --require-hashes --only-binary :all:` against the runtime
interpreter. Every distribution, including torch and its transitive CUDA
libraries, has an exact version and SHA-256 hashes. Repair removes packages
outside the lock. No pip/bootstrap upgrades run on this path. The flow is
shared with AudioLDM2 and MiniMax Music 3 CUDA (`require_cuda_lock_host` and
`sync_cuda_lock_venv` in `scripts/setup-image-video.sh`).

The direct pins (`scripts/ml/requirements/requirements-muscriptor-cuda.txt`) are torch
2.14.1+cu126 (the build the other cu126 runtimes share), muscriptor 0.4.0 and
huggingface-hub 2.4.0 with hf-xet, matching the Apple Silicon lock's
muscriptor and hub pins. The resolved torchaudio 2.11.1 (a `py3-none` wheel
declaring `torch>=2.11`) is the version the Apple Silicon lock uses. TorchAudio
2.11 is its final maintenance line, which upstream states works with torch 2.11
and every later release, so no matched `+cu126` torchaudio build exists or is
needed. The CUDA
torch build also runs on a host without an NVIDIA GPU, so MuScriptor keeps its
CPU fallback; the readiness probe imports `TranscriptionModel` and does not
require a CUDA device. A different `PORTOS_TORCH_CUDA_INDEX` is rejected for
this runtime: changing CUDA requires regenerating and validating both locks.

Model weights remain a separate download on first transcription. Installing
and repairing never download weights or transcribe audio.

## Regenerating locks

Edit `scripts/ml/requirements/requirements-muscriptor-cuda.txt` with exact direct pins, then follow the [shared procedure](./RUNTIME_LOCKS.md#regenerating-locks) with these values:

```bash
SLUG=muscriptor-cuda
LABEL="MuScriptor CUDA"
DOC=docs/MUSCRIPTOR_CUDA.md
CUDA_SCOPED="torch"
```

Only Torch resolves from the CUDA index; its existing native hashes and
transitive CUDA/Triton baseline remain unchanged.

Run the [OSV audit](./RUNTIME_LOCKS.md#osv-audit) with `muscriptor-cuda` before merge.

## Fresh install and readiness evidence

Follow the [shared evidence procedure](./RUNTIME_LOCKS.md#fresh-install-and-readiness-evidence)
with:

```bash
export HOME="$PWD/.cache/muscriptor-validation-home"
export PORTOS_DATA="$HOME/data"
INSTALL_MUSCRIPTOR=1 INSTALL_MFLUX=0 INSTALL_VIDEO=0 INSTALL_FLUX2=0 \
  bash scripts/setup-image-video.sh
# Repeat the same command to exercise Repair.
```

The installer's probe imports `TranscriptionModel`. On an NVIDIA host, also
run:

```bash
"$HOME/.portos/venv-muscriptor/bin/python3" -c "import torch, torchaudio; print(torch.__version__, torch.version.cuda, torch.cuda.is_available(), torchaudio.__version__)"
```
