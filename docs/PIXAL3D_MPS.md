# Pixal3D Metal runtime

The Apple Silicon lane uses Pixal3D-mac revision
`0be9e69a729432323dfb60a418801e5e9e7a1437`, CPython **3.13**, Torch **2.15.0**,
torchvision **0.29.2**, and natten **0.21.0**. Install Python 3.13 with Homebrew
(`brew install python@3.13`) or set `PYTHON_BIN` to that interpreter. The native
packages require Xcode's Metal 4 toolchain; the wheel lock targets macOS 26+
on Apple Silicon and CPython 3.13 only.

Install and **Repair install** both select the immutable fork revision and run
`scripts/setup-pixal3d-mps.sh` in its checkout. The old private `.venv` is rebuilt,
including when it contains Python 3.10. Model assets are retained. Setup installs
the complete hashed wheel closure, then four hashed source packages with
`--no-deps --no-build-isolation`, then the six vendored native packages against
that Torch ABI. Git archives the pinned source into the rebuilt environment,
so neither Repair's native builds nor subsequent renders use stale files from
the working checkout. The private build sources use C++20, as required by Torch
2.15 headers. Native import and MPS checks finish setup.

PortOS does **not** run upstream `scripts/setup_mac.sh`: that script restores
Torch 2.12.0/torchvision 0.27.0 and upgrades build tools outside the lock.
The status probe reads module availability and installed package metadata without
importing Torch, so a legacy runtime offers **Repair install** even when all its
native modules exist. The `generate_mps.py`/GLB output contract is unchanged.
Setup does not download models or run inference.

## Dependency resolution and audit

`scripts/requirements-pixal3d-mps.txt` records the wheel closure. Its generated
lock hashes every artifact; the header documents regeneration with patched uv
and `--exclude-newer` at least seven days before the update. The initial resolve
used uv 0.13.6 offline against a verified wheelhouse after an online source fetch
timed out. Each selected wheel's SHA-256, non-yanked status and upload date before
2026-11-03T00:00:00Z were checked against PyPI metadata. The separate
`requirements-pixal3d-mps-sources.lock.txt` hashes natten's sdist and the exact
MoGe, pipeline and utils3d source archives; build backends are in the wheel lock.

The old upstream set has OSV matches on accelerate, anyio, brotli, certifi,
diffusers, filelock, fsspec, gradio, pillow, python-multipart, starlette,
transformers and urllib3 as well as Torch. Those packages and the dependencies
needed by their patched versions are updated together. On 2026-11-10, OSV
`querybatch` returned **zero matches across all 106 distributions**: 96 wheel
packages (including pip/build tools), four source packages and six vendored
native packages. The query includes malicious-package (`MAL-`) records. Vendored
packages are audited by name/version and immutable source provenance; they are
not installed from their similarly named PyPI projects.

**Pillow override:** Gradio 6.x declares Pillow `<13`, while Pillow 13 is needed
to clear the current advisories. `overrides-pixal3d-mps.txt` explicitly selects
Pillow 13 for this **CLI-only** environment. The installed Gradio metadata still
reports that incompatibility to `pip check`. PortOS never starts Gradio; MoGe's
model imports and the image-to-GLB path are the compatibility boundary. Do not
reuse this lock for the fork's web demo or silently remove this override.

The 2026-11-12 network/cache refresh uses uv **0.13.7** with cutoff
**2026-11-05T00:00:00Z** and preserves the native source/ABI and Pillow override.
Its complete registry closure remains 96 identities; only the network helpers
and AnyIO's required Typing-Extensions companion change. See the eighteenth
slice in [the runtime refresh record](./PYTHON_RUNTIME_REFRESH.md) for complete
artifact/advisory results, real network-caller checks and native-render limits.

## JIT advisory boundary

[GHSA-rrmf-rvhw-rf47](https://github.com/advisories/GHSA-rrmf-rvhw-rf47)
affects Torch through 2.12.1; 2.13.0 is patched.
[Upstream b90c949](https://github.com/pytorch/pytorch/commit/b90c94991cdf8b87c8f7439f79518e0ef2c4ca4f)
rejects bare `list`/`tuple` annotations in the JIT frontend. Static inspection
found no `torch.jit.script` call in the pinned fork, its vendored packages,
or the pinned MoGe/pipeline/utils3d sources. The adapter passes an image path,
render options and output path; it accepts no Python code to compile. That
does not establish exploit reachability through every dependency. The runtime
is upgraded regardless of that reachability limit.

`scripts/verify-pixal3d-mps.py` runs the harmless upstream bare-container
regression and a correctly typed positive control, imports the native modules,
then checks the generated GLB for nonempty, finite, indexed triangle geometry.
It compiles only its own fixed functions, never input/model text.

## Native verification

Use a synthetic or licensed PNG and the lane's model assets, then run:

```sh
portos_root="$PWD"  # Start in the PortOS checkout.
cd ~/.portos/pixal3d-mps
.venv/bin/python .venv/portos-source/generate_mps.py /tmp/synthetic.png --device mps \
  --pipeline-type 1024_cascade --steps 4 --seed 7 --output /tmp/pixal3d-smoke.glb
.venv/bin/python "$portos_root/scripts/verify-pixal3d-mps.py" /tmp/pixal3d-smoke.glb
```

For an offline check, set `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1` on Generate
and ensure all required model and Torch Hub assets are already cached. Python
package locks do not freeze the fork's separate model/Torch Hub downloads.
Source resolution, import probes and mocked subprocess tests alone are not
proof that this native generation works.

On 2026-11-10, an isolated fresh install and a Repair over a Python 3.10 venv
both passed the native imports on arm64 macOS 27.2.1 with Metal compiler
32023.922 and CPython 3.13.18. PortOS's generate runner completed the synthetic
cube render on the locked runtime using the settings above and cached model
assets. The textured GLB passed validation with 786,723 vertices and 963,884
faces. The JIT regression and the typed positive control passed. The actual
installed inventory matched the audited 106 distributions; `pip check` reported
only the documented Gradio/Pillow metadata conflict.

The subsequent timm/PLY/Ninja maintenance refresh retains the same native
profile and source revisions. See [3D Metal timm/PLY/build maintenance](PYTHON_RUNTIME_REFRESH.md#twenty-first-slice-3d-metal-timmplybuild-maintenance-2026-11-12)
for exact upgrades, complete-lock audits, real CPU/native synthetic boundary
tests and the limits of that validation.

The CLI/text helper refresh retains Hub 1.16.4 and its Typer <0.26 constraint.
See [3D Metal CLI/text helpers](PYTHON_RUNTIME_REFRESH.md#twenty-fourth-slice-3d-metal-cli-and-text-helpers-2026-11-12)
for the four compatible upgrades, complete-lock audits and synthetic caller
validation, which does not certify model inference or rendering.
