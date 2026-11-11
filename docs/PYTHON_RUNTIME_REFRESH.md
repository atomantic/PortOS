# Staged Python runtime refresh

Issue [#15769](https://github.com/atomantic/PortOS/issues/15769) tracks the
remaining cooled Python dependency updates. A source requirements file can be a
complete native environment contract; the inventory's newest candidate is not
evidence that its API or ABI is compatible.

## Delivery stages

1. Refresh small runtime profiles independently. The first slice updates Reactor
   SDK **1.0.1 → 1.13.0** and Demucs's SoundFile **0.13.1 → 0.14.0**. The other
   53 Demucs identities stay unchanged. Lyric alignment and Prompt Guard/jev
   remain for a later slice; their existing pins have not been revalidated here.
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
