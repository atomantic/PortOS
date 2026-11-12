# TRELLIS.2 Metal runtime

Install and **Repair install** use PortOS's `scripts/setup-trellis2-mps.sh`,
CPython **3.13**, Torch **2.15.0** and TorchVision **0.29.2**. The profile requires
native Apple Silicon, macOS **26+**, full Xcode **26+**, its Metal Toolchain,
and at least **24 GB** unified memory. Install Python with
`brew install python@3.13`, or set `PYTHON_BIN` to that interpreter. A missing
Metal component can be installed with `xcodebuild -downloadComponent MetalToolchain`.
The script checks the actual interpreter, architecture, OS and toolchain before
changing the runtime. There is no ambient uv/pip resolver or degraded native build.
An interrupted or failed rebuild is reported as incomplete and cannot render;
rerun Install or Repair to finish it. Locked profiles require the successful
completion record, while intact legacy environments remain usable.

The existing runtime directory and downloaded weights remain in place. Repair
rebuilds only `.venv`, so incompatible native modules and unlocked extras cannot
survive from an older Python/Torch ABI. All source archives are SHA-256 verified
before the old interpreter is replaced. Builds and renders use the private
`.venv/portos-source` snapshot; stale files in the legacy checkout cannot affect it.
Legacy installations can still render before Repair. Setup never downloads model
weights or starts inference; those remain part of an explicit Generate action.

## Immutable inputs

`scripts/trellis2-mps-profile.json` records the full revisions, archive URLs and
SHA-256 hashes for all nine inputs:

| Input | Revision |
| --- | --- |
| shivampkumar/trellis-mac | `d58628f4f5b9c3de8274cb110074154f4b31cef2` |
| microsoft/TRELLIS.2 | `75fbf0183001ed9876c8dbb35de6b68552ee08bd` |
| pedronaugusto/mtlbvh | `fe6660bdb7de5a12ea00bd96df2e21bdcbdd40b1` |
| pedronaugusto/mtldiffrast | `c390a92aa296c5cf131f91253b8a11fe01ec11e4` |
| pedronaugusto/mtlmesh | `5e6749356ba39b15489c99487f55840d49923da7` |
| pedronaugusto/mtlgemm | `c2e5d3fa15152bc4aef65773cab1ded5a1855d38` |
| pedronaugusto/trellis2-apple | `c873bde81ebe1e56535c6caddb4b21267364a923` |
| EasternJournalist/utils3d | `9a4eb15e4021b67b12c460c7057d642626897ec8` |
| Eigen | `21e4582d1739107337a03460c81412981130373e` |

Eigen is the exact gitlink in the Apple fork's `o-voxel/third_party/eigen`,
retrieved from Eigen's GitHub mirror at that same commit. Metal builds do not
need mtlmesh's CUDA-only cubvh submodule. Its xatlas C++ sources are already
vendored in the pinned archive.

The 56-wheel hash lock includes pip, setuptools, wheel, pybind11 and Ninja.
Every wheel is installed with `--force-reinstall --require-hashes --no-deps --only-binary :all:`;
this also verifies the pinned pip wheel instead of reusing venv's bundled pip.
Then utils3d and the five native packages build from verified local sources with
`--no-index --no-deps --no-build-isolation --no-cache-dir`. No dependency fetch
or source-distribution fallback is permitted during a build. Torch 2.15 headers
need C++20; setup changes the pinned build flags from C++17 to C++20. It keeps
mtlgemm's build-time autotune-cache copy inside its private source directory.
PortOS applies the pinned MPS patches and its existing runtime-gated fill-holes
patch after compilation. Native imports, the Metal baker and `pip check` must
succeed before setup reports completion.

`.venv/portos-profile.json` records the source manifest, wheel-lock digest,
installed distributions, Python/macOS versions, Xcode build and Metal compiler.
This machine-local record is not published or committed.

## Regeneration and audit

From the repository root, use the hash-verified uv **0.13.7**:

```sh
MACOSX_DEPLOYMENT_TARGET=26.0 uv --no-config pip compile \
  scripts/requirements-trellis2-mps.txt --python-version 3.13 \
  --python-platform aarch64-apple-darwin --generate-hashes --only-binary :all: \
  --exclude-newer <UTC-cutoff-at-least-seven-days-old> --no-header --no-annotate \
  -o scripts/requirements-trellis2-mps.lock.txt
```

Update the cutoff in the profile with the lock. Inspect each changed source's
build code and runtime imports before selecting a new full revision, download
its immutable archive and compute SHA-256. Verify the Eigen gitlink through the
forge API when changing the Apple fork. Do not execute upstream `setup.sh`:
it resolves packages, clones moving branches and tolerates failed Metal builds.
The port's unused torchaudio dependency is omitted from this image-only CLI.

On 2026-11-11 the online uv fetch failed with `No route to host`. The initial
lock was resolved offline with `--offline --no-index --find-links <wheelhouse>`
after checking every selected wheel's SHA-256, non-yanked status, CPython 3.13
arm64 tags and upload time against PyPI JSON. All were uploaded before
**2026-11-04T00:00:00Z**. This is the seven-day cooldown for runtime and build pins.

Audit **every** resolved registry pin, not just direct requirements. Submit
`{"package":{"ecosystem":"PyPI","name":"<name>"},"version":"<version>"}`
for each lock entry to `https://api.osv.dev/v1/querybatch`; include all marker
variants if regeneration introduces any. This query includes `MAL-` malicious
package records. Query the six source package identities too (utils3d 0.0.2,
mtlbvh 0.1.0, mtldiffrast 0.1.0, cumesh 0.1.0, flex-gemm 1.0.0 and o-voxel
0.0.1), and submit each source revision as `{"commit":"<sha>"}`. Name/version
queries do not turn these Git sources into PyPI installations. The 2026-11-11
audit returned **zero matches for 71 queries**: 56 registry pins, six source
identities and nine commits. Re-audit after any pin change, then repeat native
Install, Repair and a textured GLB export; registry metadata alone does not
establish native compatibility.

The 2026-11-12 network/cache refresh uses cutoff **2026-11-05T00:00:00Z**,
recorded in the profile and regenerated lock. The 56-package closure retains
all source revisions and native/renderer versions. See the eighteenth slice in
[the runtime refresh record](./PYTHON_RUNTIME_REFRESH.md) for complete audit
results, old/new native network-caller checks and unperformed renderer checks.

## Native validation

Use an isolated directory for validation so the live runtime remains available:

```sh
bash scripts/setup-trellis2-mps.sh "$PWD/.cache/trellis-validation/trellis2"
# Repeat the exact command for Repair; assets outside .venv must remain unchanged.
```

Use a synthetic or licensed PNG, the PortOS `runTrellis2Generate` adapter with
`base` set to `.cache/trellis-validation`, `pipelineType: '512'`, `textureSize: 2048`,
`steps: 4` and `seed: 7`. Resolve the existing Hugging Face token through
`hfChildEnv`; never put a token in a command, log or verification artifact.
Cached weights can be used with `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1`.
The render log must say **Baking PBR textures via Metal**, with no KDTree fallback.
Inspect the GLB for finite, nonempty triangle geometry and embedded PBR textures.
Package locks do not freeze model downloads or grant access to gated weights.

On 2026-11-11, an isolated fresh Install and a Repair of that runtime both
passed native imports, the Metal baker checks and `pip check` on arm64 macOS
27.2.1, CPython 3.13.18, Xcode 27.2 (27B52) and Metal compiler 32023.922
(metalfe-32023.922.4). Repair retained an asset outside `.venv`; all 62 installed
distributions matched the 56 registry pins plus six source packages. The
PortOS adapter completed a synthetic three-color cube render using cached
weights, the 512 pipeline, four steps, seed 7 and a 2048-pixel atlas. The log
confirmed the Metal baker and no KDTree fallback.
The exported GLB passed finite, nonempty indexed-triangle and embedded-PBR-texture
checks: **295,589 vertices, 497,752 faces, two embedded texture images**. Its
SHA-256 was `4e58d25d992aecfc9630e131d5c7e006cbfde2cf97e6ff6c9d868ff675b5a4ef`.

The subsequent timm/PLY/Ninja maintenance refresh retains the same native
profile and source revisions. See [3D Metal timm/PLY/build maintenance](PYTHON_RUNTIME_REFRESH.md#twenty-first-slice-3d-metal-timmplybuild-maintenance-2026-11-12)
for exact upgrades, complete-lock audits, real CPU/native synthetic boundary
tests and the limits of that validation.

The CLI/text helper refresh retains Hub 1.16.4 and its Typer <0.26 constraint.
See [3D Metal CLI/text helpers](PYTHON_RUNTIME_REFRESH.md#twenty-fourth-slice-3d-metal-cli-and-text-helpers-2026-11-12)
for the four compatible upgrades, complete-lock audits and synthetic caller
validation, which does not certify model inference or rendering.

The packaging-tool refresh preserves native source revisions and other build
pins, validating real isolated/offline hash installs and synthetic native
source/editable builds.
See [3D Metal packaging and installer tooling](PYTHON_RUNTIME_REFRESH.md#3d-metal-packaging-and-installer-tooling)
for exact scope, full-lock audits and the limits of installer-only coverage.

The standalone pybind11 3.1.0 refresh leaves Torch's already-vendored 3.1.0
headers and native source revisions unchanged. See
[TRELLIS retained pybind11 tooling](PYTHON_RUNTIME_REFRESH.md#trellis-metal-retained-pybind11-build-tooling)
for header ownership, native CPU build probes and their limits.
