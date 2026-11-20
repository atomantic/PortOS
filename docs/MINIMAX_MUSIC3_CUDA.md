# MiniMax Music 3 CUDA runtime

Music Studio's explicit Install/Repair action installs the runtime in
`~/.portos/venv-minimax-music3`. It supports x86_64 Windows (Git Bash) and
Linux with an NVIDIA GPU/driver compatible with CUDA 12.6 and
[uv](https://docs.astral.sh/uv/). The standard PortOS Python prerequisite still
applies; uv provisions a dedicated managed CPython 3.11. Repair reuses standalone
3.11 environments and rebuilds other Python minors or Conda-based environments,
which can fail to load torch DLLs on Windows. No manual Python path is needed.

The installer selects `scripts/ml/requirements/requirements-minimax-music3-cuda-windows.lock.txt`
or `scripts/ml/requirements/requirements-minimax-music3-cuda-linux.lock.txt` and runs
`uv pip sync --require-hashes --only-binary :all:` against the explicit runtime
interpreter. Every distribution, including torch and its transitive CUDA
libraries, has an exact version and SHA-256 hashes. Repair removes packages
outside the lock. No pip/bootstrap upgrades or Git builds run on this path.

The stack uses torch 2.14.1+cu126, diffusers 0.42.1, transformers 5.22.2,
accelerate 1.15.0, huggingface-hub 2.4.0 and numpy 2.4.6 (the Python 3.11
compatible line). The released Diffusers wheel contains MiniMax Music 3's
modular pipeline, replacing the former Git commit install. A different
`PORTOS_TORCH_CUDA_INDEX` is rejected for this runtime: changing CUDA requires
regenerating and validating both locks. Other CUDA runtimes keep their own
installation policy.

Model weights (~29 GB) remain a separate explicit download from Music → Generate.
Installing, repairing and checking readiness never download weights or generate
music. Renderer performance/listening requirements remain in
[Music renderer benchmark evidence](features/music-renderer-benchmarks.md).

## Regenerating locks

Edit `scripts/ml/requirements/requirements-minimax-music3-cuda.txt` with exact direct pins, then follow the [shared procedure](./RUNTIME_LOCKS.md#regenerating-locks) with these values:

```bash
SLUG=minimax-music3-cuda
LABEL="MiniMax Music 3 CUDA"
DOC=docs/MINIMAX_MUSIC3_CUDA.md
CUDA_SCOPED="torch"
```

Only Torch resolves from the CUDA index; its existing native hashes and
transitive CUDA/Triton baseline remain unchanged.

Run the [OSV audit](./RUNTIME_LOCKS.md#osv-audit) with `minimax-music3-cuda` before merge.

## Fresh install and readiness evidence

Follow the [shared evidence procedure](./RUNTIME_LOCKS.md#fresh-install-and-readiness-evidence)
with:

```bash
export HOME="$PWD/.cache/music3-validation-home"
export PORTOS_DATA="$HOME/data"
INSTALL_MINIMAX_MUSIC3=1 INSTALL_MFLUX=0 INSTALL_VIDEO=0 INSTALL_FLUX2=0 \
  bash scripts/setup-image-video.sh
# Repeat the same command to exercise Repair.
```

The final probe imports torch, `ModularPipeline`, and `MiniMaxMusic3Blocks`, then
asserts `torch.cuda.is_available()`. Importing the concrete Music 3 blocks also
checks the released package retains this runtime's integration.
