# TRELLIS.2 CUDA runtime

Install and **Repair install** use the PortOS-owned
`scripts/setup-trellis2-cuda.py`, without running upstream `setup.sh`.
The initial profile covers **Linux x86_64** (including WSL2), glibc **2.28+**,
[CUDA toolkit **12.6 Update 3 (12.6.3)**](https://docs.nvidia.com/cuda/archive/12.6.3/cuda-toolkit-release-notes/index.html)
with nvcc **12.6.85**, GCC/G++ **11.3.0**, NVIDIA compute capability **8.6**
and at least **24 GiB VRAM**. Install the toolkit and compiler before setup.
The toolkit must include its compiler's core headers and `lib64/stubs/libcuda.so`.
cuSPARSE, cuBLAS and other library headers come from the hash-pinned NVIDIA
wheels through a private `CPATH`; no ambient copy of those development packages
is needed. The completion inventory records the selected header directories.
The bootstrap interpreter needs the security-patched `tarfile.data_filter`.
Other profiles are refused before downloads or changes to an existing runtime.
Intact legacy CUDA environments remain usable for generation.

The locked interpreter is Conda CPython **3.11.16**. Torch **2.14.1+cu126** and
TorchVision **0.29.1+cu126** come from the official CUDA 12.6 wheel index.
FlashAttention **2.8.3.post2** replaces the former vulnerable 2.7.3 pin.
`scripts/trellis2-cuda-profile.json` records every Conda artifact, source archive,
full revision, submodule revision, URL and SHA-256. It also records the exact
Conda builds and upload dates. There is no Conda solver during setup: verified
local artifacts are passed to micromamba as an offline `@EXPLICIT` list.
Micromamba itself is an immutable, SHA-256-verified Conda artifact.

The runtime and build wheel closures are separate hash locks. Setup installs
them with `--require-hashes --no-deps --only-binary :all:`. Seven local packages
then build with `--no-index --no-deps --no-build-isolation --no-cache-dir`:
utils3d, FlashAttention, nvdiffrast, nvdiffrec, CuMesh, FlexGEMM and o-voxel.
The source manifest includes FlashAttention's CUTLASS, CuMesh's cubvh and its
Eigen, and o-voxel's Eigen gitlinks. ROCm's composable_kernel is unused by this
CUDA profile. No native build backend may select or fetch dependencies.

Builds use C++20 for the patched Torch headers, `TORCH_CUDA_ARCH_LIST=8.6`,
`FLASH_ATTN_CUDA_ARCHS=80` (compatible with 8.6 under
[NVIDIA's cubin compatibility rule](https://docs.nvidia.com/cuda/ampere-compatibility-guide/index.html)), `MAX_JOBS=2`
and `NVCC_THREADS=1`. `FLASH_ATTENTION_FORCE_BUILD=TRUE` disables its wheel
download shortcut. FlexGEMM's metadata hooks keep their cache in the private
source directory. Build subprocesses receive a private home and no model,
provider or PortOS credentials.
FlashAttention's upstream compile switches disable backward, dropout, ALiBi,
softcap and local-window kernels for this image inference profile. All forward
head dimensions and both FP16/BF16 remain available. The exact defines are
recorded in the profile; disabling unused kernels avoids compiling the training
and attention variants this pipeline never calls.
The pinned Transformers **5.22.1** moved DINOv3's layer list into its encoder.
Setup updates TRELLIS.2's private feature extractor to that path while preserving
its layer loop and unweighted feature normalization. Verification exercises a
tiny randomly initialized DINOv3 model without downloading weights, so a future
encoder API mismatch fails Install rather than the first user render.
nvdiffrec links against the toolkit's CUDA driver stub, which is replaced by the
real NVIDIA driver at runtime. Its unused NVRTC link flag is removed: none of the
pinned renderutils sources use NVRTC. A host's ambient NVRTC development library
is therefore not an extra build dependency.

Repair recreates only `<runtime>/.conda`, including its private source snapshot.
Downloaded weights elsewhere in the runtime or Hugging Face cache stay in place.
All Conda and source inputs are verified before the previous interpreter is
replaced. A failed or interrupted build remains incomplete until setup succeeds;
it cannot fall back to a legacy interpreter and report success. Native imports,
a FlashAttention CUDA operation and `pip check` must succeed before writing
`.conda/portos-profile.json`. That machine-local inventory records the compiler,
GPU capability, installed distributions, source inputs and wheel-lock hashes.
Install never downloads model weights or starts inference.

## Regeneration and audit

Use a private patched uv **0.13.6**. Choose a cutoff at least seven days old,
update `registryCutoff` in the profile, and regenerate both closures:

```sh
uv --no-config pip compile scripts/requirements-trellis2-cuda.txt \
  --python-version 3.11 --python-platform x86_64-manylinux_2_28 \
  --generate-hashes --only-binary :all: --exclude-newer <UTC-cutoff> \
  -o scripts/requirements-trellis2-cuda.lock.txt
uv --no-config pip compile scripts/requirements-trellis2-cuda-build.txt \
  -c scripts/requirements-trellis2-cuda.lock.txt \
  --python-version 3.11 --python-platform x86_64-manylinux_2_28 \
  --generate-hashes --only-binary :all: --exclude-newer <UTC-cutoff> \
  -o scripts/requirements-trellis2-cuda-build.lock.txt
python3 scripts/audit-trellis2-cuda.py
```

The initial cutoff is **2026-11-04T00:00:00Z**. Conda artifact upload times were
checked against the Anaconda release API, independently of package build times.
The direct Torch pair was released on 2026-09-30; FlashAttention 2.8.3.post2 was
uploaded on 2026-10-14. Inspect immutable source and native build metadata before
updating revisions, re-hash the archives, and verify recursive gitlinks.
For Conda changes, solve only during maintenance, inspect the complete result,
verify each artifact's upload date and replace the explicit manifest together.

On 2026-11-11, OSV querybatch returned no matches for **133 queries**: 94 PyPI
identities (including native sources and setuptools' bundled libraries), 28 Conda artifact PURLs
including micromamba, and 11 source revisions. PyPI queries include OSV's `MAL-`
malicious-package records. OSV's Conda advisory coverage is limited; a zero-match
PURL response does not establish complete native advisory coverage. The old
FlashAttention name/version and revision queries found advisories and were
replaced with the patched revision before building.

## Native validation

Use an isolated runtime, then repeat the same command for Repair:

```sh
python3 scripts/setup-trellis2-cuda.py "$PWD/.cache/trellis-cuda-validation/trellis2-cuda"
```

Place a synthetic retained asset outside `.conda` before Repair and check its
hash afterwards. Run `server/services/imageTo3d/trellis2CudaGenerateRunner.py`
with the locked interpreter, `--repo-root <runtime>/.conda/portos-source`, a
synthetic/licensed PNG, a 2048-pixel atlas and a 200,000-face target. Resolve the
configured Hugging Face token through the existing credential resolver without
printing it. Access to the DINOv3 and RMBG-2.0 gated weights is required.
Inspect the resulting GLB for finite nonempty triangles and embedded PBR textures.
Package locks do not freeze model downloads or grant gated-weight access.
