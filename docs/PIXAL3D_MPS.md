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
the complete hashed wheel closure, then the hashed natten, pipeline and utils3d
archives with `--no-deps --no-build-isolation`. MoGe is unpacked from its
hash-verified archive, patched, and installed the same way. Setup then builds
the six vendored native packages against that Torch ABI. Git archives the pinned source into the rebuilt environment,
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

`scripts/ml/requirements/requirements-pixal3d-mps.txt` lists the direct CLI and
build inputs. Its generated lock hashes every wheel; the header documents
regeneration with hash-verified uv and `--exclude-newer` at least three days
before the update. The separate `requirements-pixal3d-mps-sources.lock.txt`
hashes natten's sdist and the exact MoGe, pipeline and utils3d source archives.
Build backends are direct inputs of the wheel lock.

Setup unpacks the hash-verified MoGe archive into `.venv/moge-src`, then
`scripts/ml/patch-moge-metadata.py` drops Gradio, switches `opencv-python` to
`opencv-python-headless`, and replaces the utils3d/pipeline Git URLs with the
locked local versions before `pip install --no-deps`. The wheel lock keeps one
OpenCV distribution, `opencv-python-headless==5.0.0.93`. `generate_mps.py` does
not import `pymeshlab`, so that package is not installed. PortOS never starts
the fork's Gradio application. `pip check` is part of setup verification.

On 2026-11-23, OSV `querybatch` returned **zero matches** for the 76 wheel
distributions plus the four hashed source pins (`natten` 0.21.0, `moge` 2.0.0,
`utils3d` 0.0.2, `pipeline` 1.0.0), including malicious-package (`MAL-`)
records. The cutoff was `2026-11-20T00:00:00Z`. Vendored native packages stay
on the pinned Pixal3D-mac revision and are not installed from PyPI. The
2026-11-10 audit of the previous Gradio-inclusive closure is historical only.

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

`scripts/ml/verify-pixal3d-mps.py` runs the harmless upstream bare-container
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
.venv/bin/python "$portos_root/scripts/ml/verify-pixal3d-mps.py" /tmp/pixal3d-smoke.glb
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
faces. The JIT regression and the typed positive control passed. That run still
installed the old Gradio-inclusive closure. The current lock omits Gradio and
the duplicate OpenCV wheel, and setup patches MoGe so `pip check` has no
metadata conflict from those packages.

Later dependency refreshes keep the native profile and source revisions. Retained
constraints are listed in [held-back pins](PYTHON_RUNTIME_REFRESH.md#held-back-pins);
the merged PRs carry the per-refresh audit evidence.
