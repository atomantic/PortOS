# SuperCollider runtime

PortOS can render [SuperCollider](https://supercollider.github.io/) source offline for the Music Designer. Generated `.scd` code is untrusted: `sclang` can run shell commands and load startup files. PortOS therefore compiles and renders it only inside a disposable, locked-down Docker container built from a PortOS-owned recipe. There is no native fallback. Design record: [ADR 2026-10-01](./decisions/2026-10-01-supercollider-code-audio.md), epic #9407.

This page covers the managed runtime: the image, its setup command and its readiness contract.

## Prerequisites

- **Docker running Linux containers** on an `amd64` or `arm64` host: Docker Desktop (macOS, Windows) or Docker Engine (Linux). PortOS never installs, starts or reconfigures Docker. A missing or stopped engine is reported as unavailable, with the next step to take.
- **Disk and time, once.** The image is compiled from source on your machine. Plan for 10–30 minutes of build time and a few hundred MB for the final image, plus Docker's build cache for the compiler toolchain (reclaimable with `docker builder prune`). Renders do not keep a daemon running. Each render starts a container, which exits when the render finishes.

## Setup

```bash
npm run setup:supercollider                     # show status, offer to build
npm run setup:supercollider -- --yes            # build + verify without asking
npm run setup:supercollider -- --yes --rebuild  # repair: rebuild every layer, re-verify
npm run setup:supercollider -- --verbose        # stream the full docker build log
npm run setup:supercollider -- --status --json  # machine-readable status (never builds)
```

Setup is explicit and idempotent:

1. It checks Docker. If Docker is missing, stopped, serving Windows containers or running on an unsupported architecture, setup stops there.
2. It builds `portos-supercollider:<runtime version>` only when the image is missing, was built from a different recipe, or `--rebuild` was passed. Without `--yes` it asks first, and in a non-interactive shell it declines.
3. It runs the **synthetic render probe** when no current passing result exists. The probe renders a stock-UGen SynthDef through a non-realtime score for 2 s at 48 kHz stereo. It runs under exactly the containment that real renders use. PortOS then decodes and measures the WAV it wrote.

When the image is current and the probe evidence is current and passing, a second run does neither step. Setup and status never call an AI provider, and nothing here runs when the server boots.

By default, build output shows only the step headers. If a step fails, the failure message includes a bounded tail of the build log.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Ready (or `--status` printed) |
| 1 | Unexpected error, including a bad option |
| 2 | Docker unavailable (missing, stopped, Windows containers, unsupported architecture) |
| 3 | Build needed but not approved (no `--yes`, or answered no) |
| 4 | Image build failed |
| 5 | Synthetic render probe failed |

## Readiness states

`--status --json` and `getSuperColliderStatus()` return `{ state, ready, message, action, docker, image, runtime, smoke }`:

| `state` | Meaning |
|---|---|
| `docker-missing` | No docker CLI found |
| `docker-stopped` | CLI present, engine not answering (`docker.error` says why) |
| `docker-unsupported` | Engine serves non-Linux containers or an unsupported architecture |
| `image-missing` | The image has not been built on this machine |
| `image-stale` | The image was built for another runtime version or recipe |
| `unverified` | The image is current, but no probe result matches it |
| `smoke-failed` | The current probe failed (`smoke.error`) |
| `ready` | Current image plus a current passing probe |

The probe evidence (`smoke`) records the image id, runtime version, policy version and policy fingerprint, the Docker platform, and the measured audio. Its duration, channels, sample rate, peak and RMS are measured from the decoded WAV, not taken from the score. Evidence is **current** only when all four identifiers match. Any of these makes earlier evidence stale until setup runs again:

- rebuilding the image,
- bumping the runtime version,
- editing the recipe,
- changing the containment arguments or the probe.

Status reads the cached evidence and never renders.

Evidence is stored in `data/supercollider/runtime-evidence.json`. It is machine-local, excluded from backups, and safe to delete; setup recreates it.

## The image

The recipe lives in `docker/supercollider/`. See its `NOTICE.md` for license and source notices.

- SuperCollider **3.14.1** is built from the official release source tarball, verified by SHA-256. The build is headless: no Qt GUI or IDE, no supernova, no X11, Avahi, HID or Ableton Link. It includes `sclang`, `scsynth`, the stock class library and the stock server plugins. Quarks and third-party plugins are not included.
- The base is Debian `trixie` slim, pinned by digest. All Debian packages come from `snapshot.debian.org` at the base image's own date, so a rebuild installs the same package versions.
- `sclang` loads only the stock class library (`excludeDefaultPaths`). System and user Extensions are never on its path.
- SuperCollider is GPL-3.0-or-later. Its license text, authors list and source reference are installed under `/usr/local/share/doc/supercollider/` in the image.

The image is stamped with two labels: the runtime version (`SUPERCOLLIDER_RUNTIME_VERSION`) and a hash of the recipe directory. A test fails if the Dockerfile's pinned SuperCollider version, its source hash in `NOTICE.md`, and the runtime constants disagree. **Bump `SUPERCOLLIDER_RUNTIME_VERSION` with any pin change.**

## Containment policy

`buildSuperColliderRunArgs()` in `server/lib/superColliderRuntime.js` is the one definition of the container boundary. The probe and real renders both use it:

- `--network none`, `--cap-drop ALL`, `no-new-privileges`, `--read-only` root filesystem
- a non-root user: the host process's own uid:gid, or `nobody` when the host runs as root or has no POSIX ids
- CPU, memory (swap disabled), PID and per-file-size limits; core dumps disabled
- a private `tmpfs` home and temp directory, and an environment of explicit values only (the server's own variables and credentials never reach the container)
- the frozen source directory mounted read-only, and one job-private output directory as the only writable mount; no Docker socket
- `--pull never`, so a missing local image is never fetched from a registry by name
- `--init` to reap the `scsynth` process that `sclang` spawns

The runner (`runSuperColliderContainer`) enforces a wall-time limit and cancellation. It always runs `docker rm --force` afterwards, because killing the docker CLI does not stop a container. Removing the container removes every process inside it. Files the container writes are read back only if they are regular files within the size limit (`readContainedOutput`). A symlink in the output directory cannot point the host at its own files.

## Platform evidence

The recipe targets Linux `amd64` and `arm64` Docker engines. Readiness is per machine: a host is `ready` only after the probe has passed on that host's engine with the current image. The probe result records the engine version, OS and architecture, so the evidence names the platform it was proven on. Any other configuration stays visibly unavailable.

As of this change, the recipe has not been built in CI. Docker was not available on the machine where it was authored. The first successful `npm run setup:supercollider -- --yes` on each architecture provides the evidence. Record the outcome in the epic (#9407).

## Troubleshooting

- **Build fails fetching packages**: `snapshot.debian.org` is occasionally slow or rate-limited. Apt retries five times. Re-run setup; Docker reuses completed layers.
- **Build fails downloading the SuperCollider source, or the checksum fails**: the GitHub release asset was unreachable or altered. The build stops at the checksum rather than compiling unverified source.
- **`smoke-failed`**: read `smoke.error`, then try `npm run setup:supercollider -- --yes --rebuild`, which rebuilds without the layer cache.
- **`docker-stopped` right after starting Docker Desktop**: the engine can take a minute to come up. Re-run once it reports running.

## For the render service and UI

Import the contract rather than re-deriving it:

- `server/lib/superColliderRuntime.js`: version and policy constants, `SUPERCOLLIDER_RENDER_FORMAT`, `SUPERCOLLIDER_CONTAINER_LIMITS`, `SUPERCOLLIDER_CONTAINER_LABEL` (for orphan sweeps), `buildSuperColliderRunArgs`, `evaluateSuperColliderStatus`
- `server/services/superColliderRuntime.js`: `getSuperColliderStatus`, `setupSuperColliderRuntime` (concurrent calls share one run), `runSuperColliderContainer`, `readContainedOutput`
- `server/lib/wavAudioFile.js`: `measureWavAudio` for decoded duration, channel, rate, level and non-finite checks
