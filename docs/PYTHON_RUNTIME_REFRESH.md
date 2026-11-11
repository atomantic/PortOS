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
