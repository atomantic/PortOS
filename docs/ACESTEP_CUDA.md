# ACE-Step Windows/Linux runtime

The explicit ACE-Step Install/Repair action (`INSTALL_ACESTEP=1`) installs the
full-song music runtime in `~/.portos/venv-acestep`. Apple Silicon uses its own
lock (`scripts/ml/requirements/requirements-acestep-mlx.lock.txt`). Windows (Git Bash) and Linux
are supported on x86_64 and need [uv](https://docs.astral.sh/uv/), which
provisions a dedicated managed CPython 3.11; Repair rebuilds other Python minors
and Conda-based environments. Intel macOS and non-x86_64 Windows/Linux hosts
have no lock and are refused. ACE-Step 1.5 is a separate runtime: see
[ACESTEP15_CUDA.md](./ACESTEP15_CUDA.md).

The installer selects `scripts/ml/requirements/requirements-acestep-cuda-windows.lock.txt` or
`scripts/ml/requirements/requirements-acestep-cuda-linux.lock.txt` and runs
`uv pip sync --require-hashes --only-binary :all: --no-binary docopt --no-binary unidic-lite`
with `--preview-features build-dependency-hashes --require-build-hashes` and the
universal `requirements-acestep-mlx-build.lock.txt` as build constraints.
Every distribution, including torch and its transitive CUDA libraries, has an
exact version and SHA-256 hashes; Repair removes packages outside the lock. The
flow is shared with the other CUDA runtimes (`require_cuda_lock_host` and
`sync_cuda_lock_venv` in `scripts/setup-image-video.sh`).

Two caveats follow from upstream packaging:

- `docopt` (via `num2words`) and `unidic-lite` (via `fugashi[unidic-lite]`)
  publish only source distributions, so exactly those two may build from their
  hash-verified sdists. Both are pure Python. Their isolated build dependencies
  must also match the complete universal build lock, shared with Apple Silicon
  despite its historical `mlx` filename. Missing or mismatched build hashes
  fail installation; no unpinned backend can resolve.
- The `acestep` package is a git-only project. As on Apple Silicon, the
  installer clones `ace-step/ACE-Step`, checks out `ACESTEP_PIN`, and installs the
  checkout with `uv pip install --no-deps --no-build-isolation` after the sync
  (the lock carries the `setuptools` and `wheel` that build needs). A git SHA
  cannot satisfy `--require-hashes`, so the package itself is pinned by commit.

Direct pins are in `scripts/ml/requirements/requirements-acestep-cuda.txt`: the Apple Silicon
dependency set with torch 2.14.1+cu126 (the build the other cu126 runtimes
share). torchvision 0.29.2 and torchaudio 2.11.1 are the PyPI wheels that pair
with that torch (no matching `+cu126` builds exist). A different
`PORTOS_TORCH_CUDA_INDEX` is rejected; changing CUDA requires regenerating and
validating both locks. Checkpoints download to `~/.cache/ace-step` on first
generation, never during install.

The set is inference-only: upstream's trainer packages (`tensorboard`,
`tensorboardX`, `datasets`, `pytorch-lightning`, `matplotlib`) are not imported by
`acestep.pipeline_ace_step` at the pinned commit and are not in the locks.
Re-walk the import graph before bumping `ACESTEP_PIN`.

## Regenerating locks

Edit `scripts/ml/requirements/requirements-acestep-cuda.txt` with exact direct pins, then follow the [shared procedure](./RUNTIME_LOCKS.md#regenerating-locks) with these values:

```bash
SLUG=acestep-cuda
LABEL="ACE-Step CUDA"
DOC=docs/ACESTEP_CUDA.md
CUDA_SCOPED="torch"
COMPILE_EXTRA=(
  --upgrade-package filelock==4.2.9 --upgrade-package typing-inspection==0.4.5
  --no-binary docopt --no-binary unidic-lite
  --preview-features build-dependency-hashes --require-build-hashes
  --build-constraints "$PWD/scripts/ml/requirements/requirements-acestep-mlx-build.lock.txt"
)
```

The CUDA index is scoped to **Torch** during resolution. The build constraints file is relative to the repository root.

Run the [OSV audit](./RUNTIME_LOCKS.md#osv-audit) with `acestep-cuda` before merge.

## Fresh install and readiness evidence

Follow the [shared evidence procedure](./RUNTIME_LOCKS.md#fresh-install-and-readiness-evidence).
Needs an NVIDIA CUDA host for a meaningful probe. Use an isolated home:

```bash
export HOME="$PWD/.cache/acestep-validation-home"
export PORTOS_DATA="$HOME/data"
INSTALL_ACESTEP=1 INSTALL_MFLUX=0 INSTALL_VIDEO=0 INSTALL_FLUX2=0 \
  bash scripts/setup-image-video.sh
# Repeat to exercise Repair.
"$HOME/.portos/venv-acestep/bin/python3" -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
```

The installer's own probe imports `ACEStepPipeline`.
