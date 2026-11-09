# MuScriptor Windows/Linux runtime

The explicit MuScriptor Install/Repair action (`INSTALL_MUSCRIPTOR=1`) installs
the audio → MIDI transcription runtime in `~/.portos/venv-muscriptor`. Apple
Silicon uses its own lock (`scripts/requirements-muscriptor-mlx.lock.txt`).
Windows (Git Bash) and Linux are supported on x86_64 and need
[uv](https://docs.astral.sh/uv/), which provisions a dedicated managed CPython
3.11. Repair reuses standalone 3.11 environments and rebuilds other Python
minors or Conda-based environments, which can fail to load torch DLLs on
Windows. Intel macOS and non-x86_64 Windows/Linux hosts have no lock and are
refused.

The installer selects `scripts/requirements-muscriptor-cuda-windows.lock.txt`
or `scripts/requirements-muscriptor-cuda-linux.lock.txt` and runs
`uv pip sync --require-hashes --only-binary :all:` against the runtime
interpreter. Every distribution, including torch and its transitive CUDA
libraries, has an exact version and SHA-256 hashes. Repair removes packages
outside the lock. No pip/bootstrap upgrades run on this path. The flow is
shared with AudioLDM2 and MiniMax Music 3 CUDA (`require_cuda_lock_host` and
`sync_cuda_lock_venv` in `scripts/setup-image-video.sh`).

The direct pins (`scripts/requirements-muscriptor-cuda.txt`) are torch
2.14.1+cu126 (the build the other cu126 runtimes share), muscriptor 0.4.0 and
huggingface-hub 0.36.2 with hf-xet, matching the Apple Silicon lock's
muscriptor and hub pins. The resolved torchaudio 2.11.1 (a `py3-none` wheel
declaring `torch>=2.11`) is the version the Apple Silicon lock uses. The CUDA
torch build also runs on a host without an NVIDIA GPU, so MuScriptor keeps its
CPU fallback; the readiness probe imports `TranscriptionModel` and does not
require a CUDA device. A different `PORTOS_TORCH_CUDA_INDEX` is rejected for
this runtime: changing CUDA requires regenerating and validating both locks.

Model weights remain a separate download on first transcription. Installing
and repairing never download weights or transcribe audio.

## Regenerating locks

Edit `scripts/requirements-muscriptor-cuda.txt` with exact direct pins. Using
uv 0.13.1, run from the repository root (Bash):

```bash
for target in windows linux; do
  case "$target" in
    windows) platform=x86_64-pc-windows-msvc ;;
    linux) platform=x86_64-manylinux_2_28 ;;
  esac
  out="scripts/requirements-muscriptor-cuda-${target}.lock.txt"
  uv pip compile scripts/requirements-muscriptor-cuda.txt \
    --python-version 3.11 --python-platform "$platform" \
    --generate-hashes --only-binary :all: \
    --index-url https://pypi.org/simple \
    --extra-index-url https://download.pytorch.org/whl/cu126 \
    --index-strategy unsafe-best-match --emit-index-url \
    --no-header --annotation-style line --exclude-newer 2026-11-01 \
    -o "$out"
done
```

Advance the cutoff to a UTC date at least seven days before the update, and
restore each lock's two-line target/cutoff header after regenerating. The
multi-index strategy permits current PyPI packages alongside CUDA wheels; see
[AudioLDM2](./AUDIOLDM2_CUDA.md#regenerating-locks) for why.

Query OSV for **every resolved package**, including `MAL-` records,
immediately before merge, using the script in
[AudioLDM2's regeneration section](./AUDIOLDM2_CUDA.md#regenerating-locks) with
`requirements-muscriptor-cuda-{target}.lock.txt` as the lock path. Any
advisory or unreadable response blocks the merge.

## Fresh install and readiness evidence

Use an isolated home/data directory to exercise the actual installer without
replacing a working runtime. From Bash, with no other runtime install flags set:

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

(`Scripts/python.exe` on Windows) and expect `True`. Record OS, GPU model,
driver/driver-supported CUDA, Python/torch/bundled CUDA versions, selected lock
and redacted probe output in the PR. Run `uv pip check --python` with the
installed interpreter and verify Repair leaves the lock's versions unchanged. A
Windows probe does not certify the Linux target; untested targets retain their
hardware evidence requirement. Import/readiness evidence does not claim
transcription quality or speed.
