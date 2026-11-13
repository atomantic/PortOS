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

Edit `scripts/requirements-acestep15-cuda.txt`, then use hash-verified uv
0.13.7 and the [scoped-index recipe](./WAN22_CUDA.md#regenerating-locks),
substituting ACE-Step 1.5's source/output names. Scope Torch and retained
CUDA-local packages (currently Torchcodec) to the explicit CUDA index;
Torchvision/TorchAudio stay on PyPI. Preserve CPython 3.11, both x86_64 target
platforms, existing output pins, markers and unrelated hash blocks. Do not
remove the old output before resolving. Advance the cutoff to at least seven
days ago and restore each target/cutoff header.

Ordinary PyPI packages on the CUDA mirror can lack upload dates and fail
cooldown validation. The
[bounded #15988 procedure](./PYTHON_RUNTIME_REFRESH.md#newly-cooled-follow-on-2026-11-13-15988)
describes complete-closure constraints and selective generated-block transfer.
Query OSV for every resolved package, including `MAL-`, using
[AudioLDM2's audit](./AUDIOLDM2_CUDA.md#regenerating-locks) with the ACE-Step
1.5 lock paths. Check response counts, errors and pagination; any unreadable
result or advisory blocks publication.

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
