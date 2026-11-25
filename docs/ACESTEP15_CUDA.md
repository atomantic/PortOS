# ACE-Step 1.5 Windows/Linux runtime

The explicit ACE-Step 1.5 Install/Repair action (`INSTALL_ACESTEP15=1`) installs
the music runtime in `~/.portos/venv-acestep15`. Apple Silicon uses its own lock
(`scripts/ml/requirements/requirements-acestep15-mlx.lock.txt`). Windows (Git Bash) and Linux are
supported on x86_64 and need [uv](https://docs.astral.sh/uv/), which provisions a
dedicated managed CPython 3.11; Repair rebuilds other Python minors and
Conda-based environments. Intel macOS and non-x86_64 Windows/Linux hosts have no
lock and are refused. ACE-Step v1 is a separate runtime:
[ACESTEP_CUDA.md](./ACESTEP_CUDA.md).

The installer selects `scripts/ml/requirements/requirements-acestep15-cuda-windows.lock.txt` or
`scripts/ml/requirements/requirements-acestep15-cuda-linux.lock.txt` and runs
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

Direct pins are in `scripts/ml/requirements/requirements-acestep15-cuda.txt`: the Apple Silicon
dependency set with torch 2.14.1+cu126 (the build the other cu126 runtimes
share) and without the Apple-only `mlx`/`mlx-lm`. A different
`PORTOS_TORCH_CUDA_INDEX` is rejected; changing CUDA requires regenerating and
validating both locks. Model snapshots install separately through Music, never
during install.

The set is inference-only: upstream's training, TensorBoard, plotting and
ModelScope packages (`tensorboard`, `lightning`, `lycoris-lora`, `toml`,
`matplotlib`, `modelscope`) are not imported by `acestep.handler` /
`acestep.inference` at the pinned commit and are not in the locks. Re-walk the
import graph before bumping `ACESTEP15_PIN`.

## Regenerating locks

Edit `scripts/ml/requirements/requirements-acestep15-cuda.txt`, then follow the [shared procedure](./RUNTIME_LOCKS.md#regenerating-locks)
with these values:

```bash
SLUG=acestep15-cuda
LABEL="ACE-Step 1.5 CUDA"
DOC=docs/ACESTEP15_CUDA.md
CUDA_SCOPED="torch torchcodec"
LINUX_CUDA_SCOPED="torchao"
```

Scope Torch and retained CUDA-local packages (currently Torchcodec) to the
explicit CUDA index; Linux also routes `torchao==0.16.0+cu126` there, while
Windows keeps PyPI `torchao==0.16.0`. Torchvision/TorchAudio stay on PyPI. Run the
[OSV audit](./RUNTIME_LOCKS.md#osv-audit) with `acestep15-cuda`.

## Fresh install and readiness evidence

Follow the [shared evidence procedure](./RUNTIME_LOCKS.md#fresh-install-and-readiness-evidence).
Needs an NVIDIA CUDA host for a meaningful probe. Use an isolated home:

```bash
export HOME="$PWD/.cache/acestep15-validation-home"
export PORTOS_DATA="$HOME/data"
INSTALL_ACESTEP15=1 INSTALL_MFLUX=0 INSTALL_VIDEO=0 INSTALL_FLUX2=0 \
  bash scripts/setup-image-video.sh
# Repeat to exercise Repair.
"$HOME/.portos/venv-acestep15/bin/python3" -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
```

The installer's own probe imports the Transformers runtime and
`acestep.inference`.
