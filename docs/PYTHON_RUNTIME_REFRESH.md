# Staged Python runtime refresh

Issue [#15769](https://github.com/atomantic/PortOS/issues/15769) tracks the
remaining cooled Python dependency updates. A source requirements file can be a
complete native environment contract; the inventory's newest candidate is not
evidence that its API or ABI is compatible.

## Delivery stages

1. Refresh small runtime profiles independently. The first slice updates Reactor
   SDK **1.0.1 → 1.13.0** and Demucs's SoundFile **0.13.1 → 0.14.0**. The other
   53 Demucs identities stay unchanged. The second slice updates Prompt
   Guard/jev PyTorch **2.14.0 → 2.14.1**, and re-resolves the unchanged lyric
   alignment profile; its evidence and remaining upgrades are recorded below.
2. Resolve compatible patches/minors per native profile against its immutable
   source descriptor. Preserve its declared Python/platform targets, native
   source revisions, build constraints and intentional overrides. Read the
   upstream requirement before retaining an outdated pin and record that exact
   API/ABI constraint with the relevant profile. Untouched pins are pending
   investigation, not certified compatibility exceptions.
3. Isolate each major migration in its own PR, including changes such as
   librosa 1, Hugging Face Hub 2, PyAV 19, OpenCV 5, pandas 3, python-dateutil 4
   and trimesh 5. Adapt the actual callers and regenerate the affected complete
   locks. Do not mix these migrations into native baseline maintenance.
4. Validate runtime changes separately on each actual target. Resolver output,
   artifact hashes and fake subprocess tests establish different contracts from
   model execution. Keep Apple Silicon and CUDA validation as independent work.
   Pixal3D CUDA remains unresolved under #15710; a generic refresh cannot enable it.

## First-slice compatibility and reproducibility

Both locks were regenerated online with hash-verified **uv 0.13.7**, using
`--exclude-newer 2026-11-04T00:00:00Z` on 2026-11-11. Each lock header contains its
profile's regeneration command. The Demucs command starts with the existing lock
so unrelated pins are reused; only the changed direct requirement moves.

Reactor's [versioned changelog](https://github.com/reactor-team/reactor-client-sdks/blob/python-v1.13.0/sdks/python/CHANGELOG.md)
and the published wheel preserve the streamed-generation calls used by
`scripts/reactor-render.py`: constructor/JWT, message callbacks, raw frame
callbacks, track selection, file upload, commands and disconnect. The optional
audio-device extra is not installed; the default SDK still has no runtime
dependencies. The lock includes all seven non-yanked release wheels and retains
the five existing OS/architecture markers. Additional musl artifact hashes do
not add an installer support target. All seven downloaded wheels matched PyPI's
SHA-256 values.

SoundFile's [0.14 release](https://github.com/bastibe/python-soundfile/releases/tag/0.14.0)
drops Python 3.9 and older, adds typing support and fixes concurrent file opens.
Demucs uses CPython 3.11 and its existing read/write calls remain supported.
Its adapter derives required versions and the rebuild identity directly from
the lock, so no separate adapter literal changes. Reactor likewise installs its
lock rather than a duplicated SDK version. Installers retain hash enforcement,
wheel-only installation and refusal of unsupported profiles.

## Verification on 2026-11-11

- OSV querybatch returned zero findings for all **55** distinct package/version
  identities in both complete locks, across every platform marker. The query
  includes malicious-package (`MAL-`) records; it does not audit the native SDK's
  bundled libraries as separate components.
- Fresh scratch Apple Silicon environments installed both locks with
  `--require-hashes --no-deps --only-binary :all:` and passed `uv pip check`.
  Reactor used CPython 3.12.11; Demucs used CPython 3.11.17.
- Reactor's real native SDK loaded, constructed its client offline and exposed
  the caller's async connection/command/upload methods. No provider session or
  paid generation was started.
- The real Demucs provisioner created and reused a scratch environment, and its
  exact interpreter/import/version/WAV-output probe passed. A CPU CLI run with
  local random `demucs_unittest` weights produced a finite stereo vocal WAV with
  the expected 44.1 kHz sample rate and frame count, without downloading weights.

Reactor live FastH3 stream behavior, Windows/Linux native installation, Demucs
Metal/CUDA execution and pretrained-model separation remain unverified. Existing
[Demucs validation limits](./DEMUCS_RUNTIME.md) still apply. Remaining profiles
and these target-specific validation items stay open in #15769; this slice does
not close that issue or assert a repository-wide refresh.

## Second-slice CPU patch and revalidation (2026-11-11)

Prompt Guard and jev now use PyTorch **2.14.1** in both adapter package lists
and the shared source requirements. Its [published requirements](https://pypi.org/pypi/torch/2.14.1/json)
match 2.14.0, including the Linux CUDA 13 dependency versions. The complete
56-identity guard lock was regenerated with hash-verified **uv 0.13.7** and
`--exclude-newer 2026-11-04T00:00:00Z`, reusing the existing lock. Only PyTorch
and its 24 artifact hashes changed; all other identities and platform markers
remain identical. The header command preserves that reuse, restricts compilation
to wheels and records the actual cutoff. Separate guard and jev environments,
exact-version readiness probes and install-time canary gates remain in place.

The lyric alignment source already pins cooled TorchAudio **2.11.1** and the
newest compatible NumPy releases: **2.4.6** on Python 3.11, **2.5.4** on 3.12+.
[NumPy 2.5.4 requires Python 3.12+](https://pypi.org/pypi/numpy/2.5.4/json).
[TorchAudio 2.11.1 requires torch >=2.11](https://pypi.org/pypi/torchaudio/2.11.1/json),
so its existing 2.14.1 torch pin remains compatible with the declared dependency.
Re-resolving its complete 33-identity lock with the same uv/cutoff produced the
same versions, markers and hashes; only scratch-relative annotations differed.
The shipped lyric source and lock are therefore unchanged.

Two older transitive/direct pins have concrete upstream constraints:
[Transformers 5.16.1](https://pypi.org/pypi/transformers/5.16.1/json) requires
`huggingface-hub>=1.5,<2`, so Hub 2 cannot enter this frozen classifier baseline;
[SymPy 1.14.0](https://pypi.org/pypi/sympy/1.14.0/json) requires
`mpmath>=1.1,<1.4`, excluding the cooled mpmath 1.4 releases in both CPU locks.
These are compatibility constraints, not security exceptions. PyTorch 2.15's
changed CUDA/Triton closure and newer Transformers/Hub combinations remain
pending compatibility work under #15769; retaining this patch baseline does
not certify that those newer releases are incompatible.

Verification for this slice:

- All hashes in both complete locks match non-yanked PyPI artifacts published
  before the cutoff. OSV querybatch, including `MAL-` records, returned **zero
  findings across 57 distinct package/version identities**.
- Fresh scratch Apple Silicon CPython **3.11.17** and **3.12.11** environments
  installed the complete guard lock with
  `--require-hashes --no-deps --only-binary :all:` and passed `uv pip check`.
  Native imports on 3.12 matched all four direct adapter pins.
- Offline random-weight fixtures exercised the shipped Prompt Guard Python
  runner with a DeBERTa classifier (1,200 tokens, three complete overlapping
  windows, finite scores), and jev's real Qwen3.5 loader, pair scorer and hidden
  state pooling (two pairs, normalized scores, finite pooled vectors) on CPU.
  These prove native tensor/API execution with synthetic weights and establish
  no classifier accuracy or security effectiveness.
- The exact cached production Prompt Guard snapshot
  `a8ded8e697ce7c355e395a0df51f94adb4a2fd27` passed the real offline CPU install
  canary on the fresh Python 3.12 runtime: the shipped runner classified the
  installer's repeated benign sentence in three windows, and the server's
  `normalizeModelAbuseGuardResult` accepted it as complete and safe. This is
  one benign-canary contract, not an adversarial accuracy evaluation.
- Eight focused installer/profile/service/Python-runner files passed **94
  tests**, covering hash-only installs, unsupported-host refusal, readiness and
  failed-canary gating, sidecar lifecycle and complete-window contracts.

Remaining under #15769: the other native profiles and isolated major migrations
listed above, newer CPU minor releases, production jev scoring, Windows/Linux native
install/Repair, and
independent Apple Silicon acceleration/CUDA execution validation. No production
model download, provider session or paid generation was started. Pixal3D CUDA
remains unresolved under #15710.

## Third-slice FastVideo timm patch (2026-11-11)

The Apple Silicon FastVideo profile updates **timm 1.0.29 → 1.0.31**. Its
immutable FastVideo revision remains
`fa2d1324c60050cd65209c6aaeac470e7fb412f5`; Torch, TorchVision, MLX/MLX-Metal,
build dependencies and all other runtime versions remain unchanged. This is a
single-package compatibility slice, not a refresh of the other older pins.

The pinned [FastVideo requirements](https://github.com/hao-ai-lab/FastVideo/blob/fa2d1324c60050cd65209c6aaeac470e7fb412f5/pyproject.toml)
accept `timm>=1.0.11`. Its Synchformer consumers import `timm.layers.to_2tuple`
and `trunc_normal_`; the VBench human-action adapter uses
`timm.models.create_model`, with FastVideo's existing shim for the upstream
model factory's unsupported `cache_dir` argument. The
[timm 1.0.31 wheel metadata and changelog](https://pypi.org/pypi/timm/1.0.31/json)
retain these APIs and the same five runtime dependency names. Its Python floor
rises from 3.8 to 3.10, within this profile's existing 3.11+ floor. The wheel was
published on 2026-11-03 at 19:24:54 UTC and its downloaded SHA-256 matched PyPI.
No change to the pinned native source or compatibility shims is required by
these inspected API contracts; pretrained-model behavior remains unverified.

The complete **85-entry** lock was regenerated online with hash-verified
**uv 0.13.7** and `--exclude-newer 2026-11-04T00:00:00Z`. The header command
reuses the existing lock and upgrades only timm. All other 84 entries, environment
markers and artifact hashes are identical. Every one of the resulting **2,305
hashes** matches a non-yanked PyPI artifact published before the cutoff. OSV
querybatch, including malicious-package (`MAL-`) records, returned zero findings
for all 85 distinct package/version identities. This does not separately audit
bundled native libraries.

Fresh scratch Apple Silicon environments on CPython **3.11.17** and **3.12.11**
installed the complete lock with `uv pip sync --require-hashes --only-binary
:all:` and passed `uv pip check`. Native CPU tests on 3.11 imported timm with the
locked Torch **2.15.0** / TorchVision **0.29.2**, exercised the used layer helpers,
and ran a small random-weight ViT forward pass with finite three-class output.
On 3.12, the exact pinned FastVideo source, MLX and its real Synchformer
`vit_helper` consumer also imported successfully with the refreshed timm.
These checks download no pretrained weights and establish no model accuracy.
Three focused files passed **167 tests**, covering installer/Repair hash and
source-revision enforcement, unsupported-host refusal, locked package repair
and the FastVideo runner's dispatch/progress contracts.

Remaining under #15769: production FastVideo/VBench model execution and Metal
inference, all other native-profile compatibility work, isolated major
migrations, newer CPU minor updates and the previously recorded independent
platform/acceleration checks. This slice changes an Apple Silicon-only profile;
it neither adds CUDA/Windows/Linux support nor resolves Pixal3D CUDA #15710.

## Fourth-slice MiniMax H3 MLX patch (2026-11-11)

The MiniMax H3 Apple Silicon profile updates the coupled **MLX / MLX-Metal
0.32.0 → 0.32.4** pair. The immutable H3 source remains
`fcd9e9b79a1d6018d91ac477c0968de1fa067e49`, and all other 53 package versions,
markers and hashes remain unchanged. The installer consumes the lock directly;
there is no separate adapter version literal to update. Older untouched pins
remain pending investigation under #15769, rather than compatibility exceptions.

The pinned [H3 requirements](https://github.com/PipeNetwork/minimax-h3-mlx/blob/fcd9e9b79a1d6018d91ac477c0968de1fa067e49/requirements.txt)
accept `mlx>=0.32.0`. [MLX 0.32.4 metadata](https://pypi.org/pypi/mlx/0.32.4/json)
requires the matching `mlx-metal==0.32.4` on Darwin and Python 3.10+, within
this installer's Python 3.11 contract. Both MLX-project distributions retain
Apple Silicon wheels for macOS 14/15/26 and were published on 2026-10-14.
The [patch release notes](https://github.com/ml-explore/mlx/releases/tag/v0.32.4)
include attention, array-view and Metal evaluation fixes. The pinned port's
`mlx.core`, `mlx.nn`, attention, scheduler and modulation-cache callers were
inspected; no source/API migration is required by the checks below.

The complete **55-package** lock was regenerated online with SHA-256-verified
**uv 0.13.7**, `--only-binary :all:` and a freshly computed seven-day cutoff,
`--exclude-newer 2026-11-04T00:00:00Z`. Its header records the command and the
source header uses the same wheel-only policy. All **1,125 hashes** match
non-yanked PyPI artifacts older than the cutoff. OSV querybatch returned zero
findings for all 55 package/version identities, including malicious-package
(`MAL-`) records. This does not separately audit bundled native libraries or
claim new support targets from additional artifact hashes.

Verification used a fresh scratch Apple Silicon CPython **3.11.17** environment
on macOS **26.6.2** (arm64):

- The complete lock installed with `uv pip sync --require-hashes --only-binary
  :all:` and passed `uv pip check`. MLX and MLX-Metal both reported 0.32.4.
- The shipped `minimax_h3_runtime_probe.py --verify-seams` passed against the
  exact pinned source, including the actual H3 pipeline, Qwen3-VL imports,
  encoder-source digest and all borrowed processor seams. Torch and TorchVision
  remain absent as required by this MLX-native profile.
- The pinned upstream tiny random-weight DiT smoke ran on Metal: finite video
  `(1, 9, 16)` and audio `(1, 3, 8)` outputs, exact live-versus-cached AdaLN
  output parity and unchanged output after dropping cached projection weights.
  Its sigma/timestep schedule check passed. This is synthetic tensor execution,
  not production H3 model inference or an image/audio quality evaluation.
- Executing the shipped installer block with fake external processes passed
  fresh/reuse paths, unsupported-host refusal before installation, hash-sync
  rejection before the probe, and failed-probe refusal to report readiness.
  Three focused installer/probe/runner test files passed **223 tests** with four
  existing conditional skips.

Remaining under #15769: production MiniMax H3 model loading, text/keyframe
rendering and output quality on Apple Silicon; every other pending profile,
isolated major migration and previously recorded platform-specific check.
This Apple Silicon-only slice changes no CUDA profile and does not enable
Windows/Linux H3 MLX support or resolve Pixal3D CUDA #15710. No production
weights, provider session or paid generation was started.
