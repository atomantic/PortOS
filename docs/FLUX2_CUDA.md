# FLUX.2 Windows/Linux runtime

The explicit FLUX.2 Install/Repair action (`INSTALL_FLUX2=1`) installs the
shared FLUX.2 / Qwen-Image 2.1 / Z-Image diffusers runtime in
`~/.portos/venv-flux2`. Apple Silicon uses its own lock
(`scripts/ml/requirements/requirements-flux2-mlx.lock.txt`). Windows (Git Bash) and Linux are
supported on x86_64 and need [uv](https://docs.astral.sh/uv/), which provisions
a dedicated managed CPython 3.11; Repair reuses standalone 3.11 environments and
rebuilds other Python minors or Conda-based environments, which can fail to load
torch DLLs on Windows. Intel macOS and non-x86_64 Windows/Linux hosts have no
lock and are refused.

The installer selects `scripts/ml/requirements/requirements-flux2-cuda-windows.lock.txt` or
`scripts/ml/requirements/requirements-flux2-cuda-linux.lock.txt` and runs
`uv pip sync --require-hashes --only-binary :all:` against the runtime
interpreter. Every distribution, including torch and its transitive CUDA
libraries, has an exact version and SHA-256 hashes. Repair removes packages
outside the lock. No pip/bootstrap upgrades or git sources run on this path. The
flow is shared with the other CUDA runtimes (`require_cuda_lock_host` and
`sync_cuda_lock_venv` in `scripts/setup-image-video.sh`). The in-app Image Gen
installer on Windows/Linux runs the same script instead of resolving packages
itself.

The direct pins (`scripts/ml/requirements/requirements-flux2-cuda.txt`) are the Apple Silicon
set with torch 2.14.1+cu126 (the build the other cu126 runtimes share).
diffusers 0.42.1 is a tagged release carrying `Flux2KleinPipeline` and
`QwenImage21Pipeline` and sdnq is on PyPI, so no git source, which a hash lock
cannot express, is needed. torchvision 0.29.2 is the PyPI wheel that pairs with
that torch (no matching `+cu126` build exists). The CUDA torch build also runs on
a host without an NVIDIA GPU; the readiness probe imports the pipeline classes
and does not require a CUDA device. A different `PORTOS_TORCH_CUDA_INDEX` is
rejected: changing CUDA requires regenerating and validating both locks.

Model weights remain a separate download on first render. Installing and
repairing never download weights.

## Regenerating locks

Edit `scripts/ml/requirements/requirements-flux2-cuda.txt` with exact direct pins, then follow the [shared procedure](./RUNTIME_LOCKS.md#regenerating-locks) with these values:

```bash
SLUG=flux2-cuda
LABEL="FLUX.2 CUDA"
DOC=docs/FLUX2_CUDA.md
CUDA_SCOPED="torch"
```

The CUDA index is scoped to **Torch** during resolution.

Run the [OSV audit](./RUNTIME_LOCKS.md#osv-audit) with `flux2-cuda` before merge.

## Fresh install and readiness evidence

Follow the [shared evidence procedure](./RUNTIME_LOCKS.md#fresh-install-and-readiness-evidence)
with:

```bash
export HOME="$PWD/.cache/flux2-validation-home"
export PORTOS_DATA="$HOME/data"
INSTALL_FLUX2=1 INSTALL_MFLUX=0 INSTALL_VIDEO=0 \
  bash scripts/setup-image-video.sh
# Repeat the same command to exercise Repair.
```

The installer's probe imports `Flux2KleinPipeline` and `QwenImage21Pipeline`. On
an NVIDIA host, also run:

```bash
"$HOME/.portos/venv-flux2/bin/python3" -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
```
