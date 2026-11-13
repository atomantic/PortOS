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
   Pixal3D CUDA was restored separately in [#15855](https://github.com/atomantic/PortOS/pull/15855);
   a generic dependency refresh must preserve its declared target support.

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
there is no separate adapter version literal to update. Its sync now also
requires wheels, preventing hashed source distributions from triggering
unlocked build-dependency resolution. Older untouched pins
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

## Fifth-slice FLUX.2 Apple Silicon SDNQ patch (2026-11-11)

The FLUX.2 Apple Silicon profile updates **SDNQ 0.2.8 → 0.2.9**. Its other
52 lock entries, Python/platform markers and artifact hashes remain unchanged,
including Torch **2.15.0**, TorchVision **0.29.2**, Diffusers **0.42.1** and
Transformers **5.22.1**. Older untouched pins remain pending investigation under
#15769. No immutable native source or CUDA profile changes in this slice.

[SDNQ 0.2.9's published metadata](https://pypi.org/pypi/sdnq/0.2.9/json)
retains the Python 3.10 floor and the same four unversioned dependencies (Torch,
Diffusers, Transformers and Accelerate), within the profile's Python 3.11+
contract. Its universal wheel was published on 2026-11-03 at 19:57:57 UTC and
its downloaded SHA-256 matched PyPI. The
[patch release notes](https://github.com/Disty0/sdnq/releases/tag/v0.2.9) describe
attention fixes and changed dynamic-quantization loss behavior. The shipped
`flux2_macos.py` loader imports SDNQ for quantizer registration before calling
Diffusers `from_pretrained`; the new wheel preserves that registration for both
Diffusers and Transformers. No runner API adaptation is needed by these checks.
Production prequantized-model loading and output quality remain unverified.

The complete **53-entry** lock (51 package names, including Python-dependent
NumPy and NetworkX versions) was regenerated online with SHA-256-verified
**uv 0.13.7**, `--only-binary :all:` and freshly computed seven-day cutoff
`--exclude-newer 2026-11-04T00:00:00Z`. The header records the command, reusing
the existing lock and upgrading only SDNQ. All **1,016 hashes** match non-yanked
PyPI artifacts older than the cutoff. OSV querybatch, including malicious-package
(`MAL-`) records, returned zero findings across all 53 package/version identities.
This does not separately audit bundled native libraries. Apple Silicon
Install/Repair now requires wheels as well as hashes and `--no-deps`, preventing
hashed source archives from fetching unlocked build dependencies.

Verification used fresh scratch Apple Silicon environments on CPython
**3.11.17** and **3.12.11**:

- Both environments installed the complete lock with `uv pip sync --require-hashes --only-binary
  :all:` and passed `uv pip check`.
- Native CPU checks imported the actual FLUX.2/Qwen-Image pipeline classes and
  verified SDNQ's Diffusers/Transformers config/quantizer registration. A tiny
  random-weight two-layer network became `SDNQLinear` layers and produced finite
  `(2, 128)` output. These are synthetic quantization/API checks, not production
  FLUX.2 inference or an evaluation of image quality or acceleration.
- Installer/profile/runtime tests retain hash-only installation, unsupported-host
  refusal, failed-install/probe readiness gating and CUDA fresh/Repair coverage;
  the Apple Silicon contract also checks every source pin against the lock and
  wheel-only installation.

Remaining under #15769: production FLUX.2 SDNQ model loading/render quality,
Apple Silicon MPS execution, and independent Windows/Linux CUDA validation.
The CUDA SDNQ pins remain **0.2.8**: the existing multi-index regeneration command
refuses the cooldown because `https://download.pytorch.org/whl/cu126` exposes
Pillow 13.0.0 artifacts without upload timestamps. This is resolver metadata
availability, not evidence that SDNQ 0.2.9 is incompatible. The next CUDA slice
must scope the CUDA index to Torch or supply a complete hash-verified index with
verified publication dates before regenerating both target locks; do not remove
the cooldown or guess artifact ages. All earlier profile, isolated-major and
target-specific checks remain pending. No production weights, provider session
or paid generation was started; Pixal3D CUDA remains unresolved under #15710.

## Sixth-slice MiniMax Music 3 MLX patch (2026-11-12)

The MiniMax Music 3 Apple Silicon profile updates the coupled **MLX /
MLX-Metal 0.32.1 → 0.32.4** pair. The other **33** package versions, markers
and hashes remain unchanged, including mlx-audio **0.5.0**, Transformers
**5.15.0** and Hugging Face Hub **1.28.0**. These untouched versions remain
pending compatibility work, not certified exclusions of newer releases.

[mlx-audio 0.5.0's published requirements](https://pypi.org/pypi/mlx-audio/0.5.0/json)
accept `mlx>=0.31.1`; [MLX 0.32.4](https://pypi.org/pypi/mlx/0.32.4/json)
requires the matching `mlx-metal==0.32.4` on Darwin and retains Apple Silicon
wheels and the Python 3.10 floor. The
[MLX patch release notes](https://github.com/ml-explore/mlx/releases/tag/v0.32.4)
include attention, array-view and Metal evaluation fixes. The installed
mlx-audio music loader, MiniMax Music 3 model and its MLX attention/tensor callers
were inspected and exercised below. No source migration is required by those
bounded checks. Transformers 5.15.0 explicitly requires
[`huggingface-hub>=1.5,<2`](https://pypi.org/pypi/transformers/5.15.0/json), so
Hub 2 is excluded from this frozen baseline; this does not assess a coordinated
Transformers migration.

The complete **35-package** lock was regenerated online with SHA-256-verified
**uv 0.13.7**, `--only-binary :all:` and freshly computed seven-day cutoff
`--exclude-newer 2026-11-05T00:00:00Z`. Its header records the actual cutoff and
regeneration command, retaining the existing output to reuse unrelated pins.
All **636 hashes** match non-yanked PyPI artifacts older than the cutoff. OSV
querybatch, including malicious-package (`MAL-`) records, returned zero findings
across the complete closure. This does not separately audit bundled libraries.

Install/Repair now requires wheels as well as hashes and `--no-deps`, preventing
hashed source archives from fetching unlocked build dependencies. The existing
[NumPy 2.5.4](https://pypi.org/pypi/numpy/2.5.4/json) and
[SciPy 1.18.1](https://pypi.org/pypi/scipy/1.18.1/json) pins already require
Python **3.12+**. The installer checks the selected base when creating or
rebuilding a venv, and the actual venv interpreter before installing. A supported
existing venv can be repaired even when the selected base is older; incompatible
interpreters receive an explicit requirement or rebuild diagnostic. This clarifies
the frozen baseline, without downgrading its closure or adding a Python 3.11
support target.

Verification on Apple Silicon:

- Fresh scratch CPython **3.12.11** and **3.13.18** environments installed the
  entire lock with hashes and wheels only and passed `uv pip check`. Both
  imported the actual music loader and evaluated MLX operations.
- The real mlx-audio MiniMax Music 3 `ModelConfig.tiny()` generated finite
  channels-last stereo audio at **44.1 kHz** on Metal, with two denoising steps
  and synthetic random weights. The shipped sidecar's orientation and resampling
  functions converted it to finite channels-first stereo at **32 kHz**.
  This establishes native tensor/API compatibility, not production music quality.
- Executing the installer section with fake external processes covers fresh
  Install, Repair reuse, host/Python refusal before package installation, and
  failed-install/probe refusal to report readiness. Source-to-lock parity and
  the existing runtime profile/sidecar contracts remain covered.

Remaining under #15769: production MiniMax Music 3 weight loading, full-song
rendering and audio quality on Apple Silicon; every other pending profile,
isolated major migration and previously recorded target-specific check. No
production weights, provider session or paid generation was started. This
Apple Silicon-only slice changes no CUDA profile or platform support and leaves
Pixal3D CUDA unresolved under #15710.

## Seventh-slice Music3 network/cache dependencies (2026-11-12)

The MiniMax Music 3 Apple Silicon lock updates **AnyIO 4.15.1 → 4.16.0**
and **FileLock 4.2.6 → 4.2.7**. All other **33** package versions, markers
and hashes are unchanged, including the model library, MLX/MLX-Metal,
Transformers and Hugging Face Hub. These are transitive dependencies of the
frozen Hub/HTTPX stack; direct source requirements and adapter pins do not
change. Untouched older versions remain pending compatibility work.

[AnyIO 4.16.0](https://pypi.org/pypi/anyio/4.16.0/json) keeps the same dependency
requirements and Python 3.10 floor. Its
[release notes](https://anyio.readthedocs.io/en/stable/versionhistory.html)
include socket and cancellation fixes. [FileLock 4.2.7](https://pypi.org/pypi/filelock/4.2.7/json)
keeps no runtime dependencies and a Python 3.11 floor, within Music3's existing
3.12+ contract. Its [patch notes](https://github.com/tox-dev/filelock/releases/tag/4.2.7)
fix a soft-lease case; the pinned Hub uses the existing `FileLock`/`SoftFileLock`
context-manager API. HTTPX's pinned HTTPcore backend uses AnyIO TCP, TLS,
timeout and stream APIs, which remain available. No caller adaptation is required
by the bounded checks below. The two downloaded universal wheels matched PyPI
SHA-256 values and were published on November 1 and November 2, respectively.

The complete **35-package** lock was regenerated online with SHA-256-verified
**uv 0.13.7**, wheels only and a freshly computed seven-day cutoff,
`--exclude-newer 2026-11-05T00:00:00Z`. Its header records the command, reusing
the existing lock and upgrading only the two selected versions. All **636
hashes** match non-yanked pre-cutoff PyPI artifacts. OSV querybatch, including
`MAL-` records, returned zero findings across the complete closure; bundled
native libraries are not separately audited.

Fresh scratch Apple Silicon CPython **3.12.11** and **3.13.18** environments
on macOS **26.6.2** installed the entire lock with hashes and wheels only and
passed `uv pip check`. On both, the real Hub client downloaded a synthetic fixture from a loopback HTTP
server and reused its offline cache; its real async client completed a loopback
request, rejected a stalled response with `ReadTimeout`, then completed another
request. The Music3 loader imported and basic MLX tensors evaluated. These are
native dependency/API checks, not model inference. Existing installer tests
exercise fresh Install, Repair reuse, host/Python refusal and failed-install/probe
readiness gating; sidecar and profile contracts also pass.

The same investigation deliberately retains MTPLX's MLX **0.32.2** baseline:
[MTPLX 2.12.2's published requirements](https://pypi.org/pypi/mtplx/2.12.2/json)
pin `mlx==0.32.2` on Apple Silicon, `mlx-lm>=0.31,<0.32` and
`transformers>=5.10.0,<5.17,!=5.13.0`. Its current 0.31.3/5.16.1 pair satisfies
those constraints. Moving these versions requires a coordinated MTPLX update;
this slice changes no MTPLX source or lock.

Remaining under #15769: production Music3 weight loading, full-song rendering
and quality; other pending profiles, isolated major migrations and prior
independent target acceptance. No production weights, provider session or paid
generation was started. CUDA profiles and immutable native sources are unchanged;
Pixal3D CUDA remains unresolved under #15710.


## Eighth-slice ACE-Step lyric and cache dependencies (2026-11-12)

The ACE-Step Apple Silicon profile updates **pypinyin 0.53.0 → 0.55.0**
and **FileLock 4.2.6 → 4.2.7**. All other **139** lock entries retain their
versions, markers and hashes. The immutable ACE-Step revision remains
`1bee4c9f5b43e30995f8d4d33b3919197ce1bd68`; CUDA profiles are unchanged.

[pypinyin's versioned release notes](https://github.com/mozillazg/python-pinyin/blob/v0.55.0/CHANGELOG.rst)
describe corrected phrase segmentation and updated pronunciation dictionaries.
Its Python requirement and dependencies are unchanged. The pinned ACE-Step
[`chinese_transliterate` caller](https://github.com/ace-step/ACE-Step/blob/1bee4c9f5b43e30995f8d4d33b3919197ce1bd68/acestep/models/lyrics_utils/lyric_tokenizer.py)
uses `pinyin`, `Style.TONE3`, `heteronym=False` and
`neutral_tone_with_five=True`; those APIs remain available. This deliberately
overrides upstream's older exact pypinyin requirement after the bounded tokenizer
checks below. Dictionary changes are intentional, not a claim of byte-identical
pronunciation for every phrase. FileLock's retained context-manager API is used
by the locked Hugging Face Hub client; its
[4.2.7 patch](https://github.com/tox-dev/filelock/releases/tag/4.2.7)
fixes a soft-lease case. Both downloaded wheels matched their PyPI SHA-256 values
and predate the seven-day cutoff.

**py3langid remains 0.3.0 for a concrete API constraint.** The pinned
[`LangSegment` constructor](https://github.com/ace-step/ACE-Step/blob/1bee4c9f5b43e30995f8d4d33b3919197ce1bd68/acestep/language_segmentation/LangSegment.py)
calls `LanguageIdentifier.from_pickled_model`. The 0.4.0 wheel removes that
method and changes its bundled model format to NPZ/XZ. Substituting 0.4.0
reproduces `AttributeError` before segmentation. A coordinated source/model
migration is required; unrelated older pins remain pending investigation.

The complete **141-entry** runtime lock was regenerated with SHA-256-verified
**uv 0.13.7**, reusing the existing output and upgrading only the two selected
packages. Its header records `--exclude-newer 2026-11-05T00:00:00Z` and the
regeneration command. All **3,845 hashes** match non-yanked, pre-cutoff PyPI
artifacts. OSV querybatch, including `MAL-` records, returned zero findings for
the full closure, with complete non-error responses and pagination checked.

Install/Repair now bootstraps **Cython 3.3.1**, **setuptools 84.2.1**,
**wheel 0.48.0** and **packaging 26.3** from a separate complete hash lock,
then syncs the runtime and installs the pinned checkout with build isolation
disabled. This prevents build-tool resolution for source-only docopt/unidic-lite
and mojimoji's newer-Python source builds. Wheels remain preferred when available;
the Python 3.11+ contract is unchanged. The build lock's **45 hashes** also match
non-yanked pre-cutoff artifacts, and its four identities have zero OSV/MAL findings.
Shared build/runtime versions agree; Cython is only needed during bootstrap.

Fresh scratch Apple Silicon CPython **3.11.17** and **3.13.16** environments
installed the complete runtime lock and passed dependency checks. The actual
pinned lyric tokenizer produced valid vocabulary IDs and expected tone-numbered
Chinese strings; the retained language segmenter handled a mixed English/Chinese
fixture. The real Hub client completed concurrent loopback downloads of one
synthetic fixture and reused its offline cache. Installer regression tests cover
fresh Install, Repair, source/build parity, unsupported host/interpreter refusal,
and build/sync/probe failures that must never report readiness.

These are native dependency and tokenizer/cache checks, not production music
inference or an audio-quality evaluation. Production ACE-Step generation and
MPS behavior remain unverified. This slice does not add target support, alter
CUDA pins, download production weights, or resolve Pixal3D CUDA #15710. Remaining
profile and isolated-major migrations continue under #15769.

## Ninth-slice FLUX.3 network/cache dependencies (2026-11-12)

The isolated FLUX.3 Apple Silicon profile updates **AnyIO 4.15.1 → 4.16.0**,
**FileLock 4.2.6 → 4.2.7** and **Platformdirs 4.14.2 → 4.14.3**. The other
**54** locked entries retain their versions, markers and hashes, including
mflux 0.24.0, MLX/MLX-Metal 0.32.4 and the Transformers/Hub pair. Direct source
pins and model identifiers are unchanged. Older pins not assessed here remain
part of the staged investigation, not certified compatibility exceptions.

The versioned release notes describe
[AnyIO socket/cancellation fixes](https://github.com/agronholm/anyio/blob/4.16.0/docs/versionhistory.rst),
[FileLock soft-lease recovery](https://github.com/tox-dev/filelock/blob/4.2.7/docs/changelog.rst)
and [Platformdirs XDG whitespace preservation](https://github.com/tox-dev/platformdirs/blob/4.14.3/docs/changelog.rst).
The pinned HTTPcore backend uses AnyIO TCP/stream/timeout APIs; Hub uses the
FileLock/SoftFileLock context-manager API; mflux's defaults call
`platformdirs.user_cache_dir(appname="mflux")`. These APIs remain available,
and the three releases' Python floors are within this profile's existing
Python 3.12 baseline. No caller adaptation is required by the checks below.
The Platformdirs fix is Linux-specific; its adoption here keeps the patch
baseline current and does not add a Linux FLUX.3 target.

The complete **57-package** lock was regenerated with SHA-256-verified
**uv 0.13.7**, wheels only and cutoff `2026-11-05T00:00:00Z`, preserving the
existing output and upgrading only the selected versions. All **1,328 hashes**
match non-yanked pre-cutoff PyPI artifacts. OSV querybatch, including `MAL-`
records, returned zero findings across the full closure; complete responses,
errors and pagination were checked. Bundled native libraries are not separately
audited. The selected wheels were hash-verified against live PyPI metadata.

Install/Repair now requires wheels, preventing a hashed source archive from
resolving unpinned build dependencies. The readiness probe now requires
Python **3.12+**, matching the installer's existing managed Python 3.12 and
the locked NumPy requirement. Failure tests cover package sync and probe
errors without false readiness, successful subsequent Repair, and unsupported
host refusal before tool resolution. Existing cancellation, isolated environment,
source/lock parity and all-package readiness checks remain in place.

Fresh scratch Apple Silicon CPython **3.12.11** and **3.13.18** environments
installed the complete lock with hashes and wheels only and passed dependency
checks. Both actual FLUX.3 generation/edit CLI imports, all locked-version probes,
basic MLX evaluation, mflux default/overridden cache paths, concurrent Hub loopback
fixture downloads/offline cache reuse and real async HTTP timeout/recovery passed.
These establish dependency/API compatibility, not production FLUX.3 inference,
image quality or model-level MPS behavior. No model weights, provider calls or
paid generation were started. Other profiles, isolated majors and earlier
unverified inference remain under #15769; CUDA profiles and Pixal3D #15710 are
unchanged.

## Tenth-slice MiniMax H3 HTTP/cache dependencies (2026-11-12)

The Apple Silicon H3 profile updates six direct, fully pinned dependencies:
**AnyIO 4.14.2 → 4.16.0**, **Certifi 2026.10.19 → 2026.10.23**,
**Charset-Normalizer 3.4.9 → 3.5.2**, **FileLock 4.2.1 → 4.2.7**,
**fsspec 2026.7.0 → 2026.9.0** and **IDNA 3.18 → 3.20**. The other
**49** entries retain their versions, markers and hashes. The immutable H3
revision remains `fcd9e9b79a1d6018d91ac477c0968de1fa067e49`; MLX, model
libraries, source adapters and CUDA profiles are unchanged.

The pinned Hub/HTTPX/HTTPcore stack uses FileLock context managers and AnyIO
socket/timeout APIs; Hub's `HfFileSystem` subclasses fsspec's abstract and
buffered-file interfaces. Requests consumes Charset-Normalizer's detection,
IDNA encoding and Certifi's CA bundle. These interfaces remain available:

- [AnyIO's release notes](https://github.com/agronholm/anyio/blob/4.16.0/docs/versionhistory.rst)
  and [FileLock's patch history](https://github.com/tox-dev/filelock/blob/4.2.7/docs/changelog.rst)
  describe cancellation, socket and lock recovery fixes.
- [Charset-Normalizer 3.5.2](https://github.com/jawah/charset_normalizer/blob/3.5.2/CHANGELOG.md)
  corrects UTF-8 Chinese detection and encoding alias handling. Its wheel-based
  Cython transition introduces no source-build dependency here.
- [IDNA 3.20](https://github.com/kjd/idna/blob/v3.20/HISTORY.md) updates Unicode
  tables and enforces domain validity more strictly. Unicode URL preparation and
  invalid-label rejection were checked; invalid names are not promised compatibility.
- [Certifi's release diff](https://github.com/certifi/python-certifi/compare/2026.10.19...2026.10.23)
  removes two emSign roots while preserving `where()`/`contents()`. Loading the
  resulting store was checked; this is not certification of every remote TLS chain.
- [fsspec's tagged history](https://github.com/fsspec/filesystem_spec/blob/2026.9.0/docs/source/changelog.rst)
  records cache, filesystem and range-handling changes. The real pinned Hub
  filesystem's read/seek path was exercised against a loopback fixture.

The complete **55-package** lock was regenerated with SHA-256-verified
**uv 0.13.7**, wheels only and cutoff `2026-11-05T00:00:00Z`. All **1,204 hashes**
match non-yanked pre-cutoff PyPI artifacts. The complete OSV/MAL audit returned
zero findings with response/error/pagination checks. Each selected wheel also
matched live PyPI metadata. Bundled native libraries were not separately audited.

Fresh Apple Silicon CPython **3.11.17** and **3.12.11** environments installed
all locked wheels and passed dependency checks and the actual shipped
`minimax_h3_runtime_probe.py --verify-seams` against the immutable source.
Both passed complete version parity, concurrent Hub downloads/offline reuse,
Hub/fsspec read/seek, async HTTP timeout/recovery, Requests Unicode response
handling, IDNA URL preparation, CA-store loading and basic MLX evaluation.
A Starlette request/background-task probe also passed. Its test-only HTTPX
adapter emits an upstream deprecation recommending HTTPX2; this is not a
production H3 import, and migrating the frozen Hub/HTTPX pair remains separate
work under #15769 rather than adding a second transport for this test.

Installer regression tests now execute the actual H3 block with fake external
processes, covering fresh Install, Repair reuse, source-seam checks, unsupported
host refusal and sync/probe failures without false readiness. No production
weights, model generation or quality assessment ran. Production H3 inference
and the remaining profile/major migrations stay unverified under #15769.


## Eleventh-slice FLUX.2 CUDA SDNQ refresh (2026-11-12)

The Windows and Linux CUDA profiles update **SDNQ 0.2.8 → 0.2.9**, matching
its already-refreshed MLX counterpart. The **51** other Windows entries and
**69** other Linux entries retain their exact versions, markers and hash sets.
Torch **2.14.1+cu126**, Torchvision **0.29.2**, Diffusers **0.42.1** and the
native CUDA baseline are unchanged. No runtime adapter changes are needed.

The [SDNQ release comparison](https://github.com/Disty0/sdnq/compare/v0.2.8...v0.2.9)
includes quantized-layer compute-dtype reporting, attention alignment/stride
fixes and configurable dynamic-quantization loss weights. Its existing
Diffusers/Transformers registration, `SDNQConfig` and module-quantization APIs
remain available. CUDA/Triton kernels are part of that upstream change; the
checks below do not certify their execution or numerical quality on a GPU.

This resolves the CUDA regeneration blocker recorded in the fifth slice.
The documented recipe now derives a temporary uv project from the exact source
requirements and scopes the official CUDA index explicitly to Torch. Unrelated
packages resolve on PyPI with publication dates instead of failing the cooldown
on undated PyTorch mirrors. Installation retains the existing CUDA index and
`unsafe-best-match` strategy, constrained by the complete versions and hashes.
No cooldown exemption or floating fallback was introduced. Generated annotations
are omitted so temporary project paths cannot enter the committed locks.

The tested recipe uses SHA-256-verified **uv 0.13.7**, wheels only and cutoff
`2026-11-05T00:00:00Z`. The Windows lock has **52 entries / 944 hashes**; Linux
has **70 / 1,041**. The union has **71 package-version identities / 1,042 hashes**.
All hashes match non-yanked pre-cutoff artifacts: the **24** Torch hashes and
**16** preserved Triton build hashes are verified against official PyTorch
index upload metadata; all remaining hashes match PyPI. Complete OSV querybatch
responses, including `MAL-` records, returned zero findings across the union plus
Torch's public base version. Errors, pagination and result counts were checked.
Bundled native libraries are not separately audited.

Both target-specific hash-locked wheel sync plans passed using the installer's
actual index strategy. **169** focused installer/profile tests passed, including
fresh Install, Repair, failed sync/probe and unsupported-target refusal.
These are resolution and fake-process contract checks, not native target installs.

A fresh Apple Silicon CPython **3.11.17** scratch environment installed the same
**52** Windows package versions, substituting the public native Torch **2.14.1**
wheel for the CUDA build, and passed dependency checks. Both actual readiness
pipeline imports, SDNQ registration in Diffusers and Transformers, configuration
round-trip and two tiny CPU-quantized linear layers passed. The maximum absolute
forward error against the unquantized fixture was **0.00374**. Expected missing
optional compiler/OpenVINO backends selected the CPU eager fallback. This is a
compatibility probe, not a CUDA install or model-quality result. No model weights,
provider calls or generation ran. Windows/Linux CUDA execution and production
FLUX.2 inference remain unverified; other profile and major migrations remain
under #15769.

## Twelfth-slice ACE-Step CUDA lyric/cache parity (2026-11-12)

Windows and Linux ACE-Step update **pypinyin 0.53.0 → 0.55.0** and
**FileLock 4.2.6 → 4.2.7**, matching the versions validated in the eighth
Apple Silicon slice. The other **134** Windows and **151** Linux entries retain
their exact versions, markers and hash sets. Torch **2.14.1+cu126**, the Python
**3.11** contract and immutable ACE-Step revision
`1bee4c9f5b43e30995f8d4d33b3919197ce1bd68` are unchanged. The earlier pypinyin
release/API analysis applies to this same pinned tokenizer; dictionary updates
are intentional, not a promise of identical pronunciation for every phrase.

The [CUDA regeneration recipe](./ACESTEP_CUDA.md#regenerating-locks) now uses
SHA-256-verified **uv 0.13.7**, a Torch-only explicit resolution index and cutoff
`2026-11-05T00:00:00Z`, preserving unrelated pins. Generated annotations are
omitted to keep temporary paths out of the locks. Windows has **136 entries /
3,655 hashes** and Linux **153 / 3,750**. Including the shared four-package build
closure, the union has **156 package-version identities / 3,792 hashes**. All
hashes match non-yanked, pre-cutoff PyPI or official PyTorch artifacts. The full
OSV/MAL audit, also querying Torch's public base version, returned zero findings
across **157** complete responses; errors and pagination were checked. Bundled
native libraries were not separately audited.

CUDA Install/Repair now enforces hashes for isolated build dependencies as well
as runtime distributions. The existing universal ACE-Step build lock is shared
with Apple Silicon despite its historical `mlx` filename. Only the already
allowed **docopt** and **unidic-lite** source archives may build. Their isolated
backends must match that complete lock; the pinned ACE-Step checkout still
installs without dependency resolution or build isolation. No build closure was
copied or floated. Fresh uncached builds of both source archives passed; repeating
with an empty allowed-backend set failed because setuptools had no trusted hash.

**169** focused installer/profile tests passed, including both target Install and
Repair paths, shared build/runtime version parity, source-build hash flags,
sync failure without false readiness and unsupported target/index refusal.
Both actual target wheel/source sync plans passed with those exact flags.

A fresh Apple Silicon CPython **3.11.18** scratch environment installed all
**136** Windows package versions, substituting public native Torch **2.14.1**
for the CUDA build. It passed dependency checks and the actual pinned
`ACEStepPipeline` readiness import, lyric tokenizer tone/vocabulary fixtures,
mixed-language segmentation, concurrent Hub fixture downloads and offline cache
reuse. This CPU stand-in establishes dependency/caller compatibility, not native
Windows/Linux CUDA installation or music generation. No model weights, provider
calls or production inference ran.

Three retained ACE-Step pins have specific constraints:

- **py3langid 0.3:** the removed `from_pickled_model` API in 0.4 still requires
  source/model-format adaptation, as demonstrated in the eighth slice.
- **fsspec 2026.7:** [Datasets 5.1.0](https://pypi.org/pypi/datasets/5.1.0/json)
  requires `fsspec[http]>=2023.1.0,<=2026.7.0`.
- **Librosa 0.11:** [Librosa 1.0.0](https://pypi.org/pypi/librosa/1.0.0/json)
  requires Python **3.12+**, so the fixed CUDA Python 3.11 profile needs a
  coordinated interpreter/native-closure migration before that major update.

The remaining profile/API migrations and their concrete constraints are
[enumerated on #15769](https://github.com/atomantic/PortOS/issues/15769#issuecomment-6815367652).
Unperformed native/model execution is a disclosed limit, not a claim of
incompatibility or an independent blanket platform-validation task.

## Thirteenth-slice H3 coordinated web stack (2026-11-12)

The Apple Silicon H3 profile updates **FastAPI 0.141.1 → 0.162.0**,
**Starlette 1.6.0 → 1.10.0**, **Uvicorn 0.52.1 → 0.54.0**,
**Pydantic 2.13.4 → 2.14.2 / Core 2.46.4 → 2.50.2**,
**python-multipart 0.0.32 → 0.0.33**, **Typing-Inspection 0.4.2 → 0.4.4**,
**Click 8.4.2 → 8.5.0** and **Typer 0.27.1 → 0.27.3** together.
FastAPI additionally requires **OpenTelemetry API 1.45.2**; no SDK or exporter
is added. The other **46** package versions, markers and hash sets remain
unchanged. The immutable H3 source, MLX/model libraries, Hub/HTTPX stack,
Python 3.11 floor and CUDA profiles are unchanged.

H3's own source does not call these web APIs. They enter its required closure
through **mlx-vlm 0.6.10**, whose actual `mlx_vlm/server/app.py`, request schemas,
HTTP middleware and transcription parser were inspected and exercised. The
separate optional `mlx_audio.server` requires `webrtcvad`, absent from this
profile; it was neither installed nor stubbed to claim extra server coverage.

Compatibility review covered the versioned release notes:

- [FastAPI](https://github.com/fastapi/fastapi/blob/0.162.0/docs/en/docs/release-notes.md)
  changes omitted/default/null handling, removes deprecated parameter extras
  and adjusts form-model validation. The inspected callers use standard fields,
  `extra="allow"` and explicit/manual boolean defaults. They need no adaptation
  for the exercised requests; this is not a claim that all FastAPI inputs retain
  their old behavior.
- [Starlette](https://github.com/Kludex/starlette/blob/1.10.0/docs/release-notes.md)
  changes form parsing, repeated-field comparison, CORS, streaming cancellation
  and middleware cleanup. Its Python 3.11 floor matches this runtime.
- [Pydantic](https://github.com/pydantic/pydantic/blob/v2.14.2/HISTORY.md) changes
  JSON/alias/extra validation and requires Core 2.50.2 plus Typing-Inspection
  0.4.4. Actual VLM request models, reasoning aliases and serialization passed.
- [python-multipart](https://github.com/Kludex/python-multipart/blob/0.0.33/CHANGELOG.md)
  now requires Python 3.11 and fixes parsing/decoding behavior. The actual VLM
  parser accepted a tiny WAV and repeated timestamp fields with expected defaults.
- [Uvicorn](https://github.com/Kludex/uvicorn/blob/0.54.0/docs/release-notes.md)
  adds optional experimental HTTP/2 support; no new HTTP implementation is
  installed or enabled. The existing HTTP/1.1 h11 path was exercised.

The complete **56-package / 1,227-hash** lock was regenerated with SHA-256-verified
**uv 0.13.7**, wheels only and cutoff `2026-11-05T00:00:00Z`. All hashes match
non-yanked pre-cutoff PyPI artifacts. Complete OSV/MAL responses returned zero
findings, with count, error and pagination checks. Bundled native libraries are
not separately audited. The input remains an exact pin for every resolved package.

Fresh Apple Silicon CPython **3.11.18** and **3.12.11** environments installed the
complete lock and passed dependency checks plus the actual H3 runtime probe with
`--verify-seams`. On both, a real loopback Uvicorn/h11 server hosted the pinned
VLM app with an isolated empty model cache and no preload configuration. Checks
passed for lifespan startup/shutdown, health/model-list/metrics responses,
OpenAPI generation, authentication rejection/acceptance, CORS preflight and the
real server-header middleware. Invalid typed requests were rejected before model
execution. A test-only route used the real VLM Pydantic request type to verify
valid serialization, unknown-field preservation and omitted/default handling.

A test-only route also called the real transcription parser on a synthetic WAV:
repeated fields, false defaults and explicit true flags passed. The actual audio
endpoint rejected missing file/model, malformed multipart and invalid audio.
Streaming fixtures through the real middleware completed background work and
cancelled on disconnect. The same request/parser fixtures also passed against
the previous complete lock on Python 3.11, providing a bounded baseline comparison.
Actual Uvicorn and Hub CLI help paths passed on both updated interpreters.

Telemetry automatic exporter setup is opt-in in the selected FastAPI release.
The VLM app does not opt in; with a clean telemetry environment, the probe verified
that no SDK is installed and API-created spans are non-recording. This adds no
exporter or telemetry destination. **187** focused installer/profile/source-probe
tests passed without weakening the existing source/lock parity checks.

No model weights, provider calls, generation or native model-quality evaluation
ran. Test-only parser/schema/streaming fixtures do not claim full model-serving
behavior. Remaining H3 work includes its MLX audio/language-model libraries,
Hub migration and untouched helper packages; the broader profile/major migration
matrix remains under #15769.

## Fourteenth-slice H3 model-library closure (2026-11-12)

The H3 Apple Silicon profile updates **mlx-audio 0.4.7 → 0.6.4**,
**mlx-lm 0.31.3 → 0.32.2** and **llguidance 1.7.6 → 1.9.1** together.
The other **53** package versions, markers and hash sets are unchanged, with no
new packages. In particular, MLX/MLX-Metal **0.32.4**, mlx-vlm **0.6.10**,
Transformers **5.14.1**, Hub **1.27.0** and the immutable H3 source stay fixed.

The pinned H3 pipeline, audio VAE and text encoder do not directly import these
three libraries. Their relevant callers are in the required mlx-vlm closure:
its text-only model adapter, structured-output logits processor, audio IO and
feature extraction. This is dependency/caller maintenance, not a replacement
of H3's native video/audio architecture.

Compatibility review used the old and new hash-verified wheel sources and
published metadata:

- [mlx-audio 0.6.4](https://pypi.org/pypi/mlx-audio/0.6.4/json) requires the
  already selected MLX 0.32.4 and Transformers with its `chat-template` extra.
  Existing Jinja2/SentencePiece pins satisfy the added core requirements.
  Audio format detection, FFmpeg decoding and model-loading internals changed;
  required read/write, resampling and DSP entry points remain available.
  The extracted whole-array resampler retains its filter math.
- [mlx-lm 0.32.2](https://pypi.org/pypi/mlx-lm/0.32.2/json) raises its Python
  floor to 3.11, matching this runtime. Its MLX/Transformers requirements fit
  the frozen closure. The `_get_classes(config)` entry used by VLM's text-only
  adapter remains compatible.
- [llguidance 1.9.1](https://pypi.org/pypi/llguidance/1.9.1/json) retains the
  Python 3.10 floor and the HF/NumPy integration APIs used by VLM. Its native
  matcher, token-mask and JSON compiler were exercised rather than inferred
  solely from unchanged Python wrappers.

The complete **56-package / 1,229-hash** lock was regenerated using verified
**uv 0.13.7**, wheels only and cutoff `2026-11-05T00:00:00Z`. Every hash matches
an unyanked pre-cutoff PyPI artifact; complete OSV/MAL responses returned zero
findings with error/count/pagination checks. Bundled native libraries are not
separately audited. Exact source-to-lock pin parity remains enforced.

Fresh native Apple Silicon CPython **3.11.18** and **3.12.11** installations
passed dependency checks and the shipped H3 probe with `--verify-seams`.
Real-caller tests on both interpreters covered:

- A tiny random-weight Qwen2 model through VLM's actual mlx-lm adapter: finite
  forward output, cached-versus-full decoding, token embeddings and image-input
  refusal. This uses local synthetic weights, not a downloaded model.
- A locally constructed byte-level tokenizer through VLM's JSON-schema logits
  processor and the real llguidance/Metal mask: allowed and disallowed tokens,
  token consumption, EOS, clone/reset and batch handling.
- WAV path/bytes round trips without input-array mutation; mono rate conversion
  through the actual VLM loader; explicit-axis stereo resampling for NumPy and
  MLX inputs; Ogg Vorbis and M4A path/bytes decoding through installed FFmpeg;
  and real Inkling log-mel feature extraction with unequal-length audio clips.
- The real VLM/Uvicorn loopback app's lifespan, validation, auth/CORS, actual
  multipart WAV parser, streaming completion and disconnect cleanup, repeating
  the thirteenth-slice compatibility probe against the new model closure.

The tiny model, grammar and audio fixtures also passed against the previous
complete lock on Python 3.11. **187** focused installer/profile/source-probe
tests passed without weakening existing assertions.

A deliberately checked stereo case exposed a **pre-existing mlx-vlm 0.6.10
caller defect**, reproduced under both old and new locks: `utils.load_audio`
returns 4,800 samples for a 4,800-frame stereo 48 kHz WAV requested at 16 kHz,
not the expected 1,600. It resamples the channel axis before downmixing.
Explicit `axis=0` works in both mlx-audio versions. H3 generation does not call
this helper, so it is neither a candidate regression nor an H3 render blocker.
The [original reproduction](https://github.com/atomantic/PortOS/issues/15769#issuecomment-6819203959)
remains valid, but final caller inspection found no supported PortOS path
into this helper. H3 borrows VLM text/vision methods and weight sanitization;
the shipped legacy video package borrows Gemma text-model/cache classes,
not its audio loader. This is an upstream-only limitation, not outstanding
PortOS migration work. Reassess it if a future feature adopts the helper;
generic stereo conversion is not claimed correct.

No production weights, provider calls, H3 rendering or quality evaluation ran.
Optional mlx-audio server/model families were not enabled to inflate coverage.
H3's remaining original candidates are its five smaller helper packages and
coordinated Hub/Transformers migration. Music3's separate mlx-audio upgrade and
the other profile/native-major migrations remain under #15769.

## Fifteenth-slice Music3 MLX audio library (2026-11-12)

The Music3 Apple Silicon profile updates **mlx-audio 0.5.0 → 0.6.4**.
Its new core requirements add **Jinja2 3.1.6**, **MarkupSafe 3.0.4** and
**SentencePiece 0.2.2** to the complete lock. All **34** existing companion
versions, markers and hash sets are preserved, including MLX/MLX-Metal
**0.32.4**, Transformers **5.15.0** and Hub **1.28.0**. The profile keeps its
Python **3.12+** floor and changes neither CUDA nor the PortOS sidecar.

[mlx-audio 0.6.4 metadata](https://pypi.org/pypi/mlx-audio/0.6.4/json) requires
MLX 0.32.4, Jinja2, SentencePiece and Transformers with its `chat-template`
extra; the selected closure satisfies these requirements. MarkupSafe is Jinja2's
transitive requirement. The 12 Python files in the MiniMax Music3 model package
are byte-identical between the hash-verified 0.5.0 and 0.6.4 wheels, as is its
music-loader wrapper. Shared loading/registry infrastructure changed, so actual
checkpoint loading and generation were still exercised rather than inferred
from the unchanged model files.

The complete **38-package / 846-hash** lock was regenerated using verified
**uv 0.13.7**, Python 3.12, wheels only and seven-day cutoff
`2026-11-05T00:00:00Z`, retaining the existing output to preserve unrelated pins.
Every hash matches an unyanked pre-cutoff PyPI artifact. Complete OSV/MAL
responses returned zero findings with count/error/pagination checks; bundled
native libraries are not separately audited. The header records the actual
regeneration command instead of retaining the preceding AnyIO/FileLock upgrade
flags. Install/Repair retains hashes, `--no-deps` and wheels-only enforcement.

Fresh native Apple Silicon CPython **3.12.11** and **3.13.18** environments
installed the complete closure with those restrictions and passed dependency
checks. Both passed an offline, real-caller probe:

- A tiny random-weight checkpoint was created by the **old** library, then
  loaded strictly through the new public `mlx_audio.music.load` path. Its config
  and safetensors weights were local synthetic fixtures, not model downloads.
- The actual Music3 model performed two-step generation on Metal with finite
  channels-last stereo output at **44.1 kHz** and coherent result metadata.
  Missing text/lyrics, invalid duration and invalid step count were rejected.
- The unmodified `generate_minimax_music3_mlx.py` executable loaded that same
  checkpoint, generated audio, oriented/resampled it and wrote a real two-channel
  PCM16 **32 kHz WAV**. Its `STAGE` messages and `RESULT` duration/sample rate
  matched the file. A supplied revision also passed through the real local-path
  loader without a Hub request.

The same fixture/probe passed against the previous complete lock on Python
3.12. Tiny architecture dimensions intentionally produce abbreviated waveforms;
these checks prove loading/tensor/sidecar compatibility, not requested-duration
accuracy or production music quality. **172** focused installer/profile/sidecar
tests passed with an explicit NumPy-capable test interpreter, so none of the
three sidecar tests were skipped for a missing prerequisite.

No production weights, provider calls or full-song quality evaluation ran.
Optional speech servers/model families were not installed. Music3's remaining
original migration candidate is Hub **1.28 → 2.4**, which must be coordinated
with the pinned Transformers **5.15** upper bound; H3 helpers, other profiles
and their concrete constraints remain tracked under #15769.

## Sixteenth-slice H3 MLX helpers (2026-11-12)

The H3 Apple Silicon profile updates **MarkupSafe 3.0.3 → 3.0.4**,
**Pycparser 3.0 → 3.12**, **Pygments 2.20.0 → 2.21.0**,
**Regex 2026.7.19 → 2026.9.29** and **SoundDevice 0.5.5 → 0.5.6**.
All **51** companion versions, markers and hash sets remain unchanged. This
preserves Python 3.11+, the immutable H3 source, MLX/Metal 0.32.4,
Transformers 5.14.1, Hub 1.27.0 and the preceding model-library slice.

The immutable H3 source does not directly import these helpers. Their callers
are in its required library closure. Published metadata and hash-verified old
and new wheel sources were inspected: Pycparser's new Python 3.11 floor fits
H3 and CFFI 2.1.1 accepts it. Pycparser adds C11 fixes and optional C23 support;
CFFI still constructs its parser with the default legacy dialect. Regex updates
Unicode tables and native matching internals while retaining the consumed
Python API. Jinja2, Rich and Transformers accept the updated dependencies.
SoundDevice's Python change corrects Windows ARM library selection; its
generated CFFI declarations remain identical. Its macOS native library load
was still exercised, without opening an audio stream.

The complete **56-package / 1,307-hash** lock was regenerated with verified
**uv 0.13.7**, wheels only and seven-day cutoff `2026-11-05T00:00:00Z`.
Every recorded hash matches an unyanked pre-cutoff PyPI artifact. Complete
OSV/MAL responses returned zero findings with count/error/pagination checks;
bundled native libraries are not separately audited. Source-to-lock parity
and Install/Repair's hash and wheels-only restrictions remain unchanged.

Fresh native Apple Silicon CPython **3.11.18** and **3.12.11** environments
installed the complete lock, passed dependency checks and the shipped strict
H3 source-seam probe. Both passed these real-caller checks, also run against
the previous complete lock on Python 3.11:

- Transformers/Jinja chat rendering with Unicode and HTML escaping, JSON
  serialization, assistant-span tracking and sandbox attribute-traversal refusal.
- VLM's Qwen tool parser with multiline Unicode and typed integer, boolean and
  JSON-object arguments, plus malformed-input refusal.
- Rich syntax, Markdown code-fence and syntax-error traceback rendering.
- CFFI declaration parsing for structs, enums and function pointers, an actual
  native callback/libc call and malformed-declaration refusal. SoundDevice uses
  precompiled bindings, so this is a separate Pycparser/CFFI compatibility check,
  not a claim that H3 generation parses C declarations.
- SoundDevice import and native PortAudio version query, without device
  enumeration, playback, recording or stream creation.

The preceding tiny Qwen model/structured-output and audio-IO/DSP caller probes
also passed against both updated interpreters. **187** focused installer,
profile and H3 source-probe tests passed. No production model weights, provider
calls, H3 rendering or quality evaluation ran. The generic VLM stereo-resampling
defect is unchanged; its final upstream-only disposition is recorded in the
fourteenth-slice section. H3's remaining original candidate is the coordinated
Hub/Transformers migration; other profile-specific updates
and concrete upstream constraints remain under #15769.

## Seventeenth-slice FastVideo/Wan video-export helper (2026-11-12)

FastVideo MLX updates **imageio-ffmpeg 0.8.0 → 0.8.1**; Wan 2.2 CUDA updates
**0.7.0 → 0.8.1** on Windows and Linux. Both direct inputs now pin the selected
helper exactly. Every other package version, marker and hash set is preserved:
**84** FastVideo identities, **68** Wan Linux and **50** Wan Windows. The
FastVideo source revision, Python/MLX stack, Wan Torch/CUDA stack and both
profiles' Diffusers/ImageIO versions are unchanged.

Hash-verified old/new helper sources retain byte-identical `_io.py` and
`_utils.py` implementations. Version 0.8.1 corrects Windows binary selection to
follow the interpreter architecture rather than the host CPU. Wan's change is
not merely a Python patch: bundled FFmpeg moves from **7.0.2 on Linux / 7.1 on
Windows x64 to 9.0.2**. Its Linux bundle requires glibc 2.28+ and kernel 4.18+. The glibc floor
is already the profile's documented manylinux_2_28 target and the floor of its
unchanged Torch wheel.
FastVideo's Apple Silicon bundle remains **FFmpeg 9.0**; platform-specific
FFmpeg versions are not interchangeable test claims.

The complete locks were regenerated with verified **uv 0.13.7**, wheels only
and cutoff `2026-11-05T00:00:00Z`, retaining existing outputs to prevent
unrelated upgrades. Wan's documented recipe now scopes the official CUDA index
to Torch/Torchvision; other packages resolve on dated PyPI artifacts instead
of undated CUDA mirrors. Installation keeps its prior indexes and exact hash
restrictions. Temporary-project annotations are omitted from those two locks.

| Lock | Package-version identities | Hashes |
| --- | ---: | ---: |
| FastVideo MLX, universal Python 3.11+ | 85 | 2,305 |
| Wan CUDA Linux, Python 3.11 | 69 | 1,086 |
| Wan CUDA Windows, Python 3.11 | 51 | 989 |

The union contains **111 identities / 2,482 hashes**. All hashes match
unyanked pre-cutoff PyPI or official CUDA-index artifacts. Complete OSV/MAL
responses were clean for **113** queries, including the public base versions
of CUDA-local Torch/Torchvision, with count/error/pagination checks. This is a
package advisory audit, not a separate audit of FFmpeg's bundled libraries.

All complete hash-locked wheel sync plans passed: Wan's two target platforms
and FastVideo on Python 3.11/3.12. Isolated native Apple Silicon export-helper
subclosures, constrained to the full profile's pins, passed dependency checks
and real media subprocess tests:

- Diffusers **0.42.0** (Wan) and **0.42.1** (FastVideo) `export_to_video`, with
  synthetic float and PIL frame inputs, used the wheel's bundled FFmpeg rather
  than an ambient executable. Readback verified H.264, frame count, dimensions,
  frame rate, duration and bounded pixel error.
- FastVideo's ImageIO v3 `libx264` postprocessing path also wrote/read correctly.
- An explicit bundled-executable override worked; a missing executable refused
  rather than silently falling back. Invalid media bytes were rejected.
- Candidate tests covered Python **3.11.18** and FastVideo's distinct NumPy
  branch on **3.12.11**. Both previous helper/profile subclosures passed the
  same fixtures on 3.11. The Mac baseline used FFmpeg **7.1** for helper 0.7;
  candidates used **9.0**, not the unexecuted Windows/Linux 9.0.2 binaries.

**169** focused installer/profile contract tests passed. These are actual native
export tests plus complete target resolution, not full FastVideo/CUDA installations, model generation, GPU execution or production
quality evaluation. No weights, provider calls or device inputs were used.
Other FastVideo/Wan dependencies, coordinated Hub migrations, 3D profile work
and concrete retained constraints remain under #15769.

## Eighteenth-slice 3D Metal network/cache helpers (2026-11-12)

Pixal3D and TRELLIS.2 Metal update **AnyIO 4.14.2 → 4.16.0**,
**fsspec 2026.6.0 → 2026.9.0** and **IDNA 3.16 → 3.20**. Pixal also updates
**charset-normalizer 3.4.7 → 3.5.2**; TRELLIS does not contain that package or
Requests, and this slice does not introduce either. Both need the companion
**Typing-Extensions 4.15.0 → 4.16.0**: AnyIO 4.16 requires it on Python below
3.15, so retaining the old pin makes the Python 3.13 resolve unsatisfiable.

The fixed source revisions, Python 3.13/macOS 26+/Apple Silicon contract,
Torch/native ABI, renderer stack, Hub **1.16.4**, HTTPX **0.28.1**, Requests
**2.34.2** where present, and Pixal's intentional CLI-only Pillow 13 override
are unchanged. Immutable model/pipeline loaders call `hf_hub_download` for
configuration and weights; their API use remains compatible. No model/source
or Gradio migration is hidden in this maintenance slice.

Both complete locks were regenerated online with hash-verified **uv 0.13.7**,
wheels only and cutoff `2026-11-05T00:00:00Z`. TRELLIS's manifest records the
same cutoff. Existing outputs preserve every unaffected version, marker and
hash set: **91** Pixal identities and **52** TRELLIS identities. New helper
releases carry the resolver's complete artifact hashes; the old single-wheel
hashes for unrelated packages are retained, not rewritten by hand.

| Lock | Registry identities | Hashes |
| --- | ---: | ---: |
| Pixal3D MPS | 96 | 271 |
| TRELLIS.2 MPS | 56 | 60 |

The union contains **97 registry identities / 275 hashes**. Every hash matches
an unyanked pre-cutoff PyPI artifact. Fresh OSV/MAL checks returned zero findings
for **120 queries**: all registry identities, **10** distinct source/native
package identities and **13** immutable commits, with count/error/pagination
checks. Source identity queries do not turn vendored code into PyPI installs;
source revisions and archive hashes remain unchanged. This is not a separate
native-library audit or proof of production generation quality.

Complete hash-only, wheels-only installation plans passed for both profiles.
Isolated native Apple Silicon CPython **3.13.18** network subclosures were
constrained to the full profiles: **25 packages** for Pixal and **22** for
TRELLIS. Both candidates and both previous-lock baselines passed dependency
checks and real-caller fixtures:

- Frozen Hub downloads synthetic data from loopback, reuses it offline and
  refuses an offline cache miss. An interrupted body leaves the expected
  incomplete cache; a subsequent call resumes at the exact byte range and
  yields the complete expected payload.
- The real `HfFileSystem` performs read/seek operations through its HTTP
  backend; fsspec's local simple cache also preserves seek/read behavior.
- HTTPX synchronous and asynchronous streams return exact bytes. AnyIO
  cancels a blocked stream, then the same client completes another request.
- IDNA URL handling accepts Unicode hostnames and rejects invalid labels.
  Pixal's Requests path also decodes an undeclared UTF-8 response correctly.

**171** focused installer/profile/adapter tests passed. Each fixture uses an
isolated Hub home/cache, explicit `token=False`, disabled
telemetry/implicit token lookup and synthetic loopback responses. No model
weights, live data, credentials, provider calls or devices are used. Native
renderer setup, Metal builds, full Install/Repair and GLB generation were not
rerun for this network-only slice. The known Pixal Gradio/Pillow metadata
mismatch remains intentional; network-subclosure dependency checks do not
claim that the full Pixal environment has no such mismatch.

## Nineteenth-slice Music3 MLX Hub/Transformers migration (2026-11-12)

Music3's Apple Silicon profile moves **Hugging Face Hub 1.28.0 → 2.4.0**
together with **Transformers 5.15.0 → 5.22.1** and its required
**Tokenizers 0.22.2 → 0.23.3**. The transport changes from HTTPX 0.28.1 /
HTTPCore 1.0.9 / Certifi to **HTTPX2 2.16.0**, **HTTPCore2 2.16.0** and
**Truststore 0.10.5**. No remaining dependency consumes the old transport.
All **32** other versions, markers and hash sets are unchanged, including
mlx-audio **0.6.4**, MLX/Metal **0.32.4** and the Python **3.12+** floor.

The coordinated change is required: the old Transformers pin caps Hub below
2, while 5.22.1 permits Hub 2 and requires Tokenizers `>=0.23.1,<0.24`.
Source review found no PortOS or Music3 adapter change necessary. The shared
mlx-audio loader still calls `snapshot_download` with supported arguments.
Transformers now imports HTTP types through Hub's compatibility alias, which
resolves to HTTPX2 in this closure rather than catching old HTTPX exceptions.
Music3's official text path still loads `AutoTokenizer` locally and requests
NumPy token IDs.

The complete **38-package / 846-hash** lock was regenerated using verified
**uv 0.13.7**, wheels only and cutoff `2026-11-05T00:00:00Z`, retaining the
existing output to preserve unrelated versions. Every hash matches an
unyanked pre-cutoff PyPI artifact. Complete OSV/MAL responses returned zero
findings with count/error/pagination checks. Install/Repair still enforces
hashes, wheels only and `--no-deps`; bundled native libraries are not separately
audited.

Fresh native Apple Silicon Python **3.12.11** and **3.13.18** environments
installed the complete lock and passed dependency checks. An old-lock Python
3.12 environment created a synthetic tiny checkpoint **with a saved local
BPE tokenizer** configured for the `Qwen2Tokenizer` class declared by both
revision-pinned production tokenizer configs. Its vocabulary remains synthetic;
all three environments passed:

- The actual official-tokenizer path, not Music3's tokenizer-less tiny fallback:
  Unicode round trips, exact conditional IDs, unconditional middle-token masking,
  preserved boundary tokens and oversized-prompt refusal through generation.
- Strict checkpoint loading, tiny Metal generation and the unchanged PortOS
  WAV sidecar, including finite stereo output and matching `STAGE`/`RESULT`
  metadata. Tiny dimensions produce abbreviated waveforms; these are loading,
  tokenization and tensor/sidecar checks, not production duration or quality
  validation.
- The actual shared Music3 loader against a synthetic loopback Hub snapshot,
  including revision and file-pattern selection, downloaded synthetic tokenizer
  through the official-text path, and generation. Offline cached snapshots were reused without requests and
  missing snapshots/revisions/files were refused with the correct error types.
- Deliberately interrupted downloads resumed from the exact saved byte offset.
  The new Hub/Transformers path used actual HTTPX2 response/error objects.

Both candidate interpreters additionally exercised the new TLS path. The real
default HTTPX2 factory creates a Truststore SSL context with certificate and
hostname verification enabled. Default-untrusted and wrong-CA loopback TLS
connections were rejected before any HTTP request; loading an ephemeral fixture
CA into the context permitted direct HTTPS and actual Hub HEAD/GET downloads.
No OS trust store was changed and temporary private keys were removed. This
validates synthetic local trust behavior, not live public Hub chains or proxies.

All Hub tests isolated caches, disabled telemetry/implicit tokens and verified
that no Authorization header was sent. **172** focused installer/profile/sidecar
tests passed with the supported NumPy-capable interpreter. No production weights,
provider calls or full-song quality evaluation ran. This completes Music3 MLX's
original dependency candidates; H3's separate coordinated migration and the
other profile-specific work remain under #15769.

## Twentieth-slice H3 MLX Hub/Transformers migration (2026-11-12)

H3's Apple Silicon profile moves **Hugging Face Hub 1.27.0 → 2.4.0** with
**Transformers 5.14.1 → 5.22.1** and required **Tokenizers 0.22.2 → 0.23.3**.
**HTTPX2 2.16.0 / HTTPCore2 2.16.0** replace HTTPX 0.28.1 / HTTPCore 1.0.9,
and **Truststore 0.10.5** supplies the new transport's native trust context.
**Requests 2.34.2 / Certifi 2026.10.23 remain** for mlx-vlm's separate HTTP
consumer. Source and metadata inspection found no remaining runtime consumer
requiring old HTTPX; Starlette's test client prefers HTTPX2.

All **51** companion versions, markers and hash sets are unchanged, including
mlx-vlm **0.6.10**, mlx-lm **0.32.2**, mlx-audio **0.6.4** and MLX/Metal
**0.32.4**. Python **3.11+**, the immutable H3 source revision and the deliberate
absence of Torch/Torchvision are unchanged. The old Transformers pin excludes
Hub 2; the replacement permits it and requires the newer Tokenizers line.
Transformers' Hub HTTP alias now selects HTTPX2 exceptions. No PortOS adapter
change was required.

The complete **57-package / 1,309-hash** lock was regenerated with verified
**uv 0.13.7**, wheels only and cutoff `2026-11-05T00:00:00Z`. Every hash matches
an unyanked pre-cutoff PyPI artifact. Complete OSV/MAL responses returned zero
findings with count/error/pagination checks. Install/Repair retains hash checks,
wheels only and `--no-deps`; bundled native libraries are not separately audited.
Fresh complete native Python **3.11.18** and **3.12.11** candidate installs and
a Python 3.11 old-lock baseline passed dependency checks.

Old/new native comparisons exercised actual callers rather than imports alone:

- H3's local Qwen2 tokenizer and PortOS's PIL-backed image-processor binding
  processed synthetic text and one/two keyframes without Torch/Torchvision.
  Token IDs, modality tags, image grids and pixel bytes matched across versions;
  malformed prompt, image and processor configuration inputs were refused.
  The actual H3 constructor strictly loaded tiny synthetic Qwen3-VL language
  weights and encoded text. Strict source-seam checks passed and the pinned
  source stayed byte-identical. Image coverage is preprocessing/request assembly,
  not vision-model forward or full-video generation.
- Tiny actual VLM text-model forward, cached decoding and embedding adapter
  checks passed, as did structured JSON schema token masks, consumption, EOS,
  reset, clone and batching. Synthetic local vocabulary and random tiny weights
  test API/tensor compatibility, not production checkpoint quality.
- The actual mlx-vlm web app's lifespan, schemas, transcription parser,
  streaming/disconnection and nonrecording telemetry behavior passed with local
  fixtures. Transformers chat-template escaping, assistant spans and sandbox
  refusal, plus the VLM typed Unicode tool parser, remained compatible.
- PortOS's actual cache-only H3 snapshot resolver preserved lexical snapshot
  roots and nested paths, reused cached files without requests, and refused
  missing files with the expected typed cause. H3's upstream runtime loads local
  paths, so revision/pattern filtering, exact-byte interruption/resume and typed
  HTTP-error tests exercised Hub APIs directly, not an invented H3 downloader.

Both candidate interpreters also exercised the default HTTPX2 Truststore
context with certificate/hostname verification enabled. Untrusted and wrong-CA
loopback TLS handshakes failed with certificate-verification errors; an explicit
ephemeral fixture CA permitted HTTPS and actual Hub HEAD/GET downloads. No OS
trust store changed. This proves local fixture trust behavior, not live public
Hub chains or proxy compatibility.

**301** focused installer/profile/runner/cache/source-seam tests passed without
skips. Hub fixtures isolated caches and disabled telemetry/implicit tokens; no
production weights, live providers, camera/audio streams or full-video quality
evaluation were used. Other profile-specific dependency work and retained
compatibility constraints remain under #15769.

## Twenty-first-slice 3D Metal timm/PLY/build maintenance (2026-11-12)

The Pixal3D and TRELLIS.2 Metal profiles advance **timm 1.0.27 → 1.0.31**,
**plyfile 1.1.3 → 1.1.5**, and **Ninja 1.13.0 → 1.13.2**. Both complete locks
were regenerated with hash-verified uv 0.13.7, CPython 3.13/macOS 26+ ARM64,
`--only-binary :all:` and the seven-day cutoff **2026-11-05T00:00:00Z**.
All 93 Pixal and 53 TRELLIS companion versions, markers and hash sets are
unchanged. New versions carry the resolver's complete artifact hash sets:
Pixal has 96 entries/291 hashes; TRELLIS has 56 entries/80 hashes. The union
contains 97 registry identities/295 hashes, all matched to official unyanked
artifacts uploaded before the cutoff. Fresh OSV queries, including MAL,
covered that union, 10 source-package identities and 13 immutable source
commits (120 queries): no matches. Source revisions, source hashes, Torch,
Torchvision, other native renderer/build pins and Pixal's intentional CLI-only
Pillow 13/Gradio metadata override remain unchanged.

The immutable Pixal and TRELLIS Python trees have no direct timm import:
timm remains a retained upstream dependency, not a newly claimed inference
path. Its real CPU ResNet18 classifier, feature extraction, feature-only
backbone and image preprocessing were exercised with synthetic images and
`pretrained=False`. PLY tests execute the actual pinned Pixal and TRELLIS
Apple `o_voxel/io/ply.py` codecs, round-tripping coordinates, byte colors and
float attributes through memory and file paths, and rejecting truncation.
The native sources use Torch `BuildExtension`; Ninja was tested through
Torch 2.15's real `cpp_extension.load` with a tiny synthetic C++ extension:
compile/link/import, repeated load, Ninja no-work detection, and propagation
of an intentional compiler failure. No model weights or external requests
were permitted; caches were temporary and Hub offline/telemetry-disabled.

These are native CPython 3.13.18 **36-package subclosure** tests, not complete
runtime installs. Baseline and candidate passed for both profiles. The
subclosures share 35 identical artifact sets; NumPy 2.2.6 intentionally has
different existing macOS wheel hashes in the profiles, so both were installed
and exercised separately, reusing the two environments. Complete profile
resolution and native wheel installation dry plans passed, as did the five
focused installer/profile/adapter test files (171 tests). Full native renderer
builds, Metal inference, model-backed background removal and GLB rendering
were not run or certified by this maintenance slice. Existing hardware and
native validation requirements remain in force.

## Twenty-second slice: H3, Music3 and Wan CUDA Hub 2 transport

The three CUDA inputs and all six Python 3.11 target locks move
`huggingface-hub` 1.33.0 → 2.4.0. Its required HTTPX2/HTTPCore2 2.16.0 and
Truststore 0.10.5 replace HTTPX 0.28.1/HTTPCore 1.0.9, whose only locked
consumer was Hub. Requests and Certifi remain for Diffusers. Transformers
5.22.1, Tokenizers 0.23.3, Accelerate 1.15.0, Diffusers 0.42.0 (H3/Wan) and
0.42.1 (Music3), all CUDA/native packages, and every companion version,
marker and hash set are unchanged.

Verified uv 0.13.7 regenerated the complete locks with the November 5 UTC
cutoff. Linux/Windows closures contain respectively 66/48 H3, 63/45 Music3
and 70/52 Wan packages. The union contains 74 identities and 1,094 hashes;
all artifacts are unyanked and older than the cutoff. The complete 76-query
OSV/MAL audit includes CUDA-local and public base versions and returned no
findings. H3/Music3 regeneration now scopes official PyTorch indexes as Wan
already does: Torch and applicable Torchvision, plus Linux H3 TorchAO
0.18.0+cu126. Windows TorchAO retains PyPI 0.18.0 and its original two hashes.
Preserved Triton build hashes were verified against official index metadata.
All three documented recipes reproduced all six locks byte-for-byte.
Install/Repair policy is unchanged: six dry-sync plans passed with the
existing hash-constrained `unsafe-best-match` installation flag. That flag
is not used by the new regeneration recipes.

Six isolated native Apple Silicon Python 3.11.18 transport/config environments
used 34-package old and 35-package candidate subclosures. Every subclosure
version and complete artifact hash set is contained in its corresponding
full CUDA lock; fresh hashed installs and dependency checks passed. These
are not full CUDA installations. Both versions exercised:

- The real `hf_download_repo.py` CLI against a synthetic loopback Hub:
  revision-pinned nested downloads, single-file mode without enumeration,
  ignore filtering, progress/completion byte markers, gated/not-found/401
  errors, missing-file and conflicting-option refusal.
- Diffusers' actual inherited `ConfigMixin.load_config` path for a synthetic
  `modular_model_index.json`, revision resolution, component-file download,
  cache-only reads and typed missing-component errors. Both Diffusers and
  Transformers use Hub's exported transport alias, which becomes HTTPX2.
  This does not construct a modular pipeline or load a model.
- H3's actual cached-file resolver preserves nested snapshot paths and
  refuses a missing file without network access. Wan's real entry point
  refuses an uncached revision before importing Torch. An interrupted Hub
  download resumes at the exact retained-byte Range offset.

All three candidates also exercised HTTPX2's actual default Truststore TLS
context: verification and hostname checks remain enabled; an untrusted
certificate and wrong CA fail before HTTP; an ephemeral fixture CA permits
HTTPS and actual Hub HEAD/GET. No OS trust settings were changed, and
fixture private keys were removed. Caches and ambient tokens were isolated,
telemetry disabled, and fixtures rejected Authorization headers. These
synthetic tests do not establish live public-chain or proxy compatibility.

All 221 focused installer/profile/downloader/runner tests passed without
skips, and pregate passed. Independent review and exact-head hosted CI remain
required before merging.
No CUDA binaries, GPU inference, production weights, complete modular
pipeline construction, production media quality or Windows/Linux native
execution is claimed by these transport fixtures.

## Twenty-third-slice LTX and Wan MLX shared-helper refresh (2026-11-12)

LTX-2.3, LTX-2.5 and Wan 2.2 MLX update **AnyIO 4.14.2 → 4.16.0**,
**MarkupSafe 3.0.3 → 3.0.4** and **Regex → 2026.9.29** (from 2026.2.28 in
LTX and 2026.1.15 in Wan). AnyIO requires the companion **Typing-Extensions
4.15.0 → 4.16.0** on Python below 3.15. Both LTX profiles also update
**Click 8.3.1 → 8.5.0 / Typer 0.24.1 → 0.27.3**; Wan already has those pins.
LTX retains its explicit Click companion even though the new Typer no longer
requires that separate distribution.

This is not a model-library, Hub, native backend or source-revision migration.
The three immutable sources and upstream lock digests match
[MLX_VIDEO_LOCKS.md](MLX_VIDEO_LOCKS.md). Real project dependency arrays were
compiled with exact companion constraints, verified **uv 0.13.7**, wheels only
and cutoff `2026-11-05T00:00:00Z`. The documented bounded regeneration recipe
preserves the existing PortOS profiles rather than restoring upstream vulnerable
pins. Unchanged package blocks, including markers and hash sets, are byte-identical.

| Profile | Packages | Hashes | Changed identities | Unchanged companions |
| --- | ---: | ---: | ---: | ---: |
| LTX-2.3 MLX | 36 | 678 | 6 | 30 |
| LTX-2.5 MLX | 36 | 686 | 6 | 30 |
| Wan 2.2 MLX | 51 | 916 | 4 | 47 |

Every hash matches an unyanked pre-cutoff PyPI artifact. Complete OSV/MAL queries
for all **68 distinct package/version pairs** returned zero findings, with
response-count, error and pagination checks. Bundled native libraries were not
separately audited. All six complete baseline/candidate registry locks installed
with hashes, `--no-deps` and wheels only on native Apple Silicon Python **3.11.18**;
exact installed versions and dependency checks passed. Source/build locks were
not changed or rebuilt by this slice.

Meaningful old/new consumer checks passed for all three profiles:

- Actual Hub CLI help and invalid-option refusal exercised its CLI dependency
  stack. The immutable LTX source CLI additionally passed help/refusal and image
  argument parsing without entering inference; its own parser is `argparse`.
- Actual Transformers chat rendering covered Unicode, escaping, assistant masks,
  JSON and sandbox refusal with synthetic vocabulary. Wan's real
  `LanguageTokenizer` wrapper matched Transformers IDs/masks when loaded directly,
  bypassing only its broad root re-export initializer. Transformers Regex-backed
  JSON/XML parsing and a synthetic-vocabulary CTRL tokenizer passed; CTRL is
  installed-package consumer coverage, not a production LTX/Wan tokenizer.
- The actual Hub async client exercised HTTPX/HTTPCore's AnyIO socket transport:
  partial streaming, cancellation of a stalled read, response/peer-socket closure,
  subsequent client reuse and cleanup. The source model-download helpers are
  synchronous, so this is dependency-boundary coverage, not generation coverage.

**299** focused installer/profile/LTX/Wan runner tests passed without skips.
Python source, project metadata and upstream locks remained byte-identical to
all three immutable archives. Fixtures isolated Hub caches and disabled implicit
tokens/telemetry. No production weights, model inference, live providers or
camera/audio streams were used. This establishes helper/API compatibility, not
video/audio quality or a fresh source-build smoke test. Remaining model-library,
Hub and native compatibility constraints stay separate under #15769.

## Twenty-fourth-slice 3D Metal CLI and text helpers (2026-11-12)

Both Metal profiles advance **Click 8.4.1 → 8.5.0**, **MarkupSafe 3.0.3 →
3.0.4**, **Pygments 2.20.0 → 2.21.0** and **Regex 2026.5.9 → 2026.9.29**.
**Typer stays at 0.25.1**: the frozen Hub 1.16.4 requires
`typer>=0.20.0,<0.26.0`, and full resolution rejects Typer 0.27.3. Advancing
Typer requires a separately tested Hub migration, not a metadata override.
No native source revision, renderer pin or Pixal CLI-only Pillow override
changes here. The generator commands use argparse, not Click or Typer; the
latter are exercised through their actual retained Hub CLI consumer.

Both complete locks were regenerated with hash-verified uv 0.13.7, CPython
3.13/macOS 26+ ARM64, binary-only artifacts and seven-day cutoff
**2026-11-05T00:00:00Z**. All 92 Pixal and 52 TRELLIS companion versions,
markers and hash sets remain unchanged. New versions have complete generated
artifact hash sets, including other platforms: Pixal has 96 entries/572
hashes; TRELLIS has 56 entries/361 hashes. The union contains 97 registry
identities/575 hashes. Every hash matches an official unyanked artifact
uploaded before the cutoff. Fresh OSV/MAL queries covered all registry
identities, 10 source-package identities and 13 immutable commits (120
queries), with no matches.

Baseline and candidate native CPython 3.13.18 tests use exact-hash
**35-package subclosures**, not complete runtime installs. Unmodified pinned
Pixal/TRELLIS generator scripts handle help and invalid arguments without
entering inference; Pixal's real parser also accepts synthetic configuration
and a Unicode output name. Frozen Hub CLI help, subcommand help and invalid
option handling exercise Typer/Click. Transformers 5.10.1's actual chat
renderer exercises escaped Unicode, JSON, assistant spans and sandbox
rejection; its Blenderbot tokenizer and Whisper text normalizer exercise
Regex with synthetic Unicode text. Rich syntax, Markdown and traceback
renderers exercise Pygments. These retained-library seams do not imply a
Blenderbot, Whisper or chat-template path in 3D inference. No pretrained
weights, external requests, model inference or devices were used; caches
were temporary, implicit tokens/telemetry/update checks disabled, and network
connections rejected.

Both profile artifact variants were tested separately while reusing two
environments: the baseline differs in NumPy and Regex wheel hashes, and the
candidate differs only in its preserved NumPy hash. Full profile resolution
and wheel installation dry plans passed, as did the five focused
installer/profile/runner test files (171 tests). Full renderer installation,
Metal inference, model-backed background removal and GLB quality remain
outside this bounded helper refresh.

The combined state with the preceding timm/PLY/Ninja maintenance slice was
resolved again: complete regenerated locks were byte-identical, and only
these four helper identities differ from that merged base. A bounded
39-package candidate subclosure includes all three maintenance packages;
both profiles' exact NumPy artifact variants passed the actual helper
probes again, plus real timm CPU model/preprocessing, pinned upstream PLY
roundtrips and Torch/Ninja compile/incremental/failure probes. Candidate
metadata checks passed. Original immutable baseline evidence remains
applicable; the combined candidate's tokenizer, normalization and template
outputs match it exactly. This is still not a complete renderer install.

## Twenty-fifth-slice MuScriptor published API and Hub 2 transport (2026-11-12)

The pinned MuScriptor 0.4.0 runner called `transcribe_to_midi`, which does not
exist in that release. Its published example and implementation use
`transcribe_and_postprocess(audio)`, returning `(midi_bytes, beat_grid)`.
The adapter now unpacks that tuple before the existing empty-output check,
MIDI write and `RESULT` reporting. Model-size loading, stages and shared error
translation are unchanged. Four public CLI regressions cover successful MIDI
bytes rather than the tuple/grid, empty output, transcription failure and
missing-input refusal. The old nonexistent-method call fails the success
contract without loading any production weights.

Both source inputs and all three complete locks move Hub 0.36.2 → 2.4.0,
adding HTTPX2/HTTPCore2 2.16.0 and Truststore 0.10.5. MuScriptor still requires
HTTPX 0.28.1, so its original HTTPCore/Certifi closure remains. Requests,
charset-normalizer and urllib3 had only the old Hub as consumer and are
removed. MuScriptor's immutable downloader uses Hub and stdlib urllib, not
Requests; its model/download modules and Beat This/TorchAudio callers do not
import Requests. All surviving companion versions, markers and hash sets,
including Torch/audio/native dependencies, are unchanged.

Verified uv 0.13.7 regenerated the universal Apple Silicon lock and both
Python 3.11 CUDA target locks with the November 5 UTC cutoff. The MLX lock has
60 version/marker entries; Linux/Windows have 77/58. The complete union has
81 identities and 1,281 artifact hashes, all unyanked and pre-cutoff. The
82-query OSV/MAL audit includes CUDA-local and public base versions and
returned no findings. CUDA resolution scopes only Torch to its official
index; preserved Triton build hashes were verified there too. Documented
recipes reproduce the resolved locks exactly. Both CUDA target dry-sync
plans passed with the unchanged hash-constrained installation policy.

Fresh complete hashed native Apple Silicon environments passed installation
and dependency checks for the old Python 3.11.18 baseline and new Python
3.11.18/3.12.11 candidates. All three exercised the actual pinned
`TranscriptionModel.transcribe_and_postprocess` and MIDI serialization methods
through PortOS's real entry point, with a synthetic note-event iterator in
place of neural inference and beat detection disabled only in the fixture.
They produced identical 83-byte MIDI with a C4 note-on/note-off pair, matching
stage, model-size and result-byte-count contracts. This validates the actual
published tuple API and MIDI writer, not transcription accuracy.

The immutable MuScriptor downloader ran against a synthetic loopback Hub in
all three environments: required model-file and optional companion downloads,
local paths, cache/offline hits and misses, exact interrupted-download Range
resume, gated/not-found/401 errors through `ModelDownloadError` and PortOS's
shared error translator. Real Hub snapshot symlinks and a sparse synthetic
50 MiB blob exercised the cache heuristic without allocating or downloading
model weights. Both candidates passed default Truststore TLS checks:
untrusted/wrong-CA refusals before HTTP and verified HTTPS/Hub access with an
ephemeral fixture CA. No OS trust changes or private keys remain. Caches and
tokens were isolated and fixtures rejected Authorization headers.

All 186 focused CLI/service/installer/profile tests passed without skips.
Independent review, final committed-tree pregate and hosted CI remain merge
requirements. No production weights, neural transcription, beat-detector
inference, GPU/CUDA execution or live public-chain/proxy compatibility is
claimed. The optional beat detector remains unchanged by this migration.

## Twenty-sixth-slice Guard Hub migration and JEV device parity (2026-11-12)

Prompt Guard and JEV advance together from Transformers 5.16.1 and Hub
1.30.0 to Transformers 5.22.1 and Hub 2.4.0. Both canonical adapter pin
lists and the shared input/lock agree. Torch 2.14.1, Tokenizers 0.23.3,
Safetensors 0.8.0, model revisions, thresholds and screening policy are
unchanged. Transformers' actual Hub utility now imports Hub's HTTPX alias;
the exercised classifier/tokenizer/download paths have no independent old
HTTPX consumer. HTTPX/HTTPCore/Certifi are therefore replaced by
HTTPX2/HTTPCore2 2.16.0 and Truststore 0.10.5, not retained as unused
transport dependencies.

The complete universal lock was regenerated with verified uv 0.13.7 and the
November 5 UTC cutoff. Its 56 identities and 718 hashes were checked against
official PyPI metadata: unyanked, released before the cutoff, and no OSV/MAL
findings. All 51 surviving companion entries retain their complete hash sets
and platform markers. Eight hash-constrained dry-sync plans passed for
Python 3.11 and 3.12 on Apple Silicon macOS 14, Linux x86_64/aarch64 with
glibc 2.28, and Windows AMD64. These are the existing Torch wheel minima,
not newly expanded platform support; they are resolution checks, not native
Windows/Linux execution.

Full isolated native Apple Silicon environments installed the old Python
3.11.18 closure and candidate Python 3.11.18/3.12.11 closures with hashes and
passed dependency checks. Identical tiny synthetic saved models exercised
actual Transformers classes, not replacement forward methods:

- DeBERTa-v2 sequence classification and its Unigram tokenizer through the
  real Prompt Guard CLI, including 1,200 tokens across three overlapping
  windows, special-token handling, labels and finite scores. A separate
  constant-benign synthetic fixture exercises the existing Node normalizer's
  acceptance path; it does not change or calibrate the production canary.
- Qwen3.5 sequence classification with both linear and full-attention layers,
  a real Qwen2 byte-level tokenizer, the pinned model's NLI template and
  contradiction/entailment/neutral mapping. Actual JEV scoring, pooled
  hidden states and the loopback HTTP scorer preserve token IDs, output
  shapes, ordering and normalized probabilities. CPU baseline/candidate
  maximum absolute numeric difference was below 1.8e-7.
- Empty/malformed/oversized requests, missing model/weight files, unsupported
  tokenizer format, invalid labels, incomplete chunk coverage and invalid
  scores remain refused. JEV rejects oversized pairs rather than truncating,
  and rejects invalid/missing trained heads. Its plain NLI template is not a
  chat template; the actual tokenizer refuses implicit chat formatting.

This exposed and fixes an existing JEV MPS defect: `load_encoder` moved the
model to MPS, but `score_pairs` left both inputs on CPU. The old runtime
reproduced `Passed CPU tensor to MPS op` with the tiny Qwen3.5 model. Both
inputs now follow the selected device, exactly like `pool_pair`. A public
scorer regression rejects either CPU input when the model selects MPS.
Actual baseline and both candidate native MPS executions then returned
identical scores. No threshold, model or fail-closed policy was changed.

The immutable public JEV config/tokenizer metadata at its existing revision
was inspected. Prompt Guard metadata is gated and returned 401; no
credentials or production weights were used. Its synthetic DeBERTa fixture
therefore verifies the repository-declared architecture/token contract,
not the gated production artifact or real screening quality. Install's
production canary and pinned model files remain unchanged and mandatory.

Both closures also exercised the actual shared `hf_download_repo.py` CLI
against an isolated synthetic Hub: pinned revisions, single-file mode without
enumeration, filtering, UI progress/completion markers, typed gated/401/missing
errors and exact interrupted-download Range resume. Transformers' actual
cached-file path preserves offline cache reads and missing-file refusal.
Both candidates passed default Truststore TLS verification with untrusted
certificate/wrong-CA rejection before HTTP and successful fixture-CA HTTPS.
No OS trust settings changed; temporary private keys were removed. These
fixtures disable telemetry and ambient credentials and do not establish live
provider, public-chain or proxy compatibility.

All 132 focused runner/profile/security-service tests passed without skips.
Independent review, final committed-tree pregate and exact-head hosted CI
remain required before merge. Synthetic models establish API compatibility,
not production screening accuracy or policy calibration.

## Twenty-seventh-slice LTX MLX Hub transport migration (2026-11-12)

LTX-2.3 and LTX-2.5 move **Hugging Face Hub 1.7.1 → 2.4.0** together with
**Transformers 5.17.0 → 5.22.1**. Tokenizers stays **0.23.3**. Hub 2.4 requires
**hf-xet 1.4.2 → 1.6.0**; keeping 1.4.2 makes the solve unsatisfiable. The
transport replaces HTTPX 0.28.1 / HTTPCore 1.0.9 / Certifi with **HTTPX2 2.16.0 /
HTTPCore2 2.16.0 / Truststore 0.10.5**. No remaining selected LTX dependency or
inspected source consumer needs the old transport.

The frozen source revisions, build locks and **30 companion package blocks per
profile** are unchanged, including MLX/Metal **0.31.1 / 0.32.0** and mlx-lm
**0.31.1 / 0.31.3** respectively. **Wan is not migrated**: its immutable MLX-Gen
revision `2452f0c12edcc8886eebf15772205ce9c417a618` explicitly requires
`huggingface-hub>=1.1.6,<2.0`. That source constraint must be addressed separately,
not bypassed by overriding a dependency lock.

Both complete 36-package locks were compiled from the verified source dependency
arrays with exact companion constraints, verified **uv 0.13.7**, wheels only and
cutoff `2026-11-05T00:00:00Z`. LTX-2.3 has **670 hashes** and LTX-2.5 **678**.
All hashes match unyanked pre-cutoff artifacts; complete OSV/MAL responses for
**39 distinct package/version pairs** returned zero findings with count/error/
pagination checks. Unchanged blocks retain their exact markers and hash sets.
All four baseline/candidate native Python **3.11.18** environments installed the
full hashed registry lock and passed dependency checks. Xet's old/new arm64
wheels both support macOS 11+ and Python 3.11; bundled native libraries are not
separately vulnerability-audited.

Real frozen-source comparisons passed without Torch or model-library upgrades:

- Actual Gemma source loading through mlx-lm, tokenizer/left-padding behavior,
  all-layer hidden states, cached model forward and short enhancement generation
  used local synthetic tiny Gemma3/Gemma4 checkpoints. Old/new IDs, masks, hidden
  states and logits matched exactly. The Gemma4 fixture explicitly overrides
  expected test dimensions, then checks architecture refusal; it does not certify
  production dimensions or quality.
- PortOS's oversized-prompt refusal and source-lifecycle digest checks passed;
  source Python hashes remained unchanged. No sampler, audio or video generation
  was tested or changed.
- Actual model and LoRA source resolvers exercised local bypass and remote
  snapshot selection. Empty LoRA repositories were refused. The orchestration
  resolver rejected ambiguous files, while the legacy resolver preserved its
  existing warning/first-file behavior.
- Direct Hub fixtures covered revision/pattern filtering, matching-pattern
  offline cache reuse, misses, exact-byte interruption/resume and typed errors.
  Hub 2 additionally refuses unfiltered offline access to an incomplete filtered
  snapshot; the source resolvers use unfiltered downloads and are unaffected.
- Candidate HTTPX2 defaults used Truststore with certificate/hostname checks.
  Wrong/untrusted local CAs failed verification; an explicitly loaded ephemeral
  fixture CA permitted HTTPS and actual Hub downloads without OS trust changes.

Xet was tested separately from HTTP fallback. Unmodified `hf_hub_download`
entered Hub's Xet path and the actual native Rust extension, reconstructed a
nonempty local CAS fixture through a ranged xorb fetch and produced the exact
23 bytes in all four environments. Old Xet used v1 reconstruction and the new
version used v2. Native CAS refusal propagated without silent HTTP fallback or
a falsely completed cache entry, including the new v2-to-v1 refusal fallback.
These are real native transfer/API tests, not mocked extension calls. Fixture
hash identifiers are synthetic, so this does **not** validate cryptographic
integrity handling. Attempts using a small public documentation image stopped
before transfer because of connectivity failures; no live public CAS/TLS claim
is made. Hub's wrapper accommodates the changed Xet download/session API.

**298** focused installer/profile/LTX runner tests passed without skips. All
fixtures isolated caches and disabled implicit tokens/telemetry; no account
credentials, external uploads, production weights, live providers or device
inputs were used. Full video/audio quality and source-build validation remain
outside this transport slice. The exact regeneration recipe and retained Wan
constraint are recorded in [MLX_VIDEO_LOCKS.md](MLX_VIDEO_LOCKS.md).

## Twenty-eighth-slice Pixal Metal plotting maintenance (2026-11-12)

Pixal alone advances **Matplotlib 3.10.9 → 3.11.2**, **FontTools 4.63.0 →
4.68.0**, **Kiwisolver 1.5.0 → 1.5.1**, **PyParsing 3.3.2 → 3.3.3**, and
**ContourPy 1.3.2 → 1.4.0**. Their published Python/NumPy requirements and
native ARM64 wheels support the existing CPython 3.13/NumPy 2.2.6 profile;
no companion expansion is needed. TRELLIS's source and lock files are
unchanged: these plotting packages are not introduced there. Pandas,
Dateutil, OpenCV, Trimesh, native renderer/source pins and the intentional
Pixal CLI-only Pillow override remain unchanged.

The complete Pixal lock was regenerated with hash-verified uv 0.13.7,
CPython 3.13/macOS 26+ ARM64, binary-only artifacts and the seven-day cutoff
**2026-11-05T00:00:00Z**. All 91 unrelated Pixal identities, markers and
hash sets are preserved. The five new versions carry complete generated
artifact sets, including other platforms: Pixal has 96 entries/898 hashes.
The union with unchanged TRELLIS has 97 registry identities/901 hashes;
every hash matches an official unyanked artifact uploaded before the cutoff.
Fresh OSV/MAL queries include that union, 10 source-package identities and
13 immutable source commits (120 queries): no matches.

Baseline and candidate native CPython 3.13.18 tests use **21-package
exact-hash CPU subclosures**, not full renderer installations. Real Agg
rendering covers Unicode font text, math expressions, legends, constrained
layout, contour labels, PNG and PDF output. Assertions check image size,
nonblank content and text/layout bounds, not version-specific raster
goldens. Analytic circular contours must be closed and stay within 0.002
of the unit radius. FontTools subsets and round-trips Matplotlib's bundled
DejaVu font, preserving the requested Unicode characters.

The immutable Pixal `LinearMemoryController._visualize` helper is executed
with synthetic CPU sample arrays and explicit CPU/memory configuration;
its fitted line and generated plot are checked without entering GPU memory
recording. This is a retained training-debug helper whose automatic call is
commented out upstream, not a claimed live GLB-generation plotting path.
Additional Agg/font/contour tests establish retained-library compatibility.
No GUI, user images/fonts, model weights, live requests, inference, GPU work
or production GLB quality checks run. Test caches and output files are
isolated and temporary; network connections are rejected. Both subclosure
metadata checks, complete profile resolution and native wheel installation
dry plan passed, together with the five focused installer/profile/runner
files (171 tests). Full native rendering requirements remain unchanged.

## Twenty-ninth-slice Pixal Metal retained video-export migration (2026-11-12)

Pixal's retained **imageio-ffmpeg 0.6.0 → 0.8.1** update leaves all other
95 Pixal identities, markers and hash sets unchanged. TRELLIS has no
imageio-ffmpeg entry and is unchanged. No MoviePy dependency is introduced.
The complete Pixal lock was regenerated with hash-verified uv 0.13.7 for
CPython 3.13/macOS 26+ ARM64, binary-only artifacts and the seven-day cutoff
**2026-11-05T00:00:00Z**. The new release's complete generated hash set makes
96 Pixal entries/905 hashes; the union with TRELLIS has 97 registry
identities/908 hashes. All hashes match official unyanked artifacts uploaded
before the cutoff. Fresh OSV/MAL queries cover the union, 10 source-package
identities and 13 immutable commits (120 queries): no matches. Native source
pins and the intentional CLI-only Pillow override remain unchanged.

This is a **bundled native FFmpeg major transition**, not merely a Python
wrapper update. The tested macOS ARM64 binaries report **FFmpeg 7.1 → 9.0**;
both Mach-O deployment floors are macOS 12.0, matching the candidate ARM64
wheel's `macosx_12_0_arm64` tag and remaining below Pixal's macOS 26 floor.
The selected executable was verified to reside inside the installed wheel,
not an ambient system FFmpeg. Python-package OSV results do **not** certify
that bundled FFmpeg or its native codec libraries are vulnerability-free;
these are package/artifact audits and bounded binary compatibility tests.

Inspection of the immutable Pixal Python tree and its hash-verified pinned
utils3d source found no direct ImageIO/MoviePy video-export consumer. Tests
therefore exercise retained **Diffusers 0.38.0** `export_to_video` and
**ImageIO 2.37.3**, not a claimed live Pixal GLB/inference path. Native
CPython 3.13.18 baseline/candidate tests use exact-hash **41-package
subclosures**, not full renderer installs. Eight synthetic RGB frames pass
through real exports from float arrays, PIL images and ImageIO v3, followed
by native decode: eight frames, 8 fps, 64×48 pixels, one-second duration and
mean absolute pixel error below 5 on the 0–255 scale. Both an explicit
bundled executable and automatic bundled selection work. Mismatched frame
sizes, invalid media bytes and a missing executable are rejected; the
failure-path writer is explicitly closed before temporary output cleanup.

Both subclosure metadata checks, complete profile resolution and native
wheel installation dry plan passed, as did five focused installer/profile/
adapter files (171 tests). Tests use temporary caches and synthetic media,
reject network connections and access no weights, live providers or user
media. They do not certify full rendering, model inference, MoviePy or
production GLB quality. Platform changes for other profiles remain separate.

The combined candidate with the preceding Pixal plotting refresh was
regenerated byte-identically, preserving every plotting block and leaving
only imageio-ffmpeg different from that base. A 49-package candidate
subclosure includes both plotting and export consumers. Real export/decode
and failure probes, plus the preceding Agg/font/contour and immutable Pixal
debug-plot probes, passed together on native Python 3.13. The original
baseline remains unchanged; no full renderer installation is implied.

## Thirtieth-slice 3D Metal packaging and installer maintenance (2026-11-12)

Both profiles advance **pip 26.2.2 → 26.3** and **wheel 0.46.2 → 0.48.0**.
Pixal also advances the retained **importlib-metadata 9.0.0 → 10.1.0** and
**zipp 4.1.0 → 4.1.2** backports. Setuptools 84.2.1, Pybind11 3.0.2 where
present, every native source/model pin and Pixal's intentional CLI-only
Pillow override remain unchanged. Wheel's `packaging>=24` requirement is
satisfied by retained Packaging 26.2; no companion expansion is needed.

Both complete locks were regenerated with hash-verified uv 0.13.7,
CPython 3.13/macOS 26+ ARM64, binary-only artifacts and seven-day cutoff
**2026-11-05T00:00:00Z**. All 92 unrelated Pixal and 54 unrelated TRELLIS
identities, markers and hash sets are unchanged. New releases carry complete
generated artifact hashes: Pixal has 96 entries/909 hashes, TRELLIS has
56 entries/363 hashes, and their union has 97 identities/912 hashes.
Every hash matches an official unyanked artifact uploaded before the cutoff.
Fresh OSV/MAL queries cover the union, 10 source-package identities and 13
immutable source commits (120 queries), with no matches. No additional
security claim is inferred from an unverified release-note advisory link.

Native CPython 3.13.18 baseline/candidate tests use exact-hash six-package
subclosures. A synthetic C extension is actually compiled into a wheel with
retained Setuptools, installed with each real installer's isolated/non-isolated
hash/no-dependency/binary-only flags, imported and invoked. Wrong hashes are
rejected. No-isolation source and editable installs, console entry points,
metadata consistency and a missing build-backend refusal are exercised
with `--no-index`, no dependency fallback and temporary fixture sources.
Wheel CLI unpack/pack round-trips are read through `WheelFile` to validate
RECORD hashes. Directory and ZIP metadata/entry-point discovery, Unicode ZIP
reads and scoped recursive/nonrecursive globs exercise the backports.
The four packaging/build identities shared with TRELLIS have identical
artifact sets; the two metadata backports remain Pixal-only.

These are installer/package-tool boundaries, not a fresh build of every
Metal extension. Pip 26.3 changes import handling during installation and
backend-error reporting; those behaviors are why real install/build tests
are required. Importlib-metadata 10 changes provider adaptation/discovery,
but frozen Diffusers 0.38 uses stdlib `importlib.metadata` on Python 3.13:
backport tests are explicitly retained-library coverage, not a claimed
Diffusers backport path. Complete profile resolution and native wheel
installation dry plans passed, together with five focused installer/profile/
adapter files (171 tests). No production runtime, model weights, live
providers, GPU workload or full renderer certification is implied.

The combined candidate preserves the preceding plotting and FFmpeg export
updates exactly. Both full locks were regenerated; only the intended
packaging identities differ from that combined base. A bounded 51-package
candidate subclosure reran the native packaging/install/archive/metadata
probe together with the real synthetic export/decode/failure and Agg/font/
contour/debug-plot probes. All passed with the combined versions; complete
profile plans and the 171 focused tests also passed. Earlier baseline
results remain applicable. These checks still do not certify a full Metal
extension rebuild or production inference.

## Thirty-first-slice FastVideo MLX Hub and tokenizer migration (2026-11-12)

FastVideo MLX advances Hub 1.33.0 to 2.4.0, Transformers 5.15.1 to 5.22.1
and Tokenizers 0.22.2 to 0.23.3. Its immutable source revision
`fa2d1324c60050cd65209c6aaeac470e7fb412f5`, Torch/MLX/AV/native versions,
model choices and installation policy remain unchanged. HTTPX2/HTTPCore2
2.16.0 and Truststore 0.10.5 are added. HTTPX 0.28.1 is now explicit because
FastVideo's independent media-policy and streaming consumers still import
it; its HTTPCore and Certifi dependencies remain. Requests and its companions
also remain required by the immutable source.

This deliberately overrides an upstream compatibility guard, not merely an
old validation pin. FastVideo's immutable `pyproject.toml` caps Tokenizers
below 0.23 because CLIP loading failed when `RobertaProcessing` renamed its
keyword arguments. The verified official Transformers 5.22.1 wheel uses
positional arguments in both its CLIP tokenizer and slow-tokenizer converters;
it requires Tokenizers >=0.23.1,<0.24 and Hub >=1.31,<3. Actual native CLIP
construction, load/save/reload, Unicode offsets, special tokens, padding and
attention-mask probes validate that specific fix with identical results on
the old and candidate stacks. The source metadata itself is not patched.
PortOS continues its existing curated MLX dependency lock and `--no-deps`
editable-source install, rather than claiming the broad upstream dependency
set resolves unchanged.

The complete universal Apple Silicon lock contains 88 package identities and
2,311 hashes. Verified uv 0.13.7 regenerated it with the November 5 UTC
cutoff; all artifacts match official unyanked PyPI releases older than that
cutoff, and the complete OSV/MAL audit returned no findings. Every one of the
82 surviving companion entries retains its version, platform marker and
complete hash set. The documented recipe reproduces the full lock body
byte-for-byte. Full Python 3.11/3.12 macOS 14 arm64 dry-sync plans passed.

Three isolated native environments installed the complete old Python 3.11.18
and candidate Python 3.11.18/3.12.11 locks with hash verification and passed
dependency checks. They loaded identical small synthetic tokenizer assets
and random UMT5 weights, then exercised the actual immutable source:

- FastWan's `encode_prompt` on CPU and MPS, FP32 and BF16, including real
  UMT5 loading, attention masks, zero padding and BF16-to-FP32 transport.
  Baseline/candidate embedding values, CLIP offsets/masks/IDs and H3 Qwen
  token IDs matched exactly. The real child-process encoding path and
  all 13 unchanged upstream prompt-cache/asset-resolution tests passed in
  each environment, including fingerprint mismatch and torn-cache refusal.
- Seven unchanged upstream Qwen3-VL MLX tests: tiny vision forward/deepstack
  parity, mixed image/video RoPE positions, image/video processor geometry,
  visual-token splicing, frame ordering/padding and checkpoint selection.
  Existing numerical tolerances were preserved; no model forward was mocked.
- The actual shared Hub downloader and immutable FastWan asset resolver,
  including selected-asset filtering, explicit-local no-download behavior,
  Transformers cached-file reads, typed errors and exact Range resume.
- Real Diffusers/ImageIO video export and bundled FFmpeg decode of synthetic
  frames, preserving dimensions, frame count, timing and codec; invalid
  executable overrides and invalid media remain refused.

Both candidates additionally exercised HTTPX2's default Truststore TLS
context: untrusted certificates and wrong CAs fail before HTTP, while an
ephemeral fixture CA permits verified HTTPS/Hub access. No OS trust settings
changed. Test caches and tokens were isolated and local Hub fixtures rejected
Authorization headers. No production models, user prompts, live provider
calls, generation-quality calibration or public-chain/proxy compatibility
are claimed. Test-only pytest tooling is separate from runtime environments
and the shipped lock.

All 182 focused PortOS installer/profile/runner tests passed without skips.
Independent review, final committed-tree pregate and exact-head hosted CI
remain required before merge.

## Thirty-second-slice Wan and ACE MLX helper maintenance (2026-11-12)

This slice changes only Wan MLX `charset-normalizer` 3.4.4 → 3.5.2 and
`fonttools` 4.61.1 → 4.68.0, plus ACE-Step 1.5 MLX `anyio` 4.15.1 → 4.16.0.
Requests permits Charset-Normalizer below 4; immutable MLX-Gen requires
FontTools >=4.60.2. ACE already has AnyIO's required Typing-Extensions 4.16.
All Hub, model-library, MLX/Metal, Torch, build and source pins remain unchanged.
Existing Python-marker branches are preserved. Dateutil's major-version change
is deliberately separate.

Regeneration uses verified uv 0.13.7 and cutoff `2026-11-05T00:00:00Z`.
For Wan, use the bounded recipe in [MLX video locks](MLX_VIDEO_LOCKS.md#wan-decoding-and-font-helpers-2026-11-12).
For ACE, copy its direct input and the arm64 macOS `pyproject.toml` environment
configuration from the lock header to a scratch directory. Extract every
existing `name==version` requirement with its marker into a constraints file,
changing only AnyIO to 4.16.0. Run the header's universal Python 3.11 compile
with `-c <constraints>`, the fixed cutoff and a scratch output. Verify the
complete resolved package/version/marker set, then replace only AnyIO's block
in the original lock, retaining its existing `# via httpx2` provenance. This
avoids unrelated constraint annotations and artifact-allowlist churn.

The final Wan lock has 51 package/version entries and 1,021 hashes; 49 companion
blocks are byte-identical. ACE has 112 entries and 2,854 hashes; all 111 other
blocks are byte-identical. Every final artifact matches official PyPI metadata,
is unyanked and predates the cutoff. OSV, including malicious-package records,
is clean for all 130 unique package/version identities. Full dependency-aware,
hash-required wheel install plans pass for Wan Python 3.11 and ACE Python
3.11/3.12/3.13, preserving the supported marker branches.

Four native Python 3.11 baseline/candidate environments install exact hashed
subclosures and pass dependency checks: six packages for Wan and seven for ACE.
Actual Requests responses exercise automatic UTF-8/UTF-16 decoding. FontTools
builds a synthetic font, saves/reloads it and subsets glyphs. Frozen Wan has no
direct FontTools imports, so these are retained-library checks, not a claimed
Wan rendering path. Real HTTPX2/HTTPCore2 transports exercise AnyIO streaming,
cancellation with peer/response closure, reuse after cancellation, truncated
stream `RemoteProtocolError` and cleanup. Frozen ACE source has no direct
HTTPX/AnyIO imports and its model download uses synchronous Hub snapshots;
these are transitive transport checks, not ACE generation validation.

All 170 focused installer, lock-profile and Wan sidecar tests pass. Full heavy
Torch/native environments, production model weights, audio/video generation and
quality were not exercised in this bounded helper update. No provider calls,
ambient credentials or live instance data were used.

## Thirty-third-slice ACE-Step 1.5 and FLUX.3 Dateutil migration (2026-11-12)

This bounded slice changes `python-dateutil` 3.0.0 → 4.0.0 in the ACE-Step 1.5
and FLUX.3 MLX profiles. Matplotlib 3.11.2 permits dateutil >=2.7; version 4
requires Python >=3.11, within both profiles' interpreter bounds. It retains
`tzdata` and no longer requires `six`. Complete resolution removes Six only
from FLUX.3; ACE retains it for PyTorch-Wavelets and corrects its provenance.
All native/model/build/source versions and Python-marker branches stay fixed.

Regenerate with verified uv 0.13.7 and cutoff `2026-11-05T00:00:00Z`. Derive
constraints from every existing lock requirement including markers, changing
only dateutil to 4.0.0. Compile each complete direct input into a scratch lock:
use ACE's universal arm64 macOS configuration and Python 3.11 from its header;
use FLUX's wheel-only Apple Silicon Python 3.12 target. Pass the constraints
with `-c`. Compare the complete resolved version/marker set, replace only the
dateutil block in the existing lock, and retain unrelated hash allowlists.
Remove FLUX Six only after confirming the complete resolver output omits it;
update ACE Six's comment to identify its remaining consumer.

The resulting ACE lock has 112 package/version entries and 2,854 hashes; FLUX
has 56 entries and 1,326 hashes. ACE's 110 other blocks are byte-identical and
Six's pins/hashes are unchanged; FLUX's 55 companion blocks are byte-identical.
All 4,180 hash occurrences match official, unyanked artifacts predating the
cutoff. OSV including malicious-package records is clean across 121 unique
package/version identities. Complete dependency-aware hash-required wheel
plans pass for ACE Python 3.11/3.12/3.13 and FLUX Python 3.12/3.13.

Dateutil 4 removes obsolete Python compatibility internals, uses modern
resource/fold handling and rejects malformed ISO numeric fields more strictly.
Matplotlib's real date consumers use parser, timezone, recurrence and relative
delta APIs; its categorical converter also calls the parser. Neither frozen ACE
nor mflux directly imports dateutil. ACE's source plots numeric training loss;
mflux's concept-attention utility applies the plasma colormap.

Four native baseline/candidate environments install hash-required complete
plotting subclosures: ACE Python 3.11 and FLUX Python 3.12, with their actual
NumPy/ContourPy selections. Dependency checks pass. Real Matplotlib/dateutil
probes cover timezone resources, DST folds/gaps, recurrence ticks and formatting,
valid date parsing, malformed ISO refusal and Agg rendering. Dateutil 4's
stricter refusal of signed/space-containing ISO numeric fields is intentional;
valid-date behavior remains compatible in the tested cases.

The frozen ACE numeric-loss function and mflux plasma-heatmap function also run
via explicitly isolated AST callables. The latter uses NumPy input rather than
MLX; these checks validate the actual plotting statements, not full module
imports, model inference or native device execution. No production weights,
providers, live instance data or audio/image generation quality are involved.
All 176 focused installer, lock-profile and FLUX runtime tests pass.

## Thirty-fourth-slice TRELLIS Metal retained Pybind11 maintenance (2026-11-12)

TRELLIS alone advances **pybind11 3.0.2 → 3.1.0**. Pixal has no standalone
pybind11 pin and is unchanged. Torch 2.15.0, NumPy 2.2.6, all other registry
identities, source revisions and renderer/build settings remain frozen.
This is a 3.0-to-3.1 maintenance update, not the earlier 2-to-3 ABI transition.
Pybind11 3.1's new Python minimum is 3.9, below this profile's CPython 3.13 floor.

Hash-verified immutable mtlmesh, mtlgemm and o-voxel build recipes obtain
headers from Torch's include paths; mtlbvh and mtldiffrast likewise use
Torch's include/library paths in their Setuptools extension recipes. Their bindings include `torch/extension.h`. No installed
pybind11-header consumer was found in these retained native build callers.
Frozen Torch already vendors pybind11 **3.1.0**, with identical header bytes
and include order before and after this change. Updating the separately
installed package therefore does not upgrade those renderer bindings.

Native CPython 3.13.18 baseline/candidate tests install exact-hash 16-package
subclosures. Real CMake modules built against each installed pybind11 release
exercise NumPy 2.2.6 strided-buffer mutation, buffer shape/item size, wrong
dtype and read-only rejection, and C++ exception translation. Strict-mode
numeric conversion is intentionally different: 3.1 accepts integers for
`float` and integers/floats for `complex`, matching upstream's PEP 484 change;
3.0.2 rejects those same inputs. Separate native modules compiled using only
Torch's actual include paths confirm its unchanged 3.1 behavior. CMake's
Apple link command uses `-undefined dynamic_lookup` and produces an importable
module. These are retained-library/build-boundary probes, not full upstream
Metal extension builds, renderer execution or a claim of ABI certification.

The complete TRELLIS lock was regenerated with verified uv 0.13.7 for
CPython 3.13/macOS 26+ ARM64 and cutoff **2026-11-05T00:00:00Z**. All 55
unrelated TRELLIS identities, markers and hash sets remain unchanged; Pixal
is byte-identical. TRELLIS has 56 entries/364 hashes and Pixal 96/909;
the union has 97 registry identities/913 hashes. All hashes match official,
unyanked artifacts predating the cutoff. Fresh OSV/MAL checks cover those
identities, 10 source-package identities and 13 source commits (120 queries),
with no matches. Both complete profile installation dry plans and 171 focused
installer/profile/adapter tests passed. No weights, live providers, GPU
workload, complete runtime installation or production GLB claim is involved.

## Thirty-fifth-slice 3D Metal retained Kornia and image-helper migration (2026-11-12)

Both Metal profiles advance **Kornia 0.8.2 → 0.9.0** and its required
**Kornia-RS 0.1.14 → 0.2.0** companion. Kornia's Python >=3.11,
Torch >=2.5.1 and NumPy >=1.21 requirements fit retained CPython 3.13,
Torch 2.15.0 and NumPy 2.2.6. RS provides a CPython 3.13/macOS 11 ARM64
wheel, below the profiles' macOS 26 floor. OpenCV, all other registry pins,
immutable native/model sources and the intentional Pixal Pillow override
remain unchanged.

A fresh inventory of the immutable Pixal, TRELLIS, MoGe and pinned helper
Python sources found no direct Kornia imports. This is retained-library
maintenance, not a newly claimed application rendering path. Kornia 0.9
changes several numerical conventions and model defaults; RS 0.2 includes
Rust API changes and corrected float-resize sampling. No Rust source API,
model constructor, pretrained download or device path is exercised here.

Native CPython 3.13.18 baseline/candidate CPU probes use exact-hash bounded
subclosures (15 and 14 packages respectively; Kornia no longer needs the
baseline's Packaging dependency in this subset). The profiles retain different
NumPy wheel hashes; the candidate probe is rerun after a complete hash-locked
reinstall using TRELLIS's exact 14-package artifact subset. Other candidate
package blocks are identical between the profiles. Real Kornia identity and
one-pixel-translation warps use explicit pixel coordinates/align-corners;
resize gradients, constant-image Gaussian blur, grayscale and reversible
point transformations satisfy semantic invariants. Bad tensor/channel
shapes are rejected. Real native RS uint8 operations cover identity warp,
resize, RGB/BGR conversion, constant-image interpolation and lossless PNG
round-trip. Kornia's actual RS-backed image loader is exercised in RGB8
and normalized RGB32 modes. Missing files, invalid interpolation and wrong
dtypes are rejected. Legacy top-level RS resize still works but emits its
existing deprecation warning on the invalid-dtype probe in both versions.
These tests do not infer float-RS sampling parity, GPU/MPS performance,
full native runtime installation or production geometry/rendering quality.
Fixtures use synthetic local data and reject network connections.

Both complete locks were regenerated with verified uv 0.13.7, the documented
CPython 3.13/macOS 26+ ARM64 target and **2026-11-05T00:00:00Z** cutoff.
All 94 unrelated Pixal and 54 unrelated TRELLIS identities, markers and hash
sets remain unchanged. Complete generated artifact sets expand the locks to
96 entries/958 hashes and 56 entries/413 hashes respectively; their union
has 97 registry identities/962 hashes. Each hash matches an official unyanked
artifact predating the cutoff. Fresh OSV/MAL checks cover those identities,
10 source-package identities and 13 source commits (120 queries), with no
matches. Both complete profile installation dry plans and the five focused
installer/profile/adapter files (171 tests) passed.

## Thirty-sixth-slice Pixal retained Gradio and web-stack migration (2026-11-12)

Pixal's Apple Silicon CPython 3.13 wheel closure advances Gradio 6.16.0 to
6.31.0 and its exact client 2.5.0 to 2.7.2, FastAPI 0.136.3 to 0.162.0,
Starlette 1.3.1 to 1.10.0, Uvicorn 0.48.0 to 0.54.0, Pydantic 2.13.4 to
2.14.2 with Core 2.50.2 and Typing Inspection 0.4.4, Multipart 0.0.31 to
0.0.33, and Orjson 3.11.9 to 3.13.0. FastAPI's required OpenTelemetry API
1.45.2 is the only added dependency. No telemetry SDK, exporter, service or
configuration is added; its default span is non-recording.

This does not force a Hub/model migration. Gradio 6.31.0 and client 2.7.2
accept Hub >=1.16,<3, so Hub 1.16.4, Transformers 5.10.1, Diffusers 0.38.0
and Typer 0.25.1 stay unchanged. Gradio explicitly caps SafeHTTPX below 0.2
and Tomlkit below 0.15; retain 0.1.7 and 0.14.0 rather than override those
constraints to adopt their newer major/minor lines. All native, model and
immutable source pins remain unchanged, including the separate CUDA lane.

The complete lock was regenerated with verified uv 0.13.7 and cutoff
2026-11-05T00:00:00Z. All 97 identities and 1,166 artifact hashes match
official unyanked PyPI releases older than the cutoff. All 86 surviving
companion versions, markers and complete artifact sets are unchanged. The
111-query OSV/MAL audit covers the registry closure, ten native/source
package identities and four immutable source revisions with no findings.
The documented recipe reproduces the complete lock body byte-for-byte, and
the full macOS 26 arm64/Python 3.13 hash-constrained dry-sync plan passes.

Native Python 3.13.18 baseline/candidate fixtures installed 50/51-package
web subclosures whose versions and entire hash sets are copied exactly from
the corresponding full locks. Both dependency checks report only the existing,
intentional Gradio/Pillow metadata exception. These are not complete Pixal
native installations. Tests execute real Gradio Server, Uvicorn, FastAPI,
Starlette, Pydantic and Gradio Client on loopback, covering:

- Typed JSON/Unicode serialization and malformed/invalid request refusal;
  multipart upload, client file upload/download and queued API responses.
- Generator results through the actual client queue, HTTP event streaming,
  blocked-file refusal and retained SafeHTTPX loopback/SSRF rejection.
- The immutable Pixal `app.py` configuration/progress handlers, including
  missing/malformed progress files, and its unchanged `preprocess` body.
  Only model initialization/inference and the external GPU decorator are
  replaced in this fixture: a deterministic Pillow RGB/resize operation
  stands in for neural preprocessing. Real FileData serialization and
  image open/save run through the actual Gradio client/server boundary.
- Pillow 13 synthetic RGBA-to-RGB image transport and output dimensions,
  retained Tomlkit parsing, and the new API-only tracing default without
  an installed SDK/exporter or recording span.

Fixture analytics and Hub telemetry are disabled; a socket audit rejects
all non-loopback connections. No model weights, user data, live provider
calls or complete neural pipeline were used. This does not enable or endorse
the fork's web demo: PortOS remains CLI-only, and the existing explicit
Pillow 13 override of Gradio's `<13` metadata is unchanged. Broader Gradio UI
or Pixal image-to-GLB compatibility is not established by these fixtures.

The candidate was also prepared on the preceding reviewed packaging,
pybind11 and Kornia/RS slices. All their companion pins and complete artifact
sets remain intact, while every web-upgrade artifact block is identical to
this slice's reviewed candidate. The affected 51-package web subclosure is
unchanged byte-for-byte; a fresh hashed install reran its actual request,
client, file, stream and refusal probes. This validates the combined web
boundary, not a combined native Kornia/model renderer. The complete combined
lock was regenerated and audited again, with its full supported-target plan.

All 34 focused Pixal installer/Repair, service and lock-profile tests passed
without skips. Independent review, final committed-tree pregate and exact-head
hosted CI remain required before merging.

## Thirty-seventh-slice Pixal Metal timezone and date migration (2026-11-12)

This bounded slice updates `python-dateutil` 2.9.0.post0 → 4.0.0 and
`pytz`/`tzdata` 2026.2 → 2026.6. Pandas stays at 2.3.3; the interpreter remains
Python 3.13 and NumPy stays at 2.2.6. Gradio 6.31.0 and its already-reviewed web
closure, native libraries, models and immutable source revisions are unchanged.
Pytz remains required by both Pandas and Gradio. Dateutil 4 requires TZData and
no longer requires Six. Complete metadata resolution plus actual source scans
of frozen Pixal, MoGe, pipeline, utils3d, Gradio/client, Pandas, Matplotlib and
Trimesh found no remaining Six consumer, so that unused companion is removed.

Regeneration uses verified uv 0.13.7, cutoff `2026-11-05T00:00:00Z`, and the
existing macOS 26 / arm64 / Python 3.13 recipe in the lock header. Change only
the three direct pins and remove Six. Compile the complete closure into a scratch
lock, verify the full resulting package set, then replace only those three
package blocks and remove Six from the original lock. Preserve all other
artifact allowlists byte-for-byte. The existing Pillow 13 override is unchanged.

The final wheel lock has 96 distributions and 1,168 hashes; 93 companion blocks
are byte-identical. Every artifact matches official unyanked PyPI metadata and
predates the cutoff. OSV including malicious-package records is clean across
96 registry identities, ten retained source identities and four immutable Git
commits (110 queries). A full dependency-aware hash-required target plan passes
with the existing Pillow override supplied with its own lock hash.

Four native Python 3.13 baseline/candidate environments install exact hashed
plot/data or retained-web subclosures. Plot/data dependency checks pass; the web
checks retain only the previously documented Gradio/Pillow 13 metadata conflict.
Real Matplotlib/Pandas probes cover timezone resources, recurrence, formatting,
DST folds/gaps, explicit ambiguous/nonexistent-time handling, parsing/refusal,
UTC serialization and Agg rendering. Frozen Pixal metadata callables execute in
explicit AST isolation on synthetic CSVs, covering Unicode, missing fields,
indexed merge precedence and round-trip persistence, not model inference.

The larger dateutil 2.9 → 4 transition has an observed correction: both versions
read the identical slim TZif2 America/New_York resource fixture from TZData
2026.6. Version 2.9 reports UTC for July 2026/2045, while version 4 correctly
reports UTC−04:00. Host/default timezone paths are separately exercised; this
is not claimed as blanket timezone parity. Malformed TZif and stricter ISO
numeric-field refusals are also covered.

Actual retained Gradio components exercise DateTime localization/normalization,
finite-date dataframe CSV/JSON, queue grouping and missing-value summaries, and
Matplotlib image serialization with no network connections. For missing dates,
actual Gradio serving uses `model_dump()` followed by its `ORJSONResponse`
renderer; both environments successfully serialize Pandas `NaT` as the string
`"NaT"`. Direct `model_dump_json()` raises `PydanticSerializationError` in both,
but that is not the serving path and does not establish a supported-use defect.
Gradio does not explicitly promise NaT-to-null normalization. Pandas' own
missing-value-to-null JSON also passes. PortOS does not launch the fork's Gradio
UI; browser display and missing-date UI semantics were not tested.

All 34 focused Pixal installer, runtime and lock-profile tests pass. No native
geometry, model weights, generation quality, live instance data or external
provider calls are involved. Pandas 3 remains a separate migration.

## Thirty-eighth-slice Pixal Metal Pandas migration (2026-11-12)

This separate slice updates only Pandas 2.3.3 → 3.1.1. Python 3.13, NumPy 2.2.6,
the reviewed dateutil/Pytz/TZData family, Gradio 6.31.0/client 2.7.2 and every
native/model/source pin remain unchanged. Pandas 3.1.1 permits NumPy >=2.0.2 on
this interpreter. Gradio allows Pandas >=1,<4; Pytz remains installed for its
independent Gradio consumer despite Pandas 3 dropping that base dependency.

Use verified uv 0.13.7, cutoff `2026-11-05T00:00:00Z`, and the existing full
Python 3.13 / arm64 / macOS 26 compilation recipe and Pillow override. Change
only the direct Pandas pin, compile to a scratch lock, verify the complete
resolved package set and replace only the Pandas block in the prior lock.
All 95 companion blocks remain byte-identical. The final 96-distribution wheel
lock has 1,225 hashes. Official artifact/yank/cooldown checks and all 110 OSV/MAL
queries (96 registry identities, ten retained source identities and four Git
commits) are clean. The full dependency-aware hash-required target plan passes
with the unchanged, hashed Pillow override. All 34 focused Pixal installer,
runtime and lock-profile tests pass.

Exact hash-installed native Python 3.13 plot/data and retained-web subclosures
compare against the prior timezone candidate environments without mutating them.
Actual frozen Pixal `StandardDatasetBase` metadata assembly and
`StructuredLatent` filtering run in explicit AST isolation: object/list roots,
base aesthetic-score assignment, first-source precedence, concatenation/indexing,
skip lists, missing-token filtering and Unicode/JSON/CSV records retain the same
instances and statistics. Inferred text changes from `object` to Pandas' `str`
dtype; a standalone Series write no longer mutates its parent under Copy-on-Write.
The exercised source paths need no adaptation. These are metadata tests, not
full training imports, tensor/device execution or model-generation validation.

Actual Gradio tests cover queue grouping/percentiles/missing values, dataframe
CSV/date preprocessing, response JSON, native line-plot dtype detection,
Matplotlib serialization and cache hashing. Copy equality and invalidation on
value/column/index changes pass. Response serialization preserves the verified
`NaT` → `"NaT"` and missing-number → null behavior; unsupported direct Pydantic
JSON helpers are not treated as a serving contract. Copy-on-Write isolation is
also checked with the option explicitly enabled on the baseline and the default
on Pandas 3. The only web dependency-check conflict remains the documented
Gradio/Pillow 13 mismatch; no compatibility workaround or source patch is added.

The date probes explicitly record another intentional API change: Pandas 3
raises built-in `ValueError` for ambiguous/nonexistent `tz_localize` inputs,
rather than Pandas 2's Pytz exception classes. Both versions refuse those inputs;
explicit disambiguation and shift-forward behavior are tested separately.
Frozen Pixal has no `tz_localize` calls or catches for those Pytz exceptions,
so no source adaptation is required for this difference.

## Thirty-ninth-slice coordinated 3D Metal model and Hub transport (2026-11-12)

Pixal3D and TRELLIS.2 advance Hugging Face Hub 1.16.4 to 2.4.0,
Transformers 5.10.1 to 5.22.1, Tokenizers 0.22.2 to 0.23.3 and Typer
0.25.1 to 0.27.3. Pixal also advances Diffusers 0.38.0 to 0.42.1 because
its previous Hub upper bound excludes Hub 2. Both closures add HTTPX2 and
HTTPCore2 2.16.0 with Truststore 0.10.5, and advance native hf-xet 1.5.0
only to Hub's minimum required 1.6.0. Pixal retains independent HTTPX,
HTTPCore, Certifi and Requests consumers. TRELLIS removes its now-orphaned
HTTPX, HTTPCore and Certifi; its installed source/runtime has no independent
consumer of those packages. No source/model revisions, Torch, NumPy,
renderer/native pins or installer behavior change. The explicit Pixal
Pillow 13 CLI-only override remains unchanged.

The complete Pixal lock contains 99 identities and 1,274 hashes; TRELLIS
contains 56 identities and 458 hashes. All 90 and 48 respective surviving
companion versions, markers and complete artifact sets are unchanged.
Every hash maps to an official, unyanked artifact before the November 5
cutoff. The union contains 100 registry identities and 1,278 hashes;
123 OSV/MAL queries covering those identities, ten source-package identities
and thirteen source commits returned no findings. Both documented recipes
reproduce their complete lock bodies and both macOS 26 arm64/Python 3.13
hash-required dry-sync plans pass.

Native Python 3.13.18 tests use exact full-lock artifact blocks in bounded
baseline/candidate subclosures: Pixal 46/47 packages and TRELLIS 40/40.
All four dependency checks pass. These are not full renderer installations.
Offline synthetic fixtures exercise actual installed APIs and immutable
source callers:

- Tiny saved DINOv3 checkpoints through Pixal's actual projected feature
  extractor and projection-grid functions, and TRELLIS's actual extractor
  with its existing pinned Metal patch. CPU/MPS outputs, shapes and refusals
  pass, with zero baseline/candidate numerical difference.
- Actual image preprocessing and FlowEuler sampler bodies with a synthetic
  vector field, plus Pixal's
  real Diffusers AutoencoderKL loading and CPU/MPS encode/decode using a
  tiny shared random checkpoint. Unrelated distributed-training imports
  are excluded when selecting isolated source definitions, not replaced
  DINO or autoencoder forwards.
- Both actual BiRefNet wrapper classes, including the existing TRELLIS
  Metal device patch, load an authored local dynamic segmentation model
  through AutoModelForImageSegmentation. Real normalization, forward,
  sigmoid and alpha compositing produce identical baseline/candidate
  pixels on CPU/MPS; missing model loading refuses. The synthetic one-layer
  model does not validate production BiRefNet remote code or weights.
- Real CLIP tokenizer Unicode, offsets, masks, padding and save/reload
  equality, plus tiny shared-checkpoint CLIPTextModel CPU/MPS numerical
  parity. This is API compatibility evidence, not execution of upstream
  CUDA-only text-training mixins or a claim of Metal text training.
- Actual source model/pipeline loading with synthetic safetensors/configs,
  local cache loading and malformed configuration refusal; the PortOS Hub
  downloader's filtering, progress markers, resume/cache and typed errors.
- Actual old/new native Xet nonempty CAS reconstruction and missing-object
  refusal, without HTTP fallback. The CAS fixture uses synthetic hashes and
  does not establish content-integrity verification. Candidate default Truststore verifies
  a fixture CA and rejects untrusted/wrong-CA TLS. No system trust changes.
- The installed `hf` help/download help/invalid-command boundary and a
  real Typer Unicode command, rather than relying on private CLI types.

A separate 54-package exact candidate web subclosure reruns real Gradio,
FastAPI, Uvicorn and client request/file/queue/stream/refusal probes, including
immutable Pixal configuration/progress/preprocessing handlers with a synthetic
model double. Its dependency check has only the existing Gradio/Pillow
metadata exception. Analytics are disabled and non-loopback sockets refused.
All 195 focused installer, profile, Pixal/TRELLIS service and runner tests
pass without memo skips. No production weights, user data, live providers,
complete image-to-GLB inference or screening-quality claims are involved.
Independent review and final committed-tree pregate are required before
publication; exact-head hosted checks remain required before merging.

The combined candidate retains the reviewed Pandas 3.1.1 and date/timezone
slices exactly. Every model/transport upgrade block remains identical to
this slice's original reviewed candidate; the complete TRELLIS input and
lock are unchanged. Full recipes, supported-target plans and the union audit
were repeated on the combined locks. A fresh 79-package exact-hash Pixal
model/web/plot subclosure exercises their shared imports together, with only
the same documented Gradio/Pillow metadata exception. Actual DINO, VAE,
segmentation and tokenizer outputs exactly match the prior reviewed candidate.
The downloader/cache/error, Gradio request/client/file/stream/refusal and
Pandas/date/plot/source-metadata probes were rerun against the combined
versions. This adds affected-boundary integration evidence, not a full
native renderer claim; unchanged TRELLIS/native-Xet/TLS evidence remains
applicable through exact package/source/artifact equality.

## Fortieth-slice 3D Metal mesh simplification and export migration (2026-11-12)

Both profiles advance **Fast-Simplification 0.1.13 → 0.2.0**, **Trimesh
4.10.1 → 5.2.0** and **NetworkX 3.4.2 → 3.7**. Their Python floors
(3.9, 3.10 and 3.12 respectively) fit CPython 3.13, and the existing NumPy
2.2.6/SciPy 1.15.3 artifacts remain compatible. TRELLIS's already-present
NetworkX dependency is now explicit in its source recipe to select this
bounded upgrade. No additional package, native source change or application
API adaptation is needed. Torch, model/source pins, Pillow override and
OpenCV remain unchanged.

Official release notes and hash-verified candidate source show that
Fast-Simplification moves its native bindings from Cython to nanobind while
preserving the positional reduction-ratio and keyword target-count APIs
used here. Fresh immutable source inspection identifies actual Pixal mesh
helpers, TRELLIS/o-voxel material construction and the PortOS
`trellis2GenerateRunner.py` interception seam; these are not import-only or
merely retained-library tests.

Native CPython 3.13.18 baseline/candidate probes use six-package hashed CPU
subclosures. They execute the exact immutable Pixal simplification, hole
repair, Taubin/Laplacian/Humphrey smoothing and geometry-only export helpers
with synthetic geometry. A 320-face sphere decimates to 160 faces with
valid indices, bounded geometry, watertightness and Euler characteristic
preserved; invalid targets are refused and under-target inputs remain
unchanged. Missing-face repair restores closure. NetworkX-backed Trimesh
connectivity identifies connected and disconnected components. An offset
mesh's reflected export checks actual transformed bounds, positive volume
and winding after GLB reload, rather than relying on symmetric geometry.

The exact immutable o-voxel material/coordinate-conversion/construction
statements receive synthetic pre-baked arrays. Real GLB export/reload
preserves vertices, UVs, RGBA texture pixels, metallic/roughness channel
packing, alpha mode and double-sided material state. This deliberately
excludes rasterization, tensor extraction, UV unwrapping and texture baking.
The actual PortOS runner wraps the real native simplifier: its requested
face target overrides the incoming ratio, the below-target path is a no-op,
and its exporter target forwarding is checked against a capturing baker
stub. The stub is not Metal export coverage. No model weights, live data,
network access, GPU work or production GLB-quality certification is claimed.

Both profile variants pass: candidate probes are repeated after reinstalling
TRELLIS's exact hash subset because its retained NumPy and SciPy artifact
hashes differ from Pixal's. Complete profile installation dry plans pass.
Six focused installer/profile/adapter/runner files pass (195 tests).
Both complete locks are regenerated with verified uv 0.13.7, the documented
CPython 3.13/macOS 26+ ARM64 target and **2026-11-05T00:00:00Z** cutoff.
All 96 unrelated Pixal and 53 unrelated TRELLIS identities, markers and hash
sets remain unchanged. Pixal has 99 entries/1301 hashes and TRELLIS 56/485;
the union has 100 registry identities/1305 hashes. Every hash matches an
official unyanked artifact predating the cutoff. Fresh OSV/MAL queries cover
that union, 10 source-package identities and 13 source commits (123 queries),
with no matches. These checks are bounded mesh/export compatibility evidence,
not a full native renderer installation or inference run.

The serial combined candidate preserves the preceding web, timezone, Pandas
and model/Hub changes. Complete locks were regenerated against that base;
only the three mesh-library identities differ. Both exact six-package native
artifact variants reran the immutable mesh/material and PortOS wrapper probes
successfully. The original baseline remains applicable; this is not a full
model/runtime installation or a rerun of model inference.

## Forty-first-slice 3D Metal OpenCV image-operation migration (2026-11-12)

Both profiles advance **opencv-python-headless 4.13.0.92 → 5.0.0.93**;
Pixal's existing **opencv-python** distribution advances to the same version.
No other dependency, native/model source, NumPy/Torch pin or Pillow override
changes. The official macOS 13 ARM64 abi3 wheels support the CPython 3.13/
macOS 26 target and retained NumPy 2.2.6. The official 4-to-5 migration guide
was checked against actual immutable image consumers before testing.

Pixal retains its pre-existing pair of distributions sharing the `cv2`
namespace; this is not a recommendation to mix arbitrary OpenCV wheels.
Using the actual pinned pip 26.3 and installer hash/no-dependency/binary-only
flags, fresh baseline/candidate pair installs and a real 4-to-5 in-place
upgrade install headless first, then opencv-python. In all three cases the
loaded native binary hash matches the verified non-headless wheel. Separate
TRELLIS baseline/candidate installs use its isolated/force-reinstall flags,
exact NumPy artifact and headless-only OpenCV distribution; the loaded binary
matches the verified headless wheel. Both official ARM headless binaries also
report `GUI: COCOA`, so that build-info label is not used to infer which wheel
loaded. No GUI is invoked. These observations establish this pinned install
path, not a general guarantee for arbitrary overwrite/uninstall ordering.

Native CPython 3.13.18 probes use bounded hashed NumPy/Pillow/pip/OpenCV
subclosures and real libraries. They execute the exact immutable Pixal EXR
read/BGR-to-RGB expression, text helpers, Pixal and TRELLIS pre-material
inpainting statements, and MoGe's dense-input perspective-warp helper.
Synthetic float EXR data includes negative and HDR values; EXR is enabled
before import as in the upstream app. PNG file/memory round-trips preserve
pixels. Inpainting checks shape/range and constant-color behavior; text
rasterization is nonblank. Identity/pixel-translation warps, color conversion,
invalid image/channel/mask/size and corrupt decode paths are exercised.
All probes pass for fresh paired, upgraded paired and isolated headless
baseline/candidate states. No weights, live data, renderer inference,
rasterizer/texture baking or production output quality is claimed.

One migration-note discrepancy is retained explicitly: the guide says
`INTER_NEAREST` becomes equivalent to Pillow/`INTER_NEAREST_EXACT`, but both
verified 4.13 and 5.0 ARM variants still produce the legacy floor-grid
sampling on a 3×5-to-7×8 label fixture. The probe checks that analytical grid;
`INTER_NEAREST_EXACT` separately agrees with Pillow. No golden output or
pinned source interpolation flag is changed to hide this observation. Warp
checks use semantic invariants/tolerance rather than promising pixel-exact
parity for every fractional transform.

Both complete locks were regenerated with verified uv 0.13.7 and cutoff
**2026-11-05T00:00:00Z** for CPython 3.13/macOS 26+ ARM64. All 97 unrelated
Pixal and 55 unrelated TRELLIS identities, markers and hash sets are preserved.
Pixal has 99 entries/1317 hashes and TRELLIS 56/493; their union has 100 registry
identities/1321 hashes. Every hash matches an official unyanked artifact older
than the cutoff. Fresh OSV/MAL queries cover the union, 10 source-package
identities and 13 source commits (123 queries), with no matches; this is not
a separate security certification of every bundled native codec. Both full
profile installation dry plans and 171 focused installer/profile/adapter
tests pass. No application API adaptation or companion expansion was needed
for the exercised boundaries.

The serial combined candidate preserves preceding web/date/Pandas/model and
geometry changes. Complete locks were regenerated with only the intended
OpenCV identities differing from that base. Fresh actual pip paired and
isolated headless installs reran the native binary-ownership and immutable
caller probes from the combined locks, using each profile's exact NumPy
artifact. Historical baseline/upgrade evidence remains applicable because
the installer, pip version and OpenCV inputs are unchanged. This does not
claim a full model or renderer installation.

## Forty-second-slice 3D Metal retained OpenGL helper migration (2026-11-12)

Both profiles advance **ModernGL 5.12.0 → 5.13.0** and **Glcontext
3.0.0 → 3.1.0**, retaining NumPy 2.2.6, Torch and every native/model/source
revision. TRELLIS's already-present Glcontext dependency is made explicit
in the source recipe to select this bounded update; no new dependency or
immutable-source patch is introduced.

Reachability was checked before interpreting optional-helper failures.
PortOS launches Pixal's pinned `generate_mps.py` and TRELLIS's `generate.py`
through its runner. Their export routes use native o-voxel/mtldiffrast Metal
or existing geometry/KDTree/xatlas fallbacks, not utils3d's NumPy OpenGL
rasterizer. A full pinned-tree reference scan found these GL helper calls
only within utils3d's own dispatch exports and tests. This update therefore
has retained-library native coverage, not a claim that the generation CLI
uses an EGL renderer or that its Metal baking quality has been certified.

Native CPython 3.13.18 baseline/candidate probes use exact-hash three-package
subclosures and real macOS standalone OpenGL 4.1 contexts. Three independent
create/render/read/release cycles compile GLSL330 shaders, rasterize overlapping
triangles and verify depth occlusion, center depth 0.25, color and coverage.
A real sampled 2×2 texture produces the expected four color quadrants on
readback. Invalid shader source and an unknown backend are refused. The
actual immutable TRELLIS utils3d GLSL330 raster and texture helpers also run,
with explicit transform, checking interpolated attributes, depth and texture
pixels. Candidate tests are repeated after reinstalling TRELLIS's distinct
retained NumPy artifact. No mock context, software-only substitute or shader
version rewrite stands in for the native tests.

Two unchanged optional-path negative cases remain explicit:

- Pixal's utils3d revision `3fab839f0be9931dac7c8488eb0e1600c236e183`
  embeds GLSL430 shaders. Actual raster invocation fails with `version '430'
  is not supported` on the native GL4.1 context in both baseline and candidate.
- TRELLIS's utils3d revision `9a4eb15e4021b67b12c460c7057d642626897ec8`
  has `np.eye(4, np.float32)` in its omitted-transform branch. That branch
  raises `TypeError` in both states; the supported explicit-transform argument
  works, and its internal depth-warp caller already supplies that argument.

Neither case was found reachable from the supported frozen PortOS generation
CLI, and neither demonstrates a regression from this package update. They
are not relabeled as passing, patched in immutable sources or turned into a
generic platform-validation task. GLSL430 support, full renderer installation,
model inference and production output quality are expressly outside this proof.
All fixture geometry/textures are synthetic and network connections are rejected.

Complete locks were regenerated with verified uv 0.13.7 for CPython 3.13/
macOS 26+ ARM64 and cutoff **2026-11-05T00:00:00Z**. All 97 unrelated Pixal
and 54 unrelated TRELLIS identities, markers and hash sets remain unchanged.
Complete generated artifact sets produce 99 entries/1407 hashes for Pixal,
56/583 for TRELLIS and 100 registry identities/1411 hashes in their union.
Each hash matches an official unyanked artifact predating the cutoff. Fresh
OSV/MAL checks cover the union, 10 source-package identities and 13 immutable
source commits (123 queries), with no matches. Both full profile installation
dry plans and 171 focused installer/profile/adapter tests pass.

The serial combined candidate retains preceding web/date/Pandas/model,
geometry and OpenCV updates. Complete locks were regenerated with only the
GL helper pair differing from that base. Both exact three-package artifact
variants reran real native context/raster/depth/texture/lifecycle probes and
the unchanged optional negative cases. Historical baseline evidence remains
applicable; no broader renderer or model installation is inferred.


## Final original-audit reconciliation and managed-profile audit

The final serial candidate accounts for every original #15769 audit row:
unconstrained candidates have been updated, while the following older pins
retain specific source, API or interpreter constraints. This covers Reactor,
audio/lyric/classifier profiles, MLX and CUDA media runtimes, both 3D lanes,
and their retained web, rendering, packaging and build dependencies. Earlier
slice-specific statements of remaining work are historical. This reconciliation
does not claim that queued pull requests have merged or that #15769 is closed.

- NetworkX 3.7, ContourPy 1.4, PyAV 19 and Librosa 1 require Python 3.12+.
  Fixed Python 3.11 profiles retain compatible versions; existing universal
  locks already select newer versions on their eligible Python branches.
- ACE-Step revision `1bee4c9f5b43e30995f8d4d33b3919197ce1bd68` explicitly pins
  Librosa 0.11 in its `requirements.txt`, read by `setup.py`. Its retained
  py3langid 0.3 is additionally required by `from_pickled_model`, removed in
  0.4. These need source/API migrations, not a blind pin override.
- ACE-Step and shared mflux-video retain fsspec 2026.7 because datasets 5.1
  requires `fsspec[http]<=2026.7.0`. SymPy 1.14 requires `mpmath<1.4` in the
  affected Torch/model closures.
- mflux 0.24 (including FLUX.3 and shared video), the frozen Laya source and
  Wan MLX's frozen MLX-Gen source require Hub below 2. MTPLX 2.12.2 requires
  MLX 0.32.2, `mlx-lm<0.32` and `transformers<5.17`; the latter retains Hub 1.
- LTX MLX's candidate mlx-lm 0.32.2 requires MLX at least 0.32.2, beyond the
  frozen LTX-2.3/2.5 baselines of 0.31.1/0.32.0. LTX CUDA's frozen source
  requires Transformers below 5.15 and `uv-build>=0.9.8,<0.10`, retaining
  Hub 1 and uv-build 0.9.30. MLX-Gen requires `uv-build>=0.7.19,<0.8`;
  the LTX workspace README also retains the documented Hatchling `<1.32` cap.
- Pixal's refreshed Gradio requires `safehttpx<0.2` and `tomlkit<0.15`, so
  0.1.7 and 0.14 remain. Its CLI-only Pillow 13 override remains intentional;
  the refreshed Gradio still declares Pillow below 13.

The final read-only managed-profile audit uses main
`5946f8d4bcef61c8f88ce301079d4167d1ffa62a` plus **only the two final Pixal/TRELLIS
Metal locks** from `e062f2c8f0ed4901367be48b182b632d3407a91a`. It does not audit
that older branch base as a substitute for current main. Across **53 locks**,
**369 registry identities** and **6,635 registry artifact hashes**, registry
hash/yank checks passed. **476 OSV/MAL queries** returned no findings or
pagination tokens: 396 PyPI identities, 47 Conda/bootstrap artifacts, 31 source
commits and two supplemental model revisions. Official hash/date/channel
checks verified all **47 Conda/bootstrap artifacts**. All **24 source archive
hashes**, plus the separately pinned direct utils3d wheel, were verified.

Two pre-existing cooldown exceptions remain explicit rather than hidden by
that clean advisory result:

- LTX CUDA `cuda-bindings==13.5.0`, retained from #15454, has 28 artifacts
  newer than the fixed `2026-11-05T00:00:00Z` cutoff. All reached seven elapsed
  days by **2026-11-12T12:06:49.872494Z**; this does not satisfy the older
  fixed midnight cutoff.
- TRELLIS Metal's `trellis2-apple` revision
  `c873bde81ebe1e56535c6caddb4b21267364a923`, retained from the autorelease-pool
  leak repair in #15708, has commit date **2026-11-09T16:25:19Z** and reaches
  seven days on **2026-11-16T16:25:19Z**. Preserve the repair and disclose its
  exception; do not claim that every source satisfies the registry cutoff.

OSV's Conda/source coverage is incomplete, and commit dates are not release
signatures or provenance guarantees. These checks are not exhaustive security
certification. The final audit did not download or validate model weights or
repeat full GPU/runtime execution; prior bounded native tests keep their stated
limits. Node/npm, container/OS images, system toolchains and live advisory alerts
are outside this managed Python/native-profile pass. Unmanaged installation
workflows require their separate reconciliation; this audit does not certify them.


## Cooled patch follow-on after the staged refresh (2026-11-12, #15910)

This bounded follow-on updates Filelock to **4.2.9** in FastVideo MLX
(previously 4.2.1), MiniMax H3 MLX, ACE-Step CUDA and Pixal Metal
(previously 4.2.7), and Typing-Inspection **0.4.4 → 0.4.5** where present.
Shared mflux-video separately advances **mlx-vlm 0.7.11 → 0.7.12** and the
two transitive patch dependencies. Both ACE-Step CUDA target locks are included.
Other profiles retain their existing resolutions; they were included in the
complete-lock advisory screen below rather than silently refreshed.

Upstream evidence and inspected consumers:

- [Filelock changelog](https://github.com/tox-dev/filelock/blob/4.2.9/docs/changelog.rst):
  the intervening releases include lock protocol/lease fixes, read/write lock
  argument validation and descriptor-lock documentation. The real Hub 2.4.0
  cache caller uses ordinary `FileLock`, its timeout/release API and a
  `SoftFileLock` fallback, not a mixed-version read/write or lease protocol.
  Filelock remains dependency-free and requires Python 3.11+.
- [Typing-Inspection 0.4.5](https://github.com/pydantic/typing-inspection/releases/tag/v0.4.5)
  optimizes literal inspection and expands chained type aliases. Hash-verified
  wheel source confirms that bounded change; its Typing-Extensions floor stays
  4.15, satisfied by retained 4.16. Real Pydantic model validation, JSON
  round-tripping, literal schema enumeration and invalid-literal refusal pass.
  A chained alias rejected by 0.4.4 expands correctly under 0.4.5.
- [MLX-VLM 0.7.12](https://github.com/Neywa-Labs/mlx-vlm/releases/tag/v0.7.12)
  includes generation, cache and additional-model fixes. Wheel metadata leaves
  the complete dependency requirements unchanged, including MLX >=0.32.4.
  The locked `mlx-video-with-audio==0.1.37` LTX text encoder imports
  `Gemma3Model`, `TextConfig`, `KVCache` and `RotatingKVCache`. The Gemma3
  module files are identical across these patches; shared base/cache changes
  were inspected and exercised below. PortOS does not start the upstream VLM
  HTTP server. MiniMax's separate 0.6.10 PIL/no-Torch processor contract stays
  unchanged; this patch is not that minor migration.

All six complete locks were regenerated, never patched by hand, with a private
uv **0.13.7** bootstrapped using `requirements-uv-bootstrap.lock.txt` and
**2026-11-05T00:00:00Z** cutoff. Existing output locks retain unrelated
resolutions; targeted `--upgrade-package` arguments select the two transitive
patches. Universal ARM macOS locks use the temporary project's environment
restriction as documented (do not add `--no-config` to that invocation).
This host required a temporary loopback CONNECT relay to the official PyPI and
PyTorch hosts because uv's direct connections failed; TLS/artifact verification
and the cutoff remained enabled. No installer or machine configuration changed.

A parsed before/after comparison confirms that every unrelated identity,
Python/platform marker and artifact hash set is unchanged. In particular,
Pydantic **2.14.2 / pydantic-core 2.50.2**, native Torch/CUDA, Pixal NumPy
**2.2.6**, source revisions and shared mflux/MLX/Pillow direct-pin parity remain
intact. The affected union contains **240 identities / 5,044 hashes**. Every
registry hash matches an official non-yanked artifact older than the cutoff;
retained CUDA Torch and Triton hashes match the official PyTorch index and its
upload dates. New candidate wheels were downloaded and SHA-256 verified before
source inspection. Fresh OSV/MAL querybatch screening reports no matches or
pagination tokens for all **240 affected identities** and, separately, all
**370 identities across 53 complete locks**. Advisory coverage is not a security
certification of native code or model assets.

Bounded validation on native Apple Silicon, CPython **3.13.18**:

- Exact-hash ten-package baseline/candidate subclosures use real MLX 0.32.4,
  its Metal library, NumPy, Pillow, Filelock, Typing-Inspection and Pydantic.
  The inspected Hub `WeakFileLock` definition executes against synthetic cache
  paths: acquisition, subprocess exclusion/timeout, release/reacquisition and
  immediate timeout refusal pass for Filelock 4.2.1, 4.2.7 and 4.2.9.
- The actual shared-video `LanguageModel` class constructs the actual MLX-VLM
  Gemma3 model from a tiny random configuration. Native forward/hidden states,
  attention-mask handling, mixed rotating/full cache prefill and a
  subsequent token pass for both versions. Candidate hidden-state arrays
  exactly equal the seeded baseline. This loads the real Gemma/base/cache
  modules while bypassing unrelated package initializer exports; it is not a
  full-package import or production checkpoint-loading claim. Hub and encoder
  definitions are isolated from their hash-verified wheels; no tensor/model
  implementation is mocked.
- Installer/Repair routing, setup shell contracts, FastVideo and LTX runners,
  MiniMax runtime probes and Pixal adapter tests pass: **7 files / 357 tests**.
  No adapter pin copies require changes: those callers consume the affected
  source/complete-lock contracts. Full supported-target installation dry plans
  validate selection separately; they are not CUDA execution evidence.

No model weights, user records, provider calls, full native runtime installation,
video inference, model-quality evaluation or Windows/Linux CUDA hardware run is
included. Existing explicit ABI/interpreter/source constraints are preserved.

## Newly cooled follow-on (2026-11-13, #15988)

This refresh advances **SentencePiece 0.2.2 → 0.2.3** in the twelve direct
MLX/CUDA source recipes that pinned 0.2.2 and their seventeen complete locks;
**Reactor SDK 1.13.0 → 1.14.0** in its source/lock; and the inseparable
**Pydantic 2.14.2 / Core 2.50.2 → 2.14.3 / 2.50.4** pair in MiniMax H3 MLX
and Pixal Metal. Transitive-only SentencePiece/Pydantic entries in other
profiles retain their existing resolutions. No native/model source, interpreter,
Torch/CUDA/MLX pin, platform marker or unrelated artifact allowlist changes.

Source/API review:

- [SentencePiece 0.2.3](https://github.com/google/sentencepiece/releases/tag/v0.2.3)
  adds an independent Lite/FlatBuffers runtime and training algorithms; these
  profiles continue loading existing Protobuf models through the full processor.
  Python now requires 3.10+, within the affected profiles' 3.11+ floors. Its
  wrapper preserves encode options when pickled, accepts legacy model-only
  pickle state, and repairs empty-batch decoding and normalizer flags. The
  retained Transformers 5.22.1 SentencePiece conversion/backend code was
  inspected; no switch to Lite or retraining of user tokenizers is introduced.
- [Reactor 1.14.0 changelog](https://github.com/reactor-team/reactor-client-sdks/blob/python-v1.14.0/sdks/python/CHANGELOG.md)
  moves reactor-webrtc 0.24.2 → 0.26.0 on the same libwebrtc revision, raises
  the default data-channel message ceiling, and fixes reconnect/stepped-frame
  handling. The inspected wheel preserves the streamed constructor/JWT,
  callback/track, command, upload and disconnect APIs used by
  `scripts/reactor-render.py`. Its ctypes ABI declarations are unchanged and
  the native Apple Silicon library loads and passes its ABI check. There are
  still seven wheels and no default runtime dependencies; the audio-device
  extra remains absent. No provider connection or paid call was made.
- [Pydantic 2.14.3](https://github.com/pydantic/pydantic/releases/tag/v2.14.3)
  requires exactly Core 2.50.4. The release includes schema/serialization
  optimizations, GC fixes and validation/copy fixes. Inspected Gradio 6.31.0
  `Model3D` uses `FileData`; image/prediction data models and MLX-VLM 0.6.10's
  retained request schemas use the same BaseModel/Field/validator interfaces.
  No application API adaptation is needed by the exercised contracts. H3's
  generation runner does not start the optional VLM HTTP server.

All nineteen complete closures were resolved with a fresh **hash-verified uv
0.13.7** and **2026-11-06T00:00:00Z** cutoff. Extract each existing
`name==version` requirement with its marker into scratch constraints, substituting
only the selected versions; use the target/header commands and arm64 macOS
universal environment restrictions already documented above. Check the entire
resolved package/version/marker set before transferring the newly generated
changed-package blocks into the original lock. Preserve companion hash blocks
and provenance comments, as in the thirty-second slice's bounded recipe.
Never compose artifact hashes by hand. The header's bounded-regeneration line
records this run; older commands/dates below it describe the prior baseline.

For CUDA temporary projects, use an **explicit named CUDA index** for Torch
(and Wan's Torchvision), plus any retained CUDA-local package such as
`torchcodec==0.17.0+cu126`. Resolve other packages from PyPI. The older
AudioLDM2/ACE-Step 1.5 multi-index recipes can select undated PyTorch mirrors of
ordinary PyPI packages and then fail the exclusion cutoff (observed for Pillow).
The scoped-index recipe avoids that failure without weakening the cutoff or
changing installer indexes. The complete emitted lock still carries the
existing CUDA extra-index URL and exact allowed hashes.

Parsed before/after checks preserve every unrelated identity, marker and hash
set. Across the affected union, **269 identities / 5,313 distinct artifact
hashes** match official, non-yanked pre-cutoff PyPI or PyTorch-index artifacts.
Fresh OSV/MAL querybatch requests cover **271 identities**, including base
versions of CUDA-local packages; response counts, errors and pagination tokens
are checked, with zero findings. This does not certify bundled native libraries
or model assets. All nineteen full-profile hash-required installation dry plans
pass for their declared targets; these plans select artifacts without installing
or executing those full runtimes.

Native offline probes run on Apple Silicon, **CPython 3.13.18**, against fresh
seven-package baseline/candidate hash-installed subclosures, both passing
`uv pip check`. `scripts/cooled_runtime_probe.py` performs:

- Real SentencePiece BPE/unigram training on a tiny synthetic corpus under
  0.2.2, then identical encoding/decoding (Unicode, whitespace, byte fallback,
  empty text and BOS/EOS) under 0.2.3 using the same serialized models. Model
  bytes and legacy pickles reload; candidate pickles retain encode options;
  corrupt models are refused. No production tokenizer/model is downloaded.
- Real Reactor native-library loading, client construction, message/raw-frame
  callback dispatch, track selection, command/upload signatures, pre-connect
  refusal and no-session disconnect. Callback inputs are synthetic; no WebRTC
  transport, live stream or provider session is exercised.
- Actual inspected VLM and Gradio model/helper definitions with real Pydantic:
  schema limits/literals, file metadata context, JSON serialization/round-trip,
  extra fields and invalid-input refusal. Definitions are extracted by AST to
  avoid heavyweight package initializers; only FileData's documentation decorator
  is omitted. This is not a full Gradio server or model inference test.

Run the opt-in probes in those isolated environments, never an application's
installed runtime. First run `sentencepiece --fixtures <scratch> --baseline`
with 0.2.2; then use the same scratch directory with 0.2.3 and no `--baseline`.
The `reactor` subcommand needs only the locked SDK. `pydantic` takes `--vlm`,
`--gradio`, and `--client` paths to the package directories from the inspected,
hash-verified wheels. Python socket connections are refused by the probes;
Reactor's native connect API is never invoked.

Retained PyAV 18 on Python 3.11, SymPy's `mpmath<1.4`, Pixal Gradio's
`safehttpx<0.2`/`tomlkit<0.15`, and ACE-Step's py3langid 0.3 caller constraint
are unchanged. The Pydantic probes also pass after reinstalling Pixal's distinct retained
Annotated-Types 0.7.0 artifact (H3 uses 0.8.0). Seven focused installer,
profile, Reactor capture, H3 readiness and Pixal adapter files pass **222 tests**.
No full GPU runtime installation, CUDA/Windows execution, weights, generation,
production records or output-quality evaluation is claimed.
