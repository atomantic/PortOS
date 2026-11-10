# Vocal separation runtime

Music Video's **Separate vocals** provisions a private environment only after a
user-triggered separation or configured autopilot run. Provisioning installs the
complete `scripts/requirements-demucs.lock.txt` set, never the package names
`demucs soundfile` against the latest index.

The lock covers CPython **3.11** on Apple Silicon **macOS 14+**, Linux x86_64 and
Windows x64. Intel macOS and other architectures report an unsupported profile
before a subprocess or package installation. Discovery requires a matching
interpreter; a wrong interpreter is rejected before an existing environment is
cleared. Rosetta Node uses an arm64 Python on Apple Silicon.

A legacy environment with no matching `portos-lock.sha256` is rebuilt. A matching
stamp plus interpreter, import and direct-package version probes allow reuse.
Failed installs are not stamped and can be retried. Concurrent callers share one
provisioning operation per environment. The environment remains at
`~/.portos/venvs/demucs`, or `PORTOS_DEMUCS_VENV_DIR` when configured.

## Source build and regeneration

Demucs 4.0.1 ships only a source archive. Its reviewed `setup.py` uses setuptools
and reads its version and dependency files; it has no custom native extension or
build-time download. Install the hash-pinned build lock first, then the runtime
lock with `--require-hashes --no-deps --no-build-isolation --only-binary :all:
--no-binary demucs`. Every other package must have a wheel. Both locks participate
in the environment stamp. No isolated environment resolves a fresh build backend.

The source requirements and full regeneration command are in
`scripts/requirements-demucs.txt` and the runtime lock header. Keep the three
build entries (`packaging`, `setuptools`, `wheel`) identical in both locks. Use a
cooldown at least seven days before regeneration, then audit **every** pin across
all platform markers through OSV, including malicious-package (`MAL-`) records.
Hash verification establishes artifact integrity; a lock is not a claim that
all its packages are current or that no future advisory will affect them.

## Verification recorded on 2026-11-10

- Resolved with private uv 0.13.6 and cutoff 2026-11-03, requiring wheels except
  Demucs. All 52 distinct pins were queried through OSV with zero matches,
  including MAL records. This includes the build backend and Linux CUDA packages.
- On native Apple Silicon macOS, a fresh scratch CPython 3.11 environment installed
  both locks through pip with hashes, built Demucs without isolation, passed
  `pip check`, imported the separation entrypoint, and ran `python -m demucs --help`.
- Route tests retain separation, accelerator-to-CPU fallback, attachment and song
  replacement checks. Provisioning tests cover legacy rebuild, failed hash install,
  retry, shared install, reuse, wrong interpreter and unsupported hosts.

Native Windows/Linux installation, CUDA/Metal separation and pretrained-model
inference were not run. Cross-platform resolution and fake subprocess tests do
not establish those runtime outcomes. Broader 3D installer and upstream MLX video
lock inventories remain tracked in #15654.
