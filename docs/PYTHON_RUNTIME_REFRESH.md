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
