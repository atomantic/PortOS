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
The precise correction and caller regression acceptance criteria are
[tracked under #15769](https://github.com/atomantic/PortOS/issues/15769#issuecomment-6819203959)
for the subsequent mlx-vlm caller/source migration; this slice does not claim
that generic stereo conversion is correct.

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
calls, H3 rendering or quality evaluation ran. The already tracked generic
VLM stereo-resampling defect is unchanged. H3's remaining original candidate
is the coordinated Hub/Transformers migration; other profile-specific updates
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
