# Runtime locks

[Requirements and build locks](../scripts/ml/requirements/) pin dependencies.
Native profiles also pin interpreters, toolchains and source archives.

## Windows and Linux CUDA

Install or Repair via the runtime's Models page or
[`setup-image-video.sh`](../scripts/setup-image-video.sh). On x86_64 Windows
(Git Bash) and Linux the shared installer selects the host lock and
uv-managed CPython 3.11. It replaces incompatible venvs and removes packages
outside the lock. Weights are downloaded separately. Refresh both OS targets
together when changing the CUDA index or shared inputs.

| Runtime slug | Install flag | `CUDA_SCOPED` | `LINUX_CUDA_SCOPED` |
| --- | --- | --- | --- |
| `acestep-cuda` | `INSTALL_ACESTEP` | torch | |
| `acestep15-cuda` | `INSTALL_ACESTEP15` | torch | |
| `audioldm2-cuda` | `INSTALL_AUDIOLDM2` | torch | |
| `flux2-cuda` | `INSTALL_FLUX2` | torch | |
| `minimax-h3-cuda` | `INSTALL_MINIMAX_H3_CUDA` | torch torchvision | torchao |
| `minimax-music3-cuda` | `INSTALL_MINIMAX_MUSIC3` | torch | |
| `muscriptor-cuda` | `INSTALL_MUSCRIPTOR` | torch | |
| `wan22-cuda` | `INSTALL_WAN22_CUDA` | torch | |

ACE-Step builds its pinned source after dependency sync. ACE-Step 1.5 CUDA
builds from a temporary archive of the pinned checkout using the inference
requirements as wheel dependency metadata. Keep Linux TorchAO
on the CUDA index for H3 and Windows TorchAO on PyPI.
Keep the H3 checkpoint index guard in the model loader. Wan's bundled FFmpeg
requires glibc 2.28 and Linux 4.18 or newer. [LTX-2.5](#ltx-25-cuda) uses cu132.

## Regenerating locks

Use the hash-verified executable from the
[uv bootstrap lock](../scripts/ml/requirements/requirements-uv-bootstrap.lock.txt).
Use a UTC cutoff at least three days before the refresh. Seed scratch
outputs with the existing locks. For each OS, create a temporary
`pyproject.toml` with dependencies from `requirements-<slug>.txt`, an
explicit named PyTorch index at `https://download.pytorch.org/whl/cu126`,
and `[tool.uv.sources]` entries pointing only the table's scoped packages
to that index. Include the Linux-only column on Linux.

```bash
"$UV" --no-config pip compile "$project" --python-version 3.11 \
  --python-platform "$platform" --generate-hashes --only-binary :all: \
  --no-header --no-annotate --index-url https://pypi.org/simple \
  --emit-index-url --exclude-newer "$CUTOFF" -o "$scratch_lock"
```

Use `x86_64-pc-windows-msvc` and `x86_64-manylinux_2_28`. For ACE-Step v1
also pass `--no-binary docopt --no-binary unidic-lite`,
`--preview-features build-dependency-hashes --require-build-hashes` and
`--build-constraints scripts/ml/requirements/requirements-acestep-mlx-build.lock.txt`.
Retain the target, uv, cutoff and regeneration headers and the CUDA
`--extra-index-url` in each pip-format lock. Inspect both outputs before
replacing the tracked locks.

Verify wheel hashes and upload times, including CUDA-index Triton, then audit.

### OSV audit

Query OSV immediately before merge for every resolved package and marker
variant, including `MAL-` advisories. Use the base version for local version
suffixes such as `+cu126`. Include URL-pinned source package versions and
immutable commits. Process all pages and fail on incomplete or invalid
responses. Native profiles with dedicated audit scripts are listed below.

## Fresh install and readiness evidence

Run Install and Repair with scratch `PORTOS_DATA` and only the intended
profile enabled. Use its exact import probes and `uv pip check --python
<interpreter>` (`Scripts/python.exe` on Windows). Check CUDA availability on
NVIDIA. Compare both package sets and record redacted OS, GPU, driver,
CUDA, Python, Torch, lock and probe results. Keep render evidence separate.

## MuScriptor

Split the direct inputs at the `muscriptor==` line. Generate the inference
lock with the rest of the inputs, using the CUDA recipe above for both
targets. For Apple Silicon, create a scratch `pyproject.toml` with the inference
dependencies, `requires-python = ">=3.11"`, and this platform restriction:

```toml
[tool.uv]
environments = ["sys_platform == 'darwin' and platform_machine == 'arm64'"]
```

Run the same compile options from that scratch project with `--universal`
instead of `--python-platform`, and omit `--no-config` so uv reads the
project's platform restriction. Seed each inference output with its
previous lock to retain compatible pins.

Compile the MuScriptor wheel separately using the same uv and cutoff:

```bash
sed -n '/^muscriptor==/p' "$input" | "$UV" --no-config pip compile - \
  --no-deps --python-version 3.11 --generate-hashes --only-binary :all: \
  --no-header --no-annotate --index-url https://pypi.org/simple \
  --exclude-newer "$CUTOFF" -o "$wheel_lock"
```

Apply the Apple Silicon marker to the wheel pin for that target. Merge
the complete pin and hash blocks in package-name order, retain the lock
headers and CUDA index directives, and audit all resulting pins with OSV.
The `--no-deps` wheel split excludes the upstream web server and CLI.
Their dependency declarations remain in the wheel metadata, so validate
with `scripts/ml/transcribe_muscriptor.py --check-runtime` and
`from muscriptor import TranscriptionModel; import soundfile, beat_this, mido`
in a fresh environment. Run a small audio-to-MIDI transcription when
licensed weights are available.

## LTX-2.5 CUDA

Keep `ltx-core` and `ltx-pipelines` on the same immutable source archive.
The installer bootstraps the hash-locked build backend before syncing
the runtime with `--no-build-isolation` and source builds for those two
packages. Seed scratch copies of both locks. Compile
`requirements-ltx25-cuda.txt` for the shared Windows/Linux CPython 3.11
targets with `--generate-hashes --only-binary :all: --index-url
https://pypi.org/simple --extra-index-url https://download.pytorch.org/whl/cu132
--index-strategy unsafe-best-match --emit-index-url --no-header
--annotation-style line`. Verify official wheel and source hashes and
release dates when the resolver cannot enforce timestamps. Keep both source
entries, headers and the separate build lock in sync. Audit both source
identities and the backend. Include the installed
[`ltx25_cuda_currency.py`](../scripts/ml/ltx25_cuda_currency.py) probe in
Install/Repair verification (0 current, 78 upgrade or repair).

## Native 3D profiles

Use a scratch runtime and synthetic or licensed image. Run Install/Repair,
native probes and `pip check`. Check GLB triangle bounds and embedded PBR
textures. Verify Repair retains weights.

### Conda and CUDA

Use offline micromamba `@EXPLICIT` artifacts and verified local sources.
Compile runtime and build wheels separately on CPython 3.11,
`x86_64-manylinux_2_28`, with hashes, binary-only and the cutoff. Constrain
build resolution to the runtime lock and update the manifest
`registryCutoff`. For Conda changes verify artifacts and upload times via
Anaconda. Audit source archives and recursive gitlinks alongside the wheels.

#### TRELLIS.2 CUDA

Use [the Linux x86_64 profile](../scripts/ml/trellis2-cuda-profile.json)
(including WSL2). Run `python3 scripts/ml/setup-trellis2-cuda.py "$scratch_runtime"`
and [its audit](../scripts/ml/audit-trellis2-cuda.py). Verify native imports,
DINOv3 and FlashAttention, then render with the
[CUDA runner](../server/services/imageTo3d/trellis2CudaGenerateRunner.py)
using the private `.conda/portos-source`, a 2048-pixel atlas and 200,000 faces.

#### Pixal3D CUDA

Use [the native Linux x86_64 profile](../scripts/ml/pixal3d-cuda-profile.json)
with at least 12 GiB VRAM. WSL2 has an upstream NAF driver issue. Run
`python3 scripts/ml/setup-pixal3d-cuda.py "$scratch_runtime"` and
[its audit](../scripts/ml/audit-pixal3d-cuda.py). Repair retries an unavailable
NATTEN build. **NAF fallback** uses interpolated DINO features. An installed
NATTEN with a broken operation fails verification. Check both paths with
a native render, starting at 1024 with low-VRAM offload.

### Metal

Use arm64 macOS 26 or newer with full Xcode and its Metal toolchain. Resolve
the CPython 3.13 wheels with `MACOSX_DEPLOYMENT_TARGET=26.0`,
`aarch64-apple-darwin`, hashes, binary-only and the cutoff. Repair rebuilds
the private venv against the locked Torch ABI and keeps assets.

#### TRELLIS.2 Metal

Run `bash scripts/setup-trellis2-mps.sh "$scratch_runtime"`. Update the
[profile](../scripts/ml/trellis2-mps-profile.json) and wheel lock together.
Verify the exact Eigen gitlink when advancing the Apple fork. Render with
the 512 profile, seed 7, four steps and 2048-pixel atlas. Require the Metal
baker to run, with no KDTree fallback.

#### Pixal3D Metal

Use [the installer](../scripts/setup-pixal3d-mps.sh) with the locked wheel
and source inputs. It rebuilds native extensions and checks imports and MPS.
Install seeds `autotune_cache.json` in the runtime root from the bundled tuning
data. Repair retains that file. For direct renders, set
`FLEX_GEMM_AUTOTUNE_CACHE_PATH` to the absolute path of that cache, as PortOS
does for render launches. Render from the private source snapshot with
`generate_mps.py --device mps
--pipeline-type 1024_cascade --steps 4 --seed 7` and check the output with
[`verify-pixal3d-mps.py`](../scripts/ml/verify-pixal3d-mps.py).

## MLX video

LTX-2.3, LTX-2.5 and Wan 2.2 MLX target CPython 3.11 on Apple Silicon.
Follow FastVideo's interpreter markers. Use the inference and shared build
locks. For failed downloads, check private uv access to PyPI and its wheels.

### Regenerating MLX inference locks

Audit upstream universal locks, select the Apple Silicon subset and
derive direct inputs from the pinned source manifests. Use both LTX
packages' dependencies except the local `ltx-core-mlx` edge and preserve
PortOS-specific inputs such as Click. Compile from the existing lock with
`MACOSX_DEPLOYMENT_TARGET=14.0`, CPython 3.11, `aarch64-apple-darwin`, hashes,
binary-only and the cutoff. FastVideo's lock header gives its universal
recipe. Check LTX-2.3 audio, LTX-2.5 frame-zero preservation and native Wan
render for changes to the relevant model, source or accelerator.

## Demucs

Provision through Music Video. Use the universal lock header to refresh
CPython 3.11 for arm64 macOS 14+, Linux x86_64 and Windows x64. Check the
lock stamp, interpreter, imports and native WAV round trip. A CPU smoke
test can use `demucs_unittest` and a synthetic short stereo WAV without
downloading weights.

## Blender rigging

`python3 scripts/ml/setup-rigging.py` explicitly provisions the private
env. Resolve both wheel locks with the CPython 3.13 patch pinned in
[the profile](../scripts/ml/rigging-profile.json), using `aarch64-apple-darwin`
and `x86_64-manylinux_2_28`. For interpreter updates, verify each scratch
Conda dry-run artifact's upload date and SHA-256. Set
`CONDA_OVERRIDE_GLIBC=2.28` for Linux. Run
[`audit-rigging.py`](../scripts/ml/audit-rigging.py), `pip check` and a real
`bpy` import, then verify native rigging and export.

## Held-back pins

Keep the Python, package and ABI constraints in the direct inputs. FastVideo's tokenizers
override is paired with Transformers across the RobertaProcessing change.
Retest real CLIP loading, saving, offsets and attention masks before advancing
it. Keep cutoff exceptions explicit and track them in the refresh PR.

## Selective regeneration

1. Seed from the existing lock and constrain retained versions, markers and bounds.
2. Compile in scratch using the header's targets and verified uv. Compare all
   markers and package sets. Move only changed generated blocks.
3. Verify official hashes, upload dates and non-yanked status. A temporary
   relay must preserve metadata and wheel URLs. Audit build and source too.
4. Run pin and installer tests, dry installs for all targets and native
   checks for changed behavior. Exercise real transfers for transport
   changes. Record the uv version and cutoff.
