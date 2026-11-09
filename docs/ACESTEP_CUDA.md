# ACE-Step Windows/Linux runtime

The explicit ACE-Step Install/Repair action (`INSTALL_ACESTEP=1`) installs the
full-song music runtime in `~/.portos/venv-acestep`. Apple Silicon uses its own
lock (`scripts/requirements-acestep-mlx.lock.txt`). Windows (Git Bash) and Linux
are supported on x86_64 and need [uv](https://docs.astral.sh/uv/), which
provisions a dedicated managed CPython 3.11; Repair rebuilds other Python minors
and Conda-based environments. Intel macOS and non-x86_64 Windows/Linux hosts
have no lock and are refused. ACE-Step 1.5 is a separate runtime: see
[ACESTEP15_CUDA.md](./ACESTEP15_CUDA.md).

The installer selects `scripts/requirements-acestep-cuda-windows.lock.txt` or
`scripts/requirements-acestep-cuda-linux.lock.txt` and runs
`uv pip sync --require-hashes --only-binary :all: --no-binary docopt --no-binary unidic-lite`.
Every distribution, including torch and its transitive CUDA libraries, has an
exact version and SHA-256 hashes; Repair removes packages outside the lock. The
flow is shared with the other CUDA runtimes (`require_cuda_lock_host` and
`sync_cuda_lock_venv` in `scripts/setup-image-video.sh`).

Two caveats follow from upstream packaging:

- `docopt` (via `num2words`) and `unidic-lite` (via `fugashi[unidic-lite]`)
  publish only source distributions, so exactly those two may build from their
  hash-verified sdists. Both are pure Python. Their build backend
  (setuptools) resolves in uv's isolated build environment and is not hashed.
- The `acestep` package is a git-only project. As on Apple Silicon, the
  installer clones `ace-step/ACE-Step`, checks out `ACESTEP_PIN`, and installs the
  checkout with `uv pip install --no-deps --no-build-isolation` after the sync
  (the lock carries the `setuptools` and `wheel` that build needs). A git SHA
  cannot satisfy `--require-hashes`, so the package itself is pinned by commit.

Direct pins are in `scripts/requirements-acestep-cuda.txt`: the Apple Silicon
dependency set with torch 2.14.1+cu126 (the build the other cu126 runtimes
share). torchvision 0.29.2 and torchaudio 2.11.1 are the PyPI wheels that pair
with that torch (no matching `+cu126` builds exist). A different
`PORTOS_TORCH_CUDA_INDEX` is rejected; changing CUDA requires regenerating and
validating both locks. Checkpoints download to `~/.cache/ace-step` on first
generation, never during install.

## Regenerating locks

Edit `scripts/requirements-acestep-cuda.txt`. Using uv 0.13.1, run from the
repository root (Bash):

```bash
for target in windows linux; do
  case "$target" in
    windows) platform=x86_64-pc-windows-msvc ;;
    linux) platform=x86_64-manylinux_2_28 ;;
  esac
  out="scripts/requirements-acestep-cuda-${target}.lock.txt"
  uv pip compile scripts/requirements-acestep-cuda.txt \
    --python-version 3.11 --python-platform "$platform" \
    --generate-hashes --only-binary :all: \
    --no-binary docopt --no-binary unidic-lite \
    --index-url https://pypi.org/simple \
    --extra-index-url https://download.pytorch.org/whl/cu126 \
    --index-strategy unsafe-best-match --emit-index-url \
    --no-header --annotation-style line --exclude-newer 2026-11-01 \
    -o "$out"
done
```

Advance the cutoff to a UTC date at least seven days before the update, and
restore each lock's two-line target/cutoff header (see the existing locks).
Delete the old lock first so uv does not reuse its preferences. See
[AudioLDM2](./AUDIOLDM2_CUDA.md#regenerating-locks) for the multi-index
rationale and the OSV query (including `MAL-` records) to run against
`requirements-acestep-cuda-{target}.lock.txt` immediately before merge.

## Fresh install and readiness evidence

Needs an NVIDIA CUDA host for a meaningful probe. Use an isolated home:

```bash
export HOME="$PWD/.cache/acestep-validation-home"
export PORTOS_DATA="$HOME/data"
INSTALL_ACESTEP=1 INSTALL_MFLUX=0 INSTALL_VIDEO=0 INSTALL_FLUX2=0 \
  bash scripts/setup-image-video.sh
# Repeat to exercise Repair.
"$HOME/.portos/venv-acestep/bin/python3" -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
```

(`Scripts/python.exe` on Windows.) The installer's own probe imports
`ACEStepPipeline`. Record OS, GPU, driver/CUDA, Python/torch versions, the
selected lock and redacted probe output; run `uv pip check --python` with the
venv interpreter and confirm Repair leaves versions unchanged. A Windows probe
does not certify Linux. Import evidence does not claim generation quality.
