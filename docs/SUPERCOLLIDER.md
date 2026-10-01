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

## Renders

A Music Designer render is a media-queue job of kind `supercollider` (`server/services/superColliderRender.js`). It runs on the queue's serialized local lane, the same lane as HTML compositions, so it never competes with another heavy local render for the machine.

| Route | Purpose |
|---|---|
| `GET /api/music/supercollider/status` | The readiness verdict above. Reads only; never builds or renders. |
| `POST /api/music/supercollider/setup` | SSE stream of an explicit setup (`{ "rebuild": true }` to repair). The build continues if the page closes. |
| `POST /api/music/supercollider/render` | `{ code, durationSec, seed? }`, with a whole-second duration from 4 to 120 s. Returns `202 { jobId, position, status, seed, sourceHash }`. Returns `409 SUPERCOLLIDER_UNAVAILABLE` with the setup action when the runtime is not ready. |
| `GET /api/music/supercollider/renders/:jobId/events` | Queue progress over SSE: `queued`, `started`, `progress`/`status` phases, then `complete` with the preview, `error`, or `canceled` |
| `POST /api/music/supercollider/renders/:jobId/cancel` | Cancel. The container is force-removed. |
| `GET /api/music/supercollider/renders/:jobId/audio` | The validated preview WAV |

What one render does:

1. **Snapshot.** The job's params carry the source text, so each job, including a retry, writes its own copy into `data/supercollider/jobs/<jobId>/in/`. A shipped wrapper (`render.scd`) sits beside it. The source cannot name any path, format or duration.
2. **Contain.** Both run through `runSuperColliderContainer` under the policy above, pinned to the verified image id. The only writable mount is `data/supercollider/jobs/<jobId>/out/`. The host stops the container early if that directory exceeds its byte or file-count budget.
3. **Score.** The wrapper compiles the source. On a parse error nothing runs. It then seeds the interpreter and evaluates the source, whose **last expression must be a pattern** (for example `Pbind` or `Ppar`). It scores that pattern for exactly the requested duration at 120 BPM. It sends every SynthDef the source `.add`ed, plus the stock `\default`, and renders 48 kHz stereo float through non-realtime `scsynth`.
4. **Validate.** The host reads back one regular file within a size bound; symlinks are refused. It decodes the file and checks that it has 2 channels at 48 kHz, lasts the requested duration within 50 ms, contains only finite samples, and peaks above -40 dBFS.
5. **Publish or clean up.** A passing render becomes a preview: `data/supercollider/previews/<jobId>.wav` plus a `<jobId>.json` provenance sidecar. The sidecar records the source, its SHA-256, the seed, the settings, the runtime version, the policy version, the image id and the measured audio. Previews expire after 24 hours. A preview never changes a track. Saving one as a take is a separate action. The job directory is removed on every outcome, and the container is always force-removed.

Before each render, the service removes leftovers from a crashed process: labeled render containers and job directories older than any possible run (the wall limit plus 5 minutes).

Failures carry a `SUPERCOLLIDER_*` code:

| Code | Cause |
|---|---|
| `SUPERCOLLIDER_UNAVAILABLE` | The runtime is not `ready`. The message names the setup step. |
| `SUPERCOLLIDER_SYNTAX_ERROR` | The source did not compile. The message includes sclang's `line N char M`. |
| `SUPERCOLLIDER_SOURCE_ERROR` | Evaluating the source threw an error. |
| `SUPERCOLLIDER_NOT_A_PATTERN` | The source's last value was not a pattern. |
| `SUPERCOLLIDER_SCORE_ERROR` / `SUPERCOLLIDER_SYNTHESIS_FAILED` | Scoring or `scsynth` failed. |
| `SUPERCOLLIDER_TIMEOUT` | The render ran past the wall limit (180 s) and was killed. |
| `SUPERCOLLIDER_OUTPUT_QUOTA` | The render wrote more output than its budget allows. |
| `SUPERCOLLIDER_OUTPUT_INVALID` | The output is missing, a symlink, the wrong format, the wrong length, non-finite, or silent. |
| `SUPERCOLLIDER_CANCELED` | The user canceled the render. |

### Live containment evidence

`server/services/superColliderRender.test.js` covers the workflow against a Docker double. The real boundary is exercised by an opt-in suite that needs a machine where setup has passed:

```bash
cd server && PORTOS_SUPERCOLLIDER_LIVE=1 npx vitest run services/superColliderRender.live.test.js
```

The suite renders stock synths and measures the result. It then confirms that generated source cannot do any of the following:

- read an unmounted host file or the server's environment,
- write to its input or root filesystem, directly or through a shell,
- connect to a host listener,
- load an operator startup file,
- run as root.

It also checks syntax errors, the timeout, cancellation and overlapping renders. With the flag set, an unready runtime fails the suite rather than skipping it.

## In the Music Designer

Pick **SuperCollider** beside Strudel and Tone.js in the Code engine. The AI writes (or revises) `sclang` source from the description; you can edit it freely. Nothing runs in the browser.

- **Unavailable runtime.** The panel reads `GET /api/music/supercollider/status` and, when the state is not `ready`, shows the message and next step. **Set up SuperCollider** starts the explicit setup (it never starts by itself) and streams its log. Docker states offer **Check again** instead, because PortOS never changes your Docker installation.
- **Render preview.** Queues a render of the editor's source for the **Render length** (4–120 s). Progress, queue position and **Cancel** come from the media-queue stream. A passing render plays in a normal audio control. A preview never changes the track, and a failed or canceled render leaves nothing behind.
- **Save as take.** Sends only the preview's job id to `POST /api/tracks/:id/supercollider/take`. The server reads the audio and the provenance back from its own preview store, so the client cannot supply either. Editing the code after a preview disables saving that preview, because the audio no longer matches the text. Previews expire after 24 hours.

### Take provenance

A saved take is an ordinary `engine: 'code'` render in the track's history. A server-rendered one also carries `codeProvenance`:

| Field | Meaning |
|---|---|
| `language` | `supercollider` |
| `source` | The exact source that rendered the audio (up to 20,000 characters) |
| `sourceHash` | SHA-256 of that source |
| `seed` | The interpreter seed used for the render |
| `runtimeVersion`, `policyVersion` | The SuperCollider runtime and containment policy that produced it |
| `settings` | `durationSec`, `sampleRate`, `channels`, `tempoBpm` |

Re-rendering the same source with the same seed and settings reproduces the take only on the same tested runtime version and platform. Other versions or architectures are not promised to match. The record rides the render history through the existing track store and sync (tracks schema v10, additive; older renders simply have none, so there is nothing to migrate). A peer on schema v9 or older refuses newer track records instead of stripping the field.

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
- `server/services/superColliderRender.js`: `renderSuperColliderSource` (one contained render to a validated preview), `readSuperColliderPreview(jobId)` → `{ wavPath, preview }` for saving a preview as a take, `presentSuperColliderPreview`
