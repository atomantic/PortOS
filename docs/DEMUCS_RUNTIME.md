# Vocal separation runtime

Music Video's **Separate vocals** provisions a private environment only after a
user-triggered separation or configured autopilot run. Provisioning installs the
complete, wheel-only `scripts/requirements-demucs.lock.txt` set, never the package names
`demucs soundfile` against the latest index.

The lock covers CPython **3.11** on Apple Silicon **macOS 14+**, Linux x86_64 and
Windows x64. Intel macOS and other architectures report an unsupported profile
before a subprocess or package installation. Discovery requires a matching
interpreter; a wrong interpreter is rejected before an existing environment is
cleared. Rosetta Node uses an arm64 Python on Apple Silicon.

A legacy environment with no matching `portos-lock.sha256` is rebuilt. A matching
stamp plus interpreter, import, direct-package version and WAV I/O probes allow reuse.
Failed installs are not stamped and can be retried. Concurrent callers share one
provisioning operation per environment. The environment remains at
`~/.portos/venvs/demucs`, or `PORTOS_DEMUCS_VENV_DIR` when configured.

## Package choice and regeneration

Demucs 4.1 supplies a wheel and native WAV output. The older 4.0.1 archive uses
TorchAudio to write WAV files; current TorchAudio delegates that operation to
TorchCodec, so an import-only check misses the missing encoder. The runtime now
checks a small WAV export/readback before stamping or reusing its environment.
No model weights are downloaded by that probe.

Installation requires `--require-hashes --no-deps --only-binary :all:`. No source
build, build-backend resolution or loose-package fallback is allowed. The source
requirements and full regeneration command are in `scripts/requirements-demucs.txt`
and the lock header. Use a cooldown at least seven days before regeneration,
then audit **every** pin across all platform markers through OSV, including
malicious-package (`MAL-`) records. Hash verification establishes artifact
integrity; a lock is not a claim that all its packages are current or that no
future advisory will affect them.

## Verification recorded on 2026-11-10

- Resolved with private uv 0.13.6 and cutoff 2026-11-03, requiring wheels for
  every package. All 54 distinct pins were queried through OSV with zero matches,
  including MAL records. This includes the Linux CUDA package markers.
- On native Apple Silicon macOS, a fresh scratch CPython 3.11 environment installed
  the lock through pip with hashes, passed `pip check`, and passed the exact
  installer import/version/WAV-output probe. The CLI produced a vocal WAV from
  a short stereo input using its local random-weight `demucs_unittest` model
  on CPU, without downloading pretrained weights.
- Route tests retain separation, accelerator-to-CPU fallback, attachment and song
  replacement checks. Provisioning tests cover legacy rebuild, failed hash install,
  retry, shared install, reuse, wrong interpreter and unsupported hosts.

Native Windows/Linux installation, CUDA/Metal separation and pretrained-model
inference were not run. The random-weight CLI smoke establishes execution and
output compatibility, not source-separation quality. Cross-platform resolution and fake subprocess tests do
not establish those runtime outcomes. Broader 3D installer and upstream MLX video
lock inventories remain tracked in #15654.
