# AudioLDM2 Windows/Linux runtime

The explicit AudioLDM2 Install/Repair action (`INSTALL_AUDIOLDM2=1`) installs
the runtime in `~/.portos/venv-audioldm2`. Apple Silicon uses its own lock
(`scripts/ml/requirements/requirements-audioldm2-mlx.lock.txt`). Windows (Git Bash) and Linux
are supported on x86_64 and need [uv](https://docs.astral.sh/uv/), which
provisions a dedicated managed CPython 3.11. Repair reuses standalone 3.11
environments and rebuilds other Python minors or Conda-based environments,
which can fail to load torch DLLs on Windows. Intel macOS and non-x86_64
Windows/Linux hosts have no lock and are refused.

The installer selects `scripts/ml/requirements/requirements-audioldm2-cuda-windows.lock.txt`
or `scripts/ml/requirements/requirements-audioldm2-cuda-linux.lock.txt` and runs
`uv pip sync --require-hashes --only-binary :all:` against the runtime
interpreter. Every distribution, including torch and its transitive CUDA
libraries, has an exact version and SHA-256 hashes. Repair removes packages
outside the lock. No pip/bootstrap upgrades run on this path.

The stack uses torch 2.14.1+cu126 (the build the other cu126 runtimes share),
diffusers 0.42.1, transformers 5.22.2, huggingface-hub 2.4.0 with hf-xet,
sentencepiece 0.2.3, accelerate 1.15.0, numpy 2.4.6 and scipy 1.17.1, matching
the Apple Silicon lock's direct pins. The CUDA torch build also runs on a host
without an NVIDIA GPU, so AudioLDM2 keeps its CPU fallback; the readiness probe
imports the pipeline and does not require a CUDA device. A different
`PORTOS_TORCH_CUDA_INDEX` is rejected for this runtime: changing CUDA requires
regenerating and validating both locks.

Model weights remain a separate explicit download. Installing and repairing
never download weights or generate audio.

## Regenerating locks

Edit `scripts/ml/requirements/requirements-audioldm2-cuda.txt` with exact direct pins, then follow the [shared procedure](./RUNTIME_LOCKS.md#regenerating-locks) with these values:

```bash
SLUG=audioldm2-cuda
LABEL="AudioLDM2 CUDA"
DOC=docs/AUDIOLDM2_CUDA.md
CUDA_SCOPED="torch"
```

AudioLDM2 has no Torchvision dependency, so only Torch is scoped to the CUDA index.

Run the [OSV audit](./RUNTIME_LOCKS.md#osv-audit) with `audioldm2-cuda` before merge.

## Fresh install and readiness evidence

Follow the [shared evidence procedure](./RUNTIME_LOCKS.md#fresh-install-and-readiness-evidence)
with:

```bash
export HOME="$PWD/.cache/audioldm2-validation-home"
export PORTOS_DATA="$HOME/data"
INSTALL_AUDIOLDM2=1 INSTALL_MFLUX=0 INSTALL_VIDEO=0 INSTALL_FLUX2=0 \
  bash scripts/setup-image-video.sh
# Repeat the same command to exercise Repair.
```

The installer's probe imports torch and `AudioLDM2Pipeline`. On an NVIDIA host,
also run:

```bash
"$HOME/.portos/venv-audioldm2/bin/python3" -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
```
