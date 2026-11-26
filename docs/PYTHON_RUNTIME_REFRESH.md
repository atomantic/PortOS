# Python runtime refresh reference

Reference for the managed Python runtime profiles (`scripts/ml/requirements/requirements-*.txt`
sources and their `*.lock.txt` complete locks): which pins are deliberately held
back, and how to refresh one dependency without churning the rest of a lock.
Evidence for each past bump (uv versions, hash counts, probe results) lives in
the merged PRs and commits of [#15769](https://github.com/atomantic/PortOS/issues/15769),
[#15910](https://github.com/atomantic/PortOS/issues/15910),
[#15988](https://github.com/atomantic/PortOS/issues/15988) and
[#16047](https://github.com/atomantic/PortOS/issues/16047); it is not repeated here.

A newer release in the inventory is not evidence that an API or ABI is
compatible. Read the upstream requirement before retaining or moving a pin, and
record any new constraint in the table below. An outdated pin that is not in the
table is pending investigation, not a certified exception.

## Rules

- Refresh one profile (or one tightly coupled package set) per change. Isolate
  each major migration (librosa 1, Hub 2, PyAV 19, OpenCV 5, pandas 3,
  python-dateutil 4, trimesh 5) in its own PR and adapt the real callers.
- Preserve each profile's declared Python/platform targets, immutable source
  revisions, build constraints and intentional overrides.
- Resolver output, artifact hashes and fake-subprocess tests are different
  contracts from model execution. Apple Silicon and CUDA validation are
  independent work; a generic refresh must preserve declared target support
  (Pixal3D CUDA was restored separately in
  [#15855](https://github.com/atomantic/PortOS/pull/15855)).
- Locks keep hash enforcement and wheel-only installation, and use a three-day
  release cooldown (`--exclude-newer` at least three days old). Never compose
  artifact hashes by hand.

## Held-back pins

Package versions are as locked today. "Profile" names the source recipe or lock
family; a constraint that comes from an upstream `Requires-Dist` stays held until
that upstream moves or the caller is migrated.

| Package | Profile | Constraint | Reason / source |
| --- | --- | --- | --- |
| NetworkX 3.7, ContourPy 1.4, PyAV 19, Librosa 1 | Fixed CPython 3.11 profiles | Older compatible versions (e.g. PyAV 18) | These releases require Python 3.12+. Universal locks already select the newer versions on their eligible Python branches. |
| Librosa 0.11 | ACE-Step (revision `1bee4c9f5b43e30995f8d4d33b3919197ce1bd68`) | `==0.11` | Upstream `requirements.txt`, read by `setup.py`, pins it. Moving needs a source/API migration, not a pin override. |
| py3langid 0.3 | ACE-Step | `<0.4` | `from_pickled_model` is required by the caller and removed in 0.4. |
| fsspec 2026.7 | shared mflux-video | `<=2026.7.0` | `datasets` 5.1 requires `fsspec[http]<=2026.7.0`. |
| mpmath | Torch/model closures that include SymPy | `<1.4` | SymPy 1.14 requires `mpmath<1.4`. |
| huggingface-hub 1.x | mflux 0.24 (FLUX.3, shared mflux-video), frozen Laya source, Wan MLX (frozen MLX-Gen source) | `<2` | Each upstream requires Hub below 2. Hub 2 is a separate migration per profile. |
| MLX 0.32.2, mlx-lm `<0.32`, Transformers `<5.17`, Hub 1 | MTPLX 2.13.0 | As listed | MTPLX 2.13.0 requires exactly these ranges. |
| mlx-lm below 0.32.2, MLX 0.31.1 / 0.32.0 | LTX MLX (LTX-2.3 / LTX-2.5) | Frozen MLX baselines | mlx-lm 0.32.2 requires MLX at least 0.32.2, beyond the frozen LTX baselines. |
| Transformers 5.14.1, Hub 1 | LTX CUDA | Transformers `<5.15` | The frozen LTX source requires Transformers below 5.15. |
| uv-build 0.9.30 | LTX CUDA | `>=0.9.8,<0.10` | Frozen LTX source build requirement. |
| uv-build `<0.8` | MLX-Gen (Wan MLX) | `>=0.7.19,<0.8` | MLX-Gen build requirement. |
| Hatchling | LTX workspace | `<1.32` | Cap documented in the LTX workspace README. |
| Transformers 5.22.1 | Pixal3D CUDA, TRELLIS.2 CUDA | Exact | Immutable profile identities (`scripts/ml/*-cuda-profile.json`, registry cutoff 2026-11-04) and the setup assertion pin it. Moving is a new profile revision with CUDA validation. |
| `cuda-bindings==13.5.0` | LTX CUDA | Cooldown exception (#15454) | 28 artifacts postdate the fixed `2026-11-05T00:00:00Z` cutoff. Retained deliberately; do not claim every source meets the cutoff. |
| `trellis2-apple` revision `c873bde81ebe1e56535c6caddb4b21267364a923` | TRELLIS.2 Metal | Cooldown exception (#15708) | Commit dated 2026-11-09T16:25:19Z (seven days on 2026-11-16T16:25:19Z); carries the autorelease-pool leak repair. Preserve the repair. |
| `mtplx==2.13.0` | MTPLX | Cooldown exception (#17422) | Published 2026-11-22; the first release that loads the Inkling 2 Mini MTP packs. Only MTPLX bypasses the cutoff (`--exclude-newer-package mtplx=…`); its 45 dependencies keep the previous pins. |
| tokenizers 0.23.3 (upstream `<0.23` guard overridden) | FastVideo MLX | Pinned together with Transformers 5.22.x | Upstream's `<0.23` guard addressed a CLIP RobertaProcessing keyword mismatch that Transformers 5.22.x avoids (positional arguments); validated against actual CLIP load/save. Recorded as an inline comment in `scripts/ml/requirements/requirements-fastvideo-mlx.txt`. |

Immutable native source revisions, Torch/CUDA/MLX pins, platform markers and
artifact allowlists are never changed by a helper-package refresh.

## Selective regeneration

Use this to advance a few packages in a complete lock while every unrelated
version, marker, hash block and provenance comment stays byte-identical.

1. Use a hash-verified uv (the lock header names the version last used) and a
   cutoff at least three days old. Copy the profile's direct input and the
   `pyproject.toml` environment restriction from the lock header into a scratch
   directory.
2. Extract every existing `name==version` requirement, with its marker, from the
   current lock into a scratch constraints file, substituting only the selected
   versions. Fix any resolver bound the header records (for example
   `python_full_version < '3.15'`, because Torch has no Linux 3.15 wheel).
3. Run the header's `uv pip compile` command with `-c <constraints>` and a
   scratch output. Compare the complete resolved package/version/marker set with
   the original lock; only the intended packages may differ. For universal
   locks compare each declared Python/OS/architecture pair.
4. Transfer only the changed packages' generated blocks into the original lock.
   Keep companion hash blocks and `# via` provenance comments. This avoids
   unrelated constraint annotations and artifact-allowlist churn.
5. For CUDA profiles, resolve Torch (and Torchvision where used) from an
   explicit named CUDA index plus any CUDA-local package (for example
   `torchcodec==0.17.0+cu126`), and everything else from PyPI. Mixing the CUDA
   mirror for ordinary packages can select undated mirror artifacts that fail the
   cooldown check. The emitted lock still carries the existing CUDA extra-index
   URL and exact allowed hashes.
6. If PyPI is unreachable from the regenerating host, a temporary loopback relay
   to the official PyPI Simple JSON and `files.pythonhosted.org` may be used for
   resolution; keep upload dates, yanked status, metadata and hashes intact and
   never ship relay or index overrides to installers.
7. Verify every artifact hash against official non-yanked pre-cutoff registry
   metadata, and query OSV for every resolved identity, including `MAL-`
   records. Check response counts, errors and pagination; an unreadable or
   partial response is not a clean result.
8. Run the profile's installer, adapter and pins tests (for example
   `scripts/ml/_minimax_h3_mlx_pins.test.js`) and hash-required dry install plans
   for each declared target. Dry plans select artifacts without executing those
   runtimes; native or model execution claims need their own validation.
   `scripts/ml/cooled_runtime_probe.py` is an opt-in offline probe (SentencePiece,
   Reactor SDK, Pydantic) that enforces exact baseline/candidate versions: run it
   only in isolated scratch environments, baseline first (`--baseline`), then the
   candidate with the same fixtures directory, never in an installed runtime.
9. Update the lock header's bounded-regeneration line with the uv version and
   cutoff used.

Profile-specific notes: [MLX video locks](MLX_VIDEO_LOCKS.md),
[CUDA runtime locks](RUNTIME_LOCKS.md),
[ACE-Step 1.5 CUDA](ACESTEP15_CUDA.md), [Pixal3D Metal](PIXAL3D_MPS.md) and
[TRELLIS.2 Metal](TRELLIS2_METAL.md).
