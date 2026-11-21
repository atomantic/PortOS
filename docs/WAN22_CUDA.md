# Wan 2.2 CUDA runtime

Video Gen's explicit Install/Repair action installs Wan 2.2 in
`~/.portos/wan2.2-cuda/.venv`. It requires x86_64 Windows or Linux, an NVIDIA
GPU/driver compatible with CUDA 12.6, and [uv](https://docs.astral.sh/uv/).
Linux additionally requires **glibc 2.28+ and kernel 4.18+**, the minimums of
the bundled FFmpeg executable; the Torch wheel also requires glibc 2.28+.
The standard PortOS Python prerequisite still applies; uv provisions the
dedicated uv-managed CPython 3.11 automatically, without selecting Conda from
PATH. A previous runtime built with another Python minor version or a Conda base
is rebuilt in the same location; no Python path setting is
needed. Model weights remain a separate explicit download.

The installer selects `scripts/ml/requirements/requirements-wan22-cuda-windows.lock.txt` or
`scripts/ml/requirements/requirements-wan22-cuda-linux.lock.txt`, then runs `uv pip sync` with
`--require-hashes --only-binary :all:`. This includes torch, torchvision,
setuptools, and every transitive dependency. Sync removes packages outside the
lock during Repair. There is no separate unpinned pip/bootstrap/torch install.
The direct requirements file is an input to lock generation only.
Video Gen compares every installed dependency version with the host's lock,
including transitive packages, before treating an existing runtime as current.
An older or incomplete environment therefore offers Upgrade/Repair.

The stack is torch 2.14.1 / torchvision 0.29.1 with the `+cu126` build tag,
diffusers 0.42.0 and transformers 5.22.2. Newer transformers pins replace the old
4.x range to clear its OSV advisories. `PORTOS_TORCH_CUDA_INDEX` overrides remain
available to other runtimes; Wan rejects a different index because its locks
describe this exact CUDA stack. Changing CUDA requires regenerating and
validating both locks together.

## Regenerating locks

Edit `scripts/ml/requirements/requirements-wan22-cuda.txt` with exact direct pins, then follow the [shared procedure](./RUNTIME_LOCKS.md#regenerating-locks) with these values:

```bash
SLUG=wan22-cuda
LABEL="Wan 2.2 CUDA"
DOC=docs/WAN22_CUDA.md
CUDA_SCOPED="torch torchvision"
```

The CUDA index is scoped to **Torch and Torchvision** during resolution.

Run the [OSV audit](./RUNTIME_LOCKS.md#osv-audit) with `wan22-cuda` before merge.

## Fresh install and readiness evidence

Follow the [shared evidence procedure](./RUNTIME_LOCKS.md#fresh-install-and-readiness-evidence).
Set `INSTALL_WAN22_CUDA=1`, `INSTALL_MFLUX=0`, `INSTALL_VIDEO=0`, and
`INSTALL_FLUX2=0`, then run `bash scripts/setup-image-video.sh`. Windows uses
Git Bash; Linux uses Bash. The final probe imports torch, hf_xet,
AutoencoderKLWan and WanPipeline, and asserts `torch.cuda.is_available()`.
Repeat Repair to verify the locked set remains unchanged. Do not download model
weights or generate a video for this readiness check.
