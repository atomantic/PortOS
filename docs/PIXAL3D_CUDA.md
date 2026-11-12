# Pixal3D CUDA runtime

Install and **Repair install** use `scripts/setup-pixal3d-cuda.py`. It reuses
[TRELLIS.2 CUDA](TRELLIS2_CUDA.md)'s artifact/build primitives, not its runtime
environment or upstream setup script. The initial profile requires native Linux
x86_64, glibc 2.28+, CUDA toolkit **12.6.3** (nvcc **12.6.85**), GCC/G++
**11.3.0**, NVIDIA compute capability **8.6**, and **12 GiB VRAM** or more.
WSL2 is refused before downloads or environment changes because Pixal3D's NAF
pipeline has a separate upstream driver failure there. TRELLIS.2 CUDA remains
the WSL2 option. The bootstrap Python needs `tarfile.data_filter`.

`scripts/pixal3d-cuda-profile.json` records Conda CPython 3.11.16, Torch
2.14.1+cu126, TorchVision 0.29.1+cu126, 27 Conda artifacts plus micromamba, and
15 immutable source archives. The separate runtime/build closures contain 88
and eight wheels respectively. They include utils3d's verified release wheel,
its four dependencies, MoGe's dependencies and CMake for NATTEN. Wheels install
with hashes, binary-only and no dependency resolution. Native builds use local
sources, no index, no dependency resolution and no build isolation.

The source inventory adds Pixal3D `f7cf384`, MoGe `0744441`, pipeline `866f059`,
NAF `37f2dfc` and NATTEN 0.21.0 to the shared native sources. Full revisions,
URLs and SHA-256 values are in the profile. NATTEN's sdist includes CUTLASS;
no build-time submodule fetch is needed. Its CMake standard is patched to
C++20 for the locked Torch headers. `NATTEN_CUDA_ARCH=8.6` and
`NATTEN_N_WORKERS=2` fix architecture and parallelism; the shared native builds
also retain their two-worker limit.

This environment supports inference, not the upstream Gradio web application.
MoGe's metadata replaces its utils3d/pipeline Git dependencies with the locked
local distributions, removes unused Gradio, and uses `opencv-python-headless`
instead of installing two distributions that overwrite `cv2`. MoGe's UI commands
are not supported here.

## NAF and degraded quality

The pinned Pixal3D source downloads NAF code from a moving `torch.hub` GitHub
reference and does not implement the previously advertised missing-NATTEN
fallback. PortOS patches its private snapshot to load the hash-verified local
NAF source. Model weights still download during explicit renders; package locks
do not freeze weights. Both DINOv3 extractors are adapted to the locked
Transformers 5.22.1 encoder interface.

If NATTEN fails to compile, setup removes any partial NATTEN installation and
verifies the remaining environment. The high-resolution projection then uses
bilinear-interpolated DINO features instead of NAF's learned refinement. Both
low/high projected feature halves remain, preserving the model's channel count.
The target reports **NAF fallback** and lower geometry/texture detail. Repair
retries the pinned build. A present but broken NATTEN import or CUDA operation
fails verification rather than silently selecting fallback.

## Repair and verification

The private interpreter and sources live inside `<runtime>/.conda`. Repair
rebuilds only that directory. Weights outside it, the legacy checkout and the
normal Hugging Face cache remain untouched. Completion requires native imports,
a tiny DINO feature extraction, a FlashAttention CUDA operation and `pip check`.
When NATTEN is present, verification also exercises neighborhood attention and
an untrained NAF forward pass without downloading weights. An interrupted
rebuild cannot silently fall back to the old named Conda environment. Intact
legacy installs remain usable until Repair.

The runner selects 1024 with low-VRAM offload at the 12 GiB floor, 1536 with
offload from 24 GiB, and standard 1536 from 36 GiB. These are render budgets,
not a guarantee that every input fits in the minimum memory.

## Regeneration and audit

Use uv **0.13.6** or a reviewed patched successor. Choose a UTC cutoff at least
seven days before regeneration and update `registryCutoff`. The initial cutoff
is **2026-11-04T00:00:00Z**. Shared locks constrain the known Torch/native ABI;
review their changes together when upgrading it.

```sh
uv --no-config pip compile scripts/requirements-pixal3d-cuda.txt \
  --python-version 3.11 --python-platform x86_64-manylinux_2_28 \
  --generate-hashes --only-binary :all: --exclude-newer <UTC-cutoff> \
  -o scripts/requirements-pixal3d-cuda.lock.txt
uv --no-config pip compile scripts/requirements-pixal3d-cuda-build.txt \
  -c scripts/requirements-pixal3d-cuda.lock.txt \
  --python-version 3.11 --python-platform x86_64-manylinux_2_28 \
  --generate-hashes --only-binary :all: --exclude-newer <UTC-cutoff> \
  -o scripts/requirements-pixal3d-cuda-build.lock.txt
python3 scripts/audit-pixal3d-cuda.py
```

If direct-wheel metadata endpoints are inaccessible, download the exact wheels,
verify their existing hashes, resolve with those local wheels, then restore the
public URLs with the same hashes. Never commit local paths. Reinspect native
metadata, recursive gitlinks and bundled libraries when changing sources, then
re-hash their archives. Conda changes require a maintenance-time solve and
upload-date review; setup never runs a solver.

On 2026-11-12, OSV returned zero matches for **157 queries**: 114 PyPI identities
including native packages and setuptools' bundled libraries, 28 Conda artifact
PURLs, and 15 source revisions. PyPI queries include MAL records; pagination
is followed. OSV's limited Conda coverage means zero matches do not establish
complete native advisory coverage.

## Validation status

Fake-subprocess tests cover Install, Repair, retained weights, optional NATTEN
failure/removal, required-build failure and unsupported-host refusal.
Adapter/route tests cover installation, repairable degraded status, private
source rendering and incomplete-profile refusal. Patches also apply to the
exact downloaded upstream snapshots and parse successfully.

**Native CUDA builds and textured GLB renders have not yet been run for this
Pixal3D profile.** TRELLIS.2 hardware validation covers shared inputs, not proof
of Pixal3D, MoGe or NATTEN compatibility. On a matching native Linux GPU, repeat
Install/Repair with a retained synthetic asset, then render a synthetic/licensed
image with NATTEN and with fallback. Check finite nonempty geometry, valid
indices and embedded PBR textures. Start with 1024 low-VRAM; use sufficient
VRAM for full-resolution NAF.

```sh
python3 scripts/setup-pixal3d-cuda.py "$PWD/.cache/pixal-cuda-validation/pixal3d"
```

Run `.conda/portos-source/Pixal3D/inference.py` with `.conda/bin/python`,
`--image`, `--output`, `--resolution 1024` and `--low_vram`, from that Pixal3D
source directory. Use a disposable environment for without-NATTEN validation,
not a working user runtime.
