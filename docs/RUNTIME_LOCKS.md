# Runtime locks

Use this guide to regenerate, audit and validate PortOS's managed Python
environments. The [requirements directory](../scripts/ml/requirements/) holds
the direct resolver inputs, complete locks and build locks. Native profile
manifests and the installer supply the immutable source and interpreter inputs.

## Windows and Linux CUDA

The [image and video installer](../scripts/setup-image-video.sh) also provisions
these audio runtimes. On x86_64 Windows (Git Bash) or Linux, it selects the
host-specific lock and uses uv-managed CPython 3.11. Repair rebuilds a venv
based on Conda or another Python minor and removes packages outside the lock.
The CUDA index is fixed by each profile. Changing it requires regenerating and
validating both targets together. Model weights remain a separate download.

The slug identifies `requirements-<slug>.txt` and the two
`requirements-<slug>-{windows,linux}.lock.txt` files. The runtime name is the
lock header's `LABEL`. In addition to the listed probes, start by importing
`torch` and check `torch.cuda.is_available()` when validating NVIDIA support.

| Runtime | `SLUG` | Install flag | `CUDA_SCOPED` | `LINUX_CUDA_SCOPED` | Readiness imports |
| --- | --- | --- | --- | --- | --- |
| ACE-Step CUDA | `acestep-cuda` | `INSTALL_ACESTEP` | `torch` | | `acestep.pipeline_ace_step.ACEStepPipeline` |
| ACE-Step 1.5 CUDA | `acestep15-cuda` | `INSTALL_ACESTEP15` | `torch torchcodec` | `torchao` | `transformers.AutoModel`, `acestep.handler.AceStepHandler`, `acestep.inference` APIs |
| AudioLDM2 CUDA | `audioldm2-cuda` | `INSTALL_AUDIOLDM2` | `torch` | | `diffusers.AudioLDM2Pipeline` |
| FLUX.2 CUDA | `flux2-cuda` | `INSTALL_FLUX2` | `torch` | | `diffusers.Flux2KleinPipeline`, `diffusers.QwenImage21Pipeline` |
| MiniMax H3 CUDA | `minimax-h3-cuda` | `INSTALL_MINIMAX_H3_CUDA` | `torch torchvision` | `torchao` | `torchao`, `diffusers.MiniMaxH3Transformer3DModel`, `diffusers.modular_pipelines.minimax_h3.MiniMaxH3ImageReference` |
| MiniMax Music 3 CUDA | `minimax-music3-cuda` | `INSTALL_MINIMAX_MUSIC3` | `torch` | | `diffusers.ModularPipeline`, `diffusers.modular_pipelines.minimax_music3.MiniMaxMusic3Blocks` |
| MuScriptor CUDA | `muscriptor-cuda` | `INSTALL_MUSCRIPTOR` | `torch` | | `muscriptor.TranscriptionModel` |
| Wan 2.2 CUDA | `wan22-cuda` | `INSTALL_WAN22_CUDA` | `torch torchvision` | | `hf_xet`, `diffusers.AutoencoderKLWan`, `diffusers.WanPipeline` |
| [LTX-2.5 CUDA](#ltx-25-cuda) | `ltx25-cuda` | `INSTALL_LTX25_CUDA` | `torch torchvision torchaudio` on cu132 | | `ltx_core`, `ltx_pipelines`, `ltx_pipelines.distilled.DistilledPipeline` |

- **ACE-Step and ACE-Step 1.5.** The installer builds the pinned checkout
  specified by `ACESTEP_PIN` or `ACESTEP15_PIN` with `--no-deps
  --no-build-isolation` after syncing the inference lock. Recheck the
  inference import graph before changing either source revision. ACE-Step v1
  allows hash-verified `docopt` and `unidic-lite` sdists and uses the shared
  Apple Silicon build lock to verify their build dependencies.
- **MiniMax H3 and ACE-Step 1.5.** Keep Linux CUDA-local TorchAO on the CUDA
  index and Windows TorchAO on PyPI. For H3, retain the
  [checkpoint index guard](../scripts/ml/_checkpoint_index_guard.py) before
  model loading and test it when changing the loader or its dependencies.
  Review advisory results independently of that guard.
- **AudioLDM2, FLUX.2 / Qwen-Image 2.1 and MuScriptor.** The import probes
  also work on CPU-only hosts. Record CPU import and NVIDIA readiness
  separately. MuScriptor uses an independent Apple Silicon lock and verifies
  its transcription class with `TranscriptionModel`.
- **Wan 2.2.** Linux requires glibc 2.28+ and kernel 4.18+ for its bundled
  FFmpeg. Verify the complete installed closure during Repair.
- **MiniMax Music 3.** Readiness imports the released modular pipeline.
  Generation quality and performance evidence lives in the
  [renderer benchmarks](features/music-renderer-benchmarks.md).

## Regenerating locks

Use the hash-verified executable from the
[uv bootstrap lock](../scripts/ml/requirements/requirements-uv-bootstrap.lock.txt).
For the shared cu126 recipe below, update the direct inputs and set `UV`,
`SLUG`, `LABEL`, `CUDA_SCOPED` and `CUTOFF` in Bash from the repository root.
Set `LINUX_CUDA_SCOPED` for rows that list it. The cutoff must be a UTC
date at least three days before the refresh. Keep existing output locks as
resolver seeds. See [selective regeneration](#selective-regeneration) for a
bounded change.

For ACE-Step v1, set this Bash array before running the shared recipe. Other
rows leave it unset.

```bash
COMPILE_EXTRA=(
  --no-binary docopt --no-binary unidic-lite
  --preview-features build-dependency-hashes --require-build-hashes
  --build-constraints "$PWD/scripts/ml/requirements/requirements-acestep-mlx-build.lock.txt"
)
```

```bash
set -euo pipefail
: "${UV:?set UV to the verified executable}"
: "${SLUG:?set the runtime slug}" "${LABEL:?set the runtime label}"
: "${CUDA_SCOPED:?set packages scoped to the CUDA index}"
: "${CUTOFF:?set the UTC cutoff}"
UV_VERSION=$("$UV" --no-config --version)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for target in windows linux; do
  case "$target" in
    windows) platform=x86_64-pc-windows-msvc; scoped="$CUDA_SCOPED" ;;
    linux) platform=x86_64-manylinux_2_28; scoped="$CUDA_SCOPED ${LINUX_CUDA_SCOPED:-}" ;;
  esac
  python3 - "$TMP/pyproject.toml" "$SLUG" "$scoped" <<'PYPROJECT'
import json
import pathlib
import sys

out, slug, scoped = sys.argv[1], sys.argv[2], sys.argv[3].split()
lines = pathlib.Path(f"scripts/ml/requirements/requirements-{slug}.txt").read_text().splitlines()
deps = [line for line in lines if line and not line.startswith("#")]
sources = "".join(f'{name}={{index="pytorch"}}\n' for name in scoped)
pathlib.Path(out).write_text(
    f'[project]\nname="portos-{slug}"\nversion="0.0.0"\n'
    'requires-python=">=3.11"\ndependencies=' + json.dumps(deps) + '\n'
    '[tool.uv.sources]\n' + sources +
    '[[tool.uv.index]]\nname="pytorch"\n'
    'url="https://download.pytorch.org/whl/cu126"\nexplicit=true\n'
)
PYPROJECT
  out="scripts/ml/requirements/requirements-${SLUG}-${target}.lock.txt"
  cp "$out" "$TMP/$target.lock" # retain unrelated pins during resolution
  "$UV" --no-config pip compile "$TMP/pyproject.toml" \
    --python-version 3.11 --python-platform "$platform" \
    --generate-hashes --only-binary :all: --no-header --no-annotate \
    --index-url https://pypi.org/simple --emit-index-url \
    ${COMPILE_EXTRA[@]+"${COMPILE_EXTRA[@]}"} \
    --exclude-newer "$CUTOFF" -o "$TMP/$target.lock"
  {
    printf '# %s: CPython 3.11, x86_64 %s, CUDA 12.6.\n' "$LABEL" "$target"
    printf '# %s; exclude-newer %s; regenerate: docs/RUNTIME_LOCKS.md#regenerating-locks\n' "$UV_VERSION" "$CUTOFF"
    # pip-format locks cannot encode uv's named explicit index. Installation
    # retains the CUDA index, but versions and allowed artifact hashes are fixed.
    printf '%s\n' '--extra-index-url https://download.pytorch.org/whl/cu126'
    cat "$TMP/$target.lock"
  } > "$TMP/$target.with-header"
done
for target in windows linux; do
  cp "$TMP/$target.with-header" "scripts/ml/requirements/requirements-${SLUG}-${target}.lock.txt"
done
```

The temporary project derives its pins from the source requirements rather than
maintaining a second dependency list. `--no-annotate` keeps temporary
filesystem paths out of the committed locks. The pip-format lock retains the
installation index, but every accepted artifact stays constrained by its
SHA-256 hash. Verify the CUDA-scoped packages' official simple-index entries
(SHA-256 values and upload timestamps) against the lock and cutoff. The
preserved Triton entry also contains official PyTorch build hashes; verify
those against the CUDA index's `triton/` entries and their upload timestamps.
They are part of the unchanged native baseline, not new artifacts introduced
by a refresh. Verify all remaining artifacts against PyPI metadata. Never drop
the cutoff or hand-edit generated hashes.

### OSV audit

Query OSV for **every resolved package**, including all marker variants and
`MAL-` records, immediately before merge. Pass the lock files to the check
below. For each URL-pinned source package, add its reviewed `name=version`
after `--`. Also query the immutable source commits where the profile tracks
them. The Conda profiles provide dedicated audit scripts.

```bash
python3 - scripts/ml/requirements/requirements-wan22-cuda-{windows,linux}.lock.txt <<'PY'
import json
import re
import sys
from pathlib import Path
from urllib.request import Request, urlopen

def post(endpoint, payload):
    request = Request(f"https://api.osv.dev/v1/{endpoint}", json.dumps(payload).encode(),
                      {"Content-Type": "application/json"})
    with urlopen(request, timeout=60) as response:
        return json.load(response)

args = sys.argv[1:]
split = args.index("--") if "--" in args else len(args)
if not split:
    raise SystemExit("Supply at least one lock file")
pins = {tuple(pin.split("=", 1)) for pin in args[split + 1:]}
for path in args[:split]:
    entries = re.findall(r"^([\w.-]+)==([^\s\\;]+)", Path(path).read_text(), re.M)
    if not entries:
        raise SystemExit(f"No resolved pins in {path}")
    pins.update(entries)
queries = [{"package": {"name": name, "ecosystem": "PyPI"},
            "version": version.split("+", 1)[0]} for name, version in sorted(pins)]
results = post("querybatch", {"queries": queries})["results"]
if len(results) != len(queries):
    raise SystemExit("Incomplete OSV response")
findings = []
for query, result in zip(queries, results):
    seen = set()
    while True:
        if not isinstance(result, dict) or "error" in result:
            raise SystemExit("OSV returned an error result")
        findings.extend((query, item["id"]) for item in result.get("vulns", []))
        token = result.get("next_page_token")
        if token is None:
            break
        if not isinstance(token, str) or not token or token in seen:
            raise SystemExit("Invalid OSV pagination")
        seen.add(token)
        result = post("query", {**query, "page_token": token})
print(f"{len(queries)} identities checked", findings)
if findings:
    raise SystemExit("Resolve all advisories before merge")
PY
```

## Fresh install and readiness evidence

Set `scratch_home` to an empty directory and `INSTALL_FLAG` to the selected
flag. Run the command again for Repair, using the same directory.

```bash
: "${INSTALL_FLAG:?set the selected flag from the table}"
: "${scratch_home:?set the scratch home}"
env HOME="$scratch_home" PORTOS_DATA="$scratch_home/data" \
  INSTALL_MFLUX=0 INSTALL_VIDEO=0 INSTALL_FLUX2=0 "$INSTALL_FLAG=1" \
  bash scripts/setup-image-video.sh
```

Use the installed interpreter (`Scripts/python.exe` in a Windows venv) to
run the imports and, on NVIDIA, verify CUDA availability. Run
`uv pip check --python <interpreter>` and compare the full package set before
and after Repair. Record the OS, GPU, driver, bundled CUDA, Python and Torch
versions, selected lock and redacted probe output. Collect separate evidence for
Windows and Linux, including WSL. Readiness checks run without model downloads
or media generation. Record render and performance evidence separately.

## LTX-2.5 CUDA

The cu132 stack keeps Blackwell support and resolves Torch, Torchvision and
TorchAudio from the same CUDA index. Keep both LTX packages on the same immutable
archive, with separate subdirectories. The direct input and checked-in headers
record the source revision. The installer first bootstraps the backend from
[`requirements-ltx25-cuda-build.lock.txt`](../scripts/ml/requirements/requirements-ltx25-cuda-build.lock.txt)
with hashes, then syncs the runtime lock with `--no-build-isolation`, allowing
source builds for the two LTX packages only.

Edit `requirements-ltx25-cuda.txt` and inspect both source manifests and the
locked backend before compiling. Seed both scratch outputs with the existing
locks. Use the Windows and Linux targets from the shared recipe with the
following compile options (set `platform` and `scratch_lock` for each target):

```bash
"$UV" --no-config pip compile scripts/ml/requirements/requirements-ltx25-cuda.txt \
  --python-version 3.11 --python-platform "$platform" \
  --generate-hashes --only-binary :all: --index-url https://pypi.org/simple \
  --extra-index-url https://download.pytorch.org/whl/cu132 \
  --index-strategy unsafe-best-match --emit-index-url --no-header --annotation-style line \
  -o "$scratch_lock"
```

Keep the target, source and regeneration headers. For a source change, update
the archive revision and hashes in both locks and the package version checked
by the [currency probe](../scripts/ml/ltx25_cuda_currency.py). Match the build
lock's complete backend block to the runtime locks. This resolver's
multi-index inputs can lack timestamps. Verify each wheel's hash and release
date against the official registry and the source archive hash and release
date against upstream. Record the cutoff and any deliberate exception in
the PR. Include both LTX source package identities and the build backend in
the [advisory audit](#osv-audit).

Follow the shared Install/Repair check. Also run the currency probe with the
installed Python and selected lock. Exit 0 indicates current and 78 indicates
Upgrade/Repair is due.

## Native 3D profiles

The [3D model guide](THREEJS_MODELS.md) describes feature support and hardware
budgets. Use scratch runtime directories and a synthetic or licensed image
for native checks. Run Install and Repair, verify the retained assets, run
the profile's native probes and `pip check`, then inspect the output GLB for
finite indexed triangles, valid index bounds and embedded PBR textures. Reuse
the existing credential resolver for gated model assets and keep credentials
out of commands and logs.

### Conda and CUDA

Both profiles install verified Conda artifacts through offline micromamba
`@EXPLICIT` input. Wheel installs enforce hashes, use binaries and disable
dependency resolution. Native packages build from verified local source with
network resolution and build isolation disabled. Repair recreates the private
`.conda` directory and leaves weights outside it in place.

| Profile | Manifest | Isolated Install/Repair | Advisory audit |
| --- | --- | --- | --- |
| TRELLIS.2 CUDA | [Profile](../scripts/ml/trellis2-cuda-profile.json) | `python3 scripts/ml/setup-trellis2-cuda.py "$scratch_runtime"` | [audit-trellis2-cuda.py](../scripts/ml/audit-trellis2-cuda.py) |
| Pixal3D CUDA | [Profile](../scripts/ml/pixal3d-cuda-profile.json) | `python3 scripts/ml/setup-pixal3d-cuda.py "$scratch_runtime"` | [audit-pixal3d-cuda.py](../scripts/ml/audit-pixal3d-cuda.py) |

For either profile, compile the runtime wheel input and then the build wheel
input, passing the runtime lock as `-c` when compiling the build lock. Use
CPython 3.11, `x86_64-manylinux_2_28`, `--generate-hashes --only-binary :all:`
and the shared cutoff. Update `registryCutoff` in the profile. Verify changed
archive hashes and recursive gitlinks. When changing Conda, solve in scratch
during maintenance and verify each artifact hash and upload time through the
Anaconda release API before replacing the explicit inventory. Run the listed
audit script with Python to check registry, source and Conda identities. OSV
coverage of Conda native libraries is limited.

#### TRELLIS.2 CUDA

The Linux x86_64 profile includes WSL2. Use the profile's CUDA toolkit and
compiler, including the driver stub and core toolkit headers. The locked
NVIDIA wheels supply the additional CUDA library headers. Setup checks native
imports, a small DINOv3 feature extraction and a FlashAttention CUDA operation.
For a render check, run the
[CUDA runner](../server/services/imageTo3d/trellis2CudaGenerateRunner.py) with
the locked interpreter, `--repo-root` at the private `.conda/portos-source`,
a 2048-pixel atlas and a 200,000-face target.

#### Pixal3D CUDA

Use native Linux x86_64. WSL2 has an upstream NAF driver issue. The profile
shares TRELLIS.2 build inputs and keeps a separate environment. Setup checks
DINO feature extraction and FlashAttention and, when NATTEN is available,
neighborhood attention and an untrained NAF forward pass. If NATTEN fails to
build, bilinear-interpolated DINO features preserve the feature shape and the
runtime reports **NAF fallback**. Repair retries the native build. A broken
operation from an installed NATTEN fails verification. Keep the NAF code
snapshot local and retain MoGe's inference-only metadata patch. This profile's
native CUDA render remains pending. Start at 1024 with low-VRAM offload, then
check both the NATTEN render and fallback on suitable hardware.

### Metal

These arm64 profiles use CPython 3.13, macOS 26+ and full Xcode with the Metal
toolchain. Repair uses verified local source snapshots, rebuilds the private
`.venv` for the locked Torch ABI and retains model assets. Resolve the wheel
closures with `MACOSX_DEPLOYMENT_TARGET=26.0`, `aarch64-apple-darwin`,
`--generate-hashes --only-binary :all:` and the shared cutoff. Inspect build
code and native imports when changing sources. Audit registry packages,
separately installed source identities and changed revisions.

#### TRELLIS.2 Metal

Run `bash scripts/setup-trellis2-mps.sh "$scratch_runtime"`. The
[profile manifest](../scripts/ml/trellis2-mps-profile.json) and
[wheel lock](../scripts/ml/requirements/requirements-trellis2-mps.lock.txt)
cover the workspace, Metal packages and build tools. Verify the exact Eigen
gitlink when advancing the Apple fork. Setup builds from local sources and
validates native imports and the Metal baker. Update the profile cutoff
alongside its wheel lock. For generation, use the PortOS adapter with the
512 profile, seed 7, four steps and a 2048-pixel atlas. Verify that the log
reports **Baking PBR textures via Metal** and that no KDTree fallback ran.

#### Pixal3D Metal

The installer runs [setup-pixal3d-mps.sh](../scripts/setup-pixal3d-mps.sh)
from the pinned Apple Silicon checkout. The
[wheel lock](../scripts/ml/requirements/requirements-pixal3d-mps.lock.txt)
contains the CLI and build requirements. The
[source lock](../scripts/ml/requirements/requirements-pixal3d-mps-sources.lock.txt)
covers NATTEN, MoGe, pipeline and utils3d. MoGe uses locked local dependencies
and headless OpenCV. The setup patches and builds the vendored extensions
against the locked Torch ABI and verifies the imports and MPS availability.
Run the private `generate_mps.py` with `--device mps --pipeline-type
1024_cascade --steps 4 --seed 7`. Use
[verify-pixal3d-mps.py](../scripts/ml/verify-pixal3d-mps.py) with the locked
interpreter to check native imports, the fixed JIT validation functions and
the resulting GLB.

## MLX video

Video Gen checks the pinned checkout, selected lock and installed packages
on Apple Silicon. LTX and Wan target CPython 3.11. FastVideo's lock also
covers eligible newer interpreter versions through markers.

| Runtime | Install flag | Inference lock | Probe import |
| --- | --- | --- | --- |
| LTX-2.3 MLX | `INSTALL_LTX2` | [ltx23-mlx](../scripts/ml/requirements/requirements-ltx23-mlx.lock.txt) | `ltx_pipelines_mlx` |
| LTX-2.5 MLX | `INSTALL_LTX25` | [ltx25-mlx](../scripts/ml/requirements/requirements-ltx25-mlx.lock.txt) | `ltx_pipelines_mlx` |
| Wan 2.2 MLX | `INSTALL_WAN22` | [wan22-mlx](../scripts/ml/requirements/requirements-wan22-mlx.lock.txt) | `mflux.models.wan.cli.wan_generate` |
| FastVideo MLX | `INSTALL_FASTVIDEO` | [fastvideo-mlx](../scripts/ml/requirements/requirements-fastvideo-mlx.lock.txt) | `fastvideo`, `mlx.core` |

The installer syncs hash-locked registry wheels and uses the separate
[MLX video build lock](../scripts/ml/requirements/requirements-mlx-video-build.lock.txt)
for the editable LTX builds and the Wan wheel. Wan builds from a temporary
archive of the pinned source to replace its private Pillow typing import
while preserving the clean checkout. FastVideo installs its editable source
using the build backend from its inference lock. When package downloads fail,
check network and application firewall access to PyPI and its wheel host for
the installer's private uv executable.

### Regenerating MLX inference locks

For an upstream revision change, audit its universal `uv.lock` and the
Apple Silicon inference subset. Use the pinned manifests' `project.dependencies`
from both LTX workspace packages (omit the local `ltx-core-mlx` dependency) or
the Wan root package. Preserve PortOS-specific inputs such as LTX's Click
companion. For a selective refresh, seed from the existing PortOS lock,
constrain every retained pin and transfer only generated blocks that changed.

```bash
MACOSX_DEPLOYMENT_TARGET=14.0 "$UV" --no-config pip compile "$inputs" \
  -c "$constraints" --python-version 3.11 --python-platform aarch64-apple-darwin \
  --generate-hashes --only-binary :all: --no-header --no-annotate \
  --exclude-newer "$CUTOFF" -o "$scratch_lock"
```

Use the FastVideo lock header's universal recipe for FastVideo. Audit
inference and build pins and record the uv version and cutoff in each
changed header. Repeat the actual installer and compare the locked package
set and imports after Repair. Test LTX-2.3 audio levels, LTX-2.5 preservation
of the frame-zero anchor and a native Wan render when changing the relevant
model, source or accelerator inputs.

## Demucs

Music Video provisions vocal separation on user action or through configured
autopilot. The [wheel lock](../scripts/ml/requirements/requirements-demucs.lock.txt)
covers CPython 3.11 on arm64 macOS 14+, Linux x86_64 and Windows x64. It is
installed with hashes, binaries only and dependency resolution disabled.
A matching lock stamp, interpreter, imports, versions and native WAV
write/readback are required to reuse the environment. An import check alone
misses encoder incompatibility. Rebuild legacy environments with the correct
interpreter, including native arm64 Python when running under Rosetta. Use
the lock header for the universal regeneration command and audit all markers.
For a native smoke test, exercise the random-weight `demucs_unittest` CPU
model with a short stereo WAV to verify output without downloading weights.

## Blender rigging

On explicit request, `python3 scripts/ml/setup-rigging.py` provisions
`~/.portos/envs/rigging`. Existing prefixes are preserved. The
[rigging profile](../scripts/ml/rigging-profile.json) records every interpreter
artifact for CPython 3.13 on Apple Silicon and glibc 2.28+ Linux x86_64. Setup
verifies artifacts before offline Conda creation, installs the complete
wheel lock with hashes and checks `pip check` and a real `bpy` import/version.

Resolve both wheel inputs from `requirements-rigging.txt` using the Python
patch version in the profile and the `aarch64-apple-darwin` and
`x86_64-manylinux_2_28` targets. Use `--only-binary :all: --generate-hashes`
and the shared cutoff. For interpreter changes, inspect scratch Conda dry-run
`actions.FETCH` and `actions.LINK` closures under `conda-forge`, using
`CONDA_OVERRIDE_GLIBC=2.28` for Linux. Verify each SHA-256 and upload time
independently before updating both manifests. Run
[audit-rigging.py](../scripts/ml/audit-rigging.py) for wheel and Conda identities.
Resolution and provisioning tests cover the profile contract. Native rigging
and Blender export require separate validation.

## Held-back pins

The lockfiles and profile manifests carry the exact installed versions.
Read the pinned source or dependency metadata before advancing a constraint.
Evidence for individual refreshes lives in the commits and merged PRs.

| Profile | Constraint | Rationale |
| --- | --- | --- |
| Fixed CPython 3.11 profiles | Keep compatible NetworkX, ContourPy, PyAV and Librosa releases | Newer releases require Python 3.12+. Universal locks can select them on eligible branches. |
| ACE-Step v1 | Upstream Librosa pin and `py3langid<0.4` | `setup.py` reads the exact Librosa requirement. The inference path needs `from_pickled_model`. |
| Shared mflux-video and Torch closures | Preserve the fsspec cap from Datasets and `mpmath<1.4` where SymPy requires it | Resolve against the pinned consumer's metadata. |
| FLUX.3 MLX, shared mflux-video, Laya and Wan MLX | Hugging Face Hub below 2 | The pinned sources still require Hub 1. Migrate and test each profile independently. |
| LTX CUDA | Transformers below 5.15 and `uv-build>=0.9.8,<0.10` | The pinned source requires these for its Gemma encoder and build. The CUDA bindings pin has a historical cutoff exception in [#15454](https://github.com/atomantic/PortOS/issues/15454). |
| LTX MLX | Keep the frozen MLX baselines and compatible mlx-lm | Newer mlx-lm needs a newer MLX baseline. Changes require native audio and frame-anchor validation. |
| LTX workspace | Hatchling below 1.32 | Newer Hatchling rejects the workspace-relative README. |
| Wan MLX | `uv-build>=0.7.19,<0.8` | The pinned MLX-Gen source declares this backend range. |
| Pixal3D and TRELLIS.2 CUDA | Exact Transformers pin from the native profile | Setup and the DINOv3 feature extractor depend on that ABI. Advance it with native CUDA validation. |
| TRELLIS.2 Metal | Preserve the trellis2-apple autorelease-pool repair | Its revision has a historical source cutoff exception in [#15708](https://github.com/atomantic/PortOS/issues/15708). |
| MTPLX | Keep the declared MLX, mlx-lm, Transformers and Hub ranges | Upstream metadata constrains the closure. The MTPLX package alone has a cutoff exception for Inkling 2 Mini MTP support in [#17422](https://github.com/atomantic/PortOS/issues/17422). |
| FastVideo MLX | Keep the tokenizers override paired with the locked Transformers version | Validation exercised real CLIP load/save across the RobertaProcessing argument change. The direct input records the exact pins. |

## Selective regeneration

1. Choose one profile or a tightly coupled package set. Use the lock header's
   verified uv, platforms and Python targets. Choose a UTC cutoff at least
   three days old and preserve existing artifact exceptions and source inputs.
2. Copy the direct inputs and any declared project environments to scratch.
   Extract every existing `name==version` and marker into a constraints file.
   Modify only the selected versions and preserve any recorded resolver bounds.
3. Compile into a scratch lock with `-c <constraints>`. Verify the complete
   package, version and marker sets against the original on every target.
   Copy back only the changed generated blocks, retaining the remaining
   artifact allowlists, provenance comments and header information.
4. Verify artifact hashes, non-yanked status and upload dates against the
   official registries and audit the full closure. When using a temporary
   loopback relay to reach PyPI, preserve metadata and use the official
   wheel host. Keep the relay out of installer configuration and lock URLs.
5. Run the installer, adapter and pin tests and a hash-required dry install
   plan for every target. Add native evidence for changes to the runtime,
   including actual Xet transfers for Xet transport changes. The opt-in
   [helper probe](../scripts/ml/cooled_runtime_probe.py) checks its declared
   baseline and candidate versions in isolated environments with the same
   fixtures. Record the new uv version and cutoff in the lock header.
