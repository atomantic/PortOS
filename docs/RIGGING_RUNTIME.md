# Reviewed Blender rigging profile

Settings displays `python3 scripts/setup-rigging.py`. Run it from the PortOS
checkout, with Conda available. This provisions the dedicated `rigging` environment
only on an explicit user request. It does not install or update anything at boot.
Existing environments remain usable through the unchanged real `import bpy`
readiness probe. Setup refuses to replace an existing `rigging` environment;
preserve custom work and explicitly remove that environment before reprovisioning.
If installation, dependency checking or the import probe fails after this invocation
creates the environment, setup removes its new environment so the command can be
retried. A failed Conda creation or cleanup remains an explicit Conda error; inspect
and preserve any partial prefix before removing it.

The profile fixes **Blender bpy 5.2.3**, its **CPython 3.13 ABI**, and the exact
**Conda CPython 3.13.18 build** per target. `scripts/rigging-profile.json` contains
every interpreter dependency artifact, build, URL, SHA-256, MD5 and upload date.
Setup downloads and verifies the entire Conda closure before invoking an offline
`@EXPLICIT` creation from local artifacts. Conda never solves dependencies here.
The pinned interpreter's pip installs the complete target requirements with
`--isolated --require-hashes --no-deps --only-binary :all:` and the explicit PyPI
index, followed by `pip check` and a real Blender import/version probe.

Reviewed provisioning targets are Apple Silicon macOS and Linux x86_64 with
glibc 2.28+. Rosetta selects the native Apple Silicon artifacts. Windows and
Intel macOS remain unsupported; Linux arm64, other architectures and musl are
explicitly refused because this Blender release supplies no matching reviewed
wheel/profile. Existing runtime discovery is unchanged. No alternative Blender
version, source build or floating dependency fallback is attempted.

## Regeneration and advisory audit

Use a private **uv 0.13.7** (minimum security-patched version 0.13.4). Choose a
cutoff at least seven days before the maintenance date; this profile uses
**2026-11-04T00:00:00Z**. Resolve the source requirements, never install them directly:

```sh
uv pip compile scripts/requirements-rigging.txt --python-version 3.13.18 \
  --python-platform aarch64-apple-darwin --only-binary :all: --generate-hashes \
  --exclude-newer 2026-11-04T00:00:00Z --no-config \
  -o scripts/requirements-rigging-macos-arm64.lock.txt
uv pip compile scripts/requirements-rigging.txt --python-version 3.13.18 \
  --python-platform x86_64-manylinux_2_28 --only-binary :all: --generate-hashes \
  --exclude-newer 2026-11-04T00:00:00Z --no-config \
  -o scripts/requirements-rigging-linux-x64.lock.txt
```

Conda solving is a maintenance-only step, in scratch space. The initial profiles
were generated with Conda 25.5.1 using these dry runs (the prefixes must not exist):

```sh
conda create --dry-run --json --override-channels -c conda-forge \
  --platform osx-arm64 -p /tmp/rigging-resolve-macos python=3.13.18 pip=26.2.2
CONDA_OVERRIDE_GLIBC=2.28 conda create --dry-run --json --override-channels \
  -c conda-forge --platform linux-64 -p /tmp/rigging-resolve-linux \
  python=3.13.18 pip=26.2.2 'libuuid=2.42.4=*_0'
```

Inspect the full `actions.FETCH` and `actions.LINK` closure; retain every exact
artifact, not just Python. Replace both target manifests together. Independently
verify the SHA-256 and **upload time** for every artifact against
`https://api.anaconda.org/package/conda-forge/<name>`; a build timestamp alone is
insufficient. The Linux libuuid build is constrained because the newer build was
uploaded after the cutoff. Never copy a fresh solver result without this check.

Run `python3 scripts/audit-rigging.py` immediately before publishing updates.
It queries every distinct PyPI identity in both locks, the Conda pip version,
and each exact Conda artifact PURL through OSV, without filtering `MAL-` records.
Pagination is followed per identity. Any advisory or incomplete response requires
investigation before publication.
OSV's Conda coverage is limited: an empty PURL result does not establish complete
native-library advisory coverage.

## Evidence recorded on 2026-11-11

Both wheel closures resolved with uv 0.13.7 and the seven-day cutoff. The profiles
contain 12 runtime PyPI identities per target and 40 Conda artifact entries
(36 distinct artifacts across targets), all with release API upload dates before
the cutoff. OSV returned no matches for 49 queries: 13 PyPI identities including
pip, and 36 Conda PURLs. Hashes establish artifact integrity, not permanent
absence of vulnerabilities.

Fake-process provisioning tests exercise supported targets, Rosetta, refusal of
unresolved targets, existing-environment preservation and actual hash-mismatch
refusal before Conda creation. They check the offline explicit artifact input,
hash-only wheel installation and final import probe command. No native environment
was installed, and no Blender import, rigging export, render, Metal or CUDA
execution was performed in this change. Resolution and fake-process evidence do
not establish those outcomes.
