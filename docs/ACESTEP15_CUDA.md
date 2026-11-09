# ACE-Step 1.5 Windows/Linux runtime

The explicit ACE-Step 1.5 Install/Repair action (`INSTALL_ACESTEP15=1`) installs
the music runtime in `~/.portos/venv-acestep15`. Apple Silicon uses its own lock
(`scripts/requirements-acestep15-mlx.lock.txt`). Windows (Git Bash) and Linux are
supported on x86_64 and need [uv](https://docs.astral.sh/uv/), which provisions a
dedicated managed CPython 3.11; Repair rebuilds other Python minors and
Conda-based environments. Intel macOS and non-x86_64 Windows/Linux hosts have no
lock and are refused. ACE-Step v1 is a separate runtime:
[ACESTEP_CUDA.md](./ACESTEP_CUDA.md).

The installer selects `scripts/requirements-acestep15-cuda-windows.lock.txt` or
`scripts/requirements-acestep15-cuda-linux.lock.txt` and runs
`uv pip sync --require-hashes --only-binary :all:`. Every distribution, including
torch and its transitive CUDA libraries, has an exact version and SHA-256 hashes;
Repair removes packages outside the lock. The flow is shared with the other CUDA
runtimes (`require_cuda_lock_host` and `sync_cuda_lock_venv` in
`scripts/setup-image-video.sh`). Every distribution in the lock has a wheel, so
nothing builds at install time.

The `acestep` package is a git-only project. As on Apple Silicon, the installer
clones `ace-step/ACE-Step-1.5`, checks out `ACESTEP15_PIN` (the v0.1.8 release
commit), and installs the checkout with
`uv pip install --no-deps --no-build-isolation --ignore-requires-python` after
the sync. A git SHA cannot satisfy `--require-hashes`, so the package itself is
pinned by commit. `--no-deps` also keeps its own cu128 torch pins from displacing
the shared cu126 lock; the optional `nano-vllm` accelerator is omitted.

Direct pins are in `scripts/requirements-acestep15-cuda.txt`: the Apple Silicon
dependency set with torch 2.14.1+cu126 (the build the other cu126 runtimes
share) and without the Apple-only `mlx`/`mlx-lm`. A different
`PORTOS_TORCH_CUDA_INDEX` is rejected; changing CUDA requires regenerating and
validating both locks. Model snapshots install separately through Music, never
during install.

## Regenerating locks

Edit `scripts/requirements-acestep15-cuda.txt`. Using uv 0.13.1, run from the
repository root (Bash):

```bash
for target in windows linux; do
  case "$target" in
    windows) platform=x86_64-pc-windows-msvc ;;
    linux) platform=x86_64-manylinux_2_28 ;;
  esac
  out="scripts/requirements-acestep15-cuda-${target}.lock.txt"
  rm -f "$out"
  uv pip compile scripts/requirements-acestep15-cuda.txt \
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
restore each lock's two-line target/cutoff header (see the existing locks). See
[AudioLDM2](./AUDIOLDM2_CUDA.md#regenerating-locks) for the multi-index
rationale and the OSV query (including `MAL-` records) to run against
`requirements-acestep15-cuda-{target}.lock.txt` immediately before merge.

## Fresh install and readiness evidence

Needs an NVIDIA CUDA host for a meaningful probe. Use an isolated home:

```bash
export HOME="$PWD/.cache/acestep15-validation-home"
export PORTOS_DATA="$HOME/data"
INSTALL_ACESTEP15=1 INSTALL_MFLUX=0 INSTALL_VIDEO=0 INSTALL_FLUX2=0 \
  bash scripts/setup-image-video.sh
# Repeat to exercise Repair.
"$HOME/.portos/venv-acestep15/bin/python3" -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
```

(`Scripts/python.exe` on Windows.) The installer's own probe imports the
Transformers runtime and `acestep.inference`. Record OS, GPU, driver/CUDA,
Python/torch versions, the selected lock and redacted probe output; run
`uv pip check --python` with the venv interpreter and confirm Repair leaves
versions unchanged. A Windows probe does not certify Linux. Import evidence does
not claim generation quality.
