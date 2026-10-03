# Code Animation packages

Completed animations offer **Download package** beside Download HTML. The JSON
contains the exact saved HTML, its brief and frame settings, and integrity hashes.
It is a portable handoff to an external authoring harness. The existing preview
and MP4 export continue to use the saved job.

`GET /api/code-animation/:id/package` downloads a version-1 package. The job must
be completed; missing jobs return 404 and unfinished jobs return 409. A source
above the 2 MiB per-file package limit returns 422; Download HTML remains available. Local
provider ids, universe/mood-board pointers, upload URLs, reference attachments,
and prompt text are excluded. Source and artist-authored brief text are included;
review those before sharing a package. Selected external audio is declared but
its bytes are not included. Procedural Web Audio is declared as live sound with
no offline soundtrack. Unrecorded seed and execution settings remain `null`.

`POST /api/code-animation/packages/validate` accepts the package directly as its
JSON body. It returns `{ schemaVersion, revisionHash, renderer, fileCount,
totalBytes, executed: false }` or a 400 validation error. This is an integrity
check: it does not stage or execute code, install dependencies, call a provider,
create a project, or modify a saved animation. A valid Blender package does not
establish Blender readiness, code safety, a rendered result, or passing review.
Durable production import, execution, and rendering are separate implementation
slices of #9383.

## Version-1 envelope

All fields below are required. Unknown fields and unsupported versions are
rejected. There are no silent defaults during validation.

| Field | Contract |
|---|---|
| `schemaVersion` | Integer `1` |
| `manifest.title` | At most 200 characters |
| `manifest.brief` | `concept` (6,000 characters), `cast` (4,000), `onScreenText` (4,000) |
| `manifest.styleGuide` | At most 16,000 characters; empty is permitted |
| `manifest.renderer` | `kind`: `browser` or `blender`; nonempty `version` (128 characters); `engine`: string (128 characters) or `null`. Describes the renderer; never selects a host executable. Legacy exports use `code-animation-html-v1`, a runtime contract version. |
| `manifest.format` | Even `width`/`height` from 2 to 8,192; integer `fps` from 1 to 60; positive `durationSeconds` up to 180 |
| `manifest.seed` | Unsigned 32-bit integer or `null` |
| `manifest.entrypoints` | One to three `{ role, path }` entries; roles `scene`, `preview`, `render` are unique. Every path names a bundled file. Source language is renderer-specific. |
| `manifest.assets` | Up to 64 bundled file paths |
| `manifest.shots` | Up to 128 `{ label, startSeconds, endSeconds }` entries; positive intervals within the film |
| `manifest.events` | Up to 512 `{ label, atSeconds }` entries within the film. Shot/event labels have a 200-character limit. |
| `manifest.audio` | `{ kind: 'silence' }`, `{ kind: 'procedural', notes }`, `{ kind: 'external', notes }`, or `{ kind: 'file', path }`. Notes have a 1,500-character limit; file audio must be bundled. |
| `manifest.execution` | `requested` and `effective`, each `null` or `{ harness, connection, mode, model, effort }`. Strings are bounded (128 characters, model 256); unknown values remain `null`; mode is `api`, `cli`, or `tui`; effort uses the shared provider ladder. Imported metadata is a claim, never verified execution evidence. |
| `files` | One to 64 `{ path, encoding, content, sha256 }` entries. Encoding is `utf8` or canonical padded `base64`; SHA-256 is lowercase hex of decoded bytes. |
| `revisionHash` | Lowercase SHA-256 binding manifest, version, paths and file digests |

Paths are at most 240 characters, relative, slash-separated, and contain only
ASCII letters, digits, `.`, `_`, and `-`. Each segment starts with a letter or
digit and cannot end in a dot. Empty segments, dot segments, hidden paths,
absolute paths, backslashes, drive/URL prefixes, escaped separators and Windows
device names are refused. Duplicate paths, case collisions, and file/parent
collisions are refused on every platform. References must match the exact path.

Each decoded file is limited to 2 MiB and all decoded files together to 8 MiB.
Malformed or noncanonical base64 and invalid UTF-8 text are refused. File bytes
are checked against their digest before the validation can succeed.

The revision hash is SHA-256 over UTF-8 canonical JSON for:

```js
{
  schemaVersion,
  manifest,
  files: files.map(({ path, sha256 }) => ({ path, sha256 }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
```

Canonical JSON sorts object keys recursively, uses compact JSON serialization,
and preserves array order. The same bytes encoded as UTF-8 or base64 and the
same metadata in another key order retain the revision hash. File order does
not matter; timing/entrypoint/asset order does. Changing source bytes or manifest
settings changes the revision hash. The leaf contract in
`server/lib/codeAnimationPackage.js` provides the shared schema and builder.
No package is persisted by these endpoints, so this slice needs no new store,
seed, migration, or federation channel.

## Saved authoring settings

Production projects use the existing scoped provider/model/effort picker. These
settings remain machine-local and independent of the renderer and production
budgets. Save edits before using **Check saved authoring settings**.

`GET /api/code-animation/projects/:id/preflight` reads the saved selection and
reports missing/disabled routes, model pins, unsupported effort, and stale
connection/mode constraints. `resolved` is a configuration preview; `effective`
is null and `executed` is false. It neither contacts a model nor probes or grants
tools. Catalog compatibility does not verify runtime installation, credentials,
model access at the vendor, or render readiness. Production authoring dispatch,
render/inspection/research adapters, fallback decisions and actual-run provenance
remain pending under #9387 and the execution slices of #9383. Package export and
import remain available for external authoring.

## Contained production execution

A job directory is not a boundary. Production package code defaults to the contained worker in
`server/services/codeAnimation/containedWorker.js`, under an enforced OS
mechanism. Where no mechanism is available the worker refuses with 503
`CODE_ANIMATION_CONTAINMENT_UNAVAILABLE`; there is no automatic fallback.
An operator may instead explicitly select **Trusted local**, acknowledge host
access, save the setting, and pass a new execution check. This opt-in mode is
available on macOS and Linux. It runs trusted scene code with the account's
host filesystem, network and process access: environment scrubbing and process
supervision are **not containment**. Source can escape the supervised group or
write outside its workspace. Only run source you trust in that mode. Packages,
imports, project manifests and stage-run request bodies cannot grant this authority.
Authoring stays outside the worker: provider transport, credentials and any
research access belong to the authoring route, never to execution.

| Platform | Mechanism | Status |
|---|---|---|
| macOS | Seatbelt kernel sandbox (`/usr/bin/sandbox-exec`, deny-by-default profile) | Supported for the synthetic containment check; the official Blender 4.2.0 arm64 build cannot start under it, so Blender runs use Trusted local |
| Linux x64 / arm64 | bubblewrap namespaces and seccomp | Requires executable `/usr/bin/bwrap`, permitted unprivileged user namespaces and seccomp; proven on demand. Not a project target: never run with real Blender |
| Windows | None implemented | Refused |

Each run gets a fresh UUID workspace under `data/code-animation-workspaces/`
(excluded from backups, removed when the run ends, swept on the next run after
a crash) with `input/` (staged files, read-only), `output/`, `tmp/` and a
private `home/`. The Seatbelt profile allows:

- exec of exactly the operator-configured executable; **fork is denied**, so a
  worker is one process and cannot start a shell, package manager or helper;
- reads of system libraries, Homebrew package code (`Cellar/`, `opt/`, not
  `var/` or `etc/`), the tool's install roots and the staged input;
- writes to `output/`, `tmp/` and `home/` only;
- metadata (not listing or content) of those roots' ancestor directories.

Everything else is denied, including all network (loopback and Unix sockets
too, so PortOS's API and local services are unreachable), Mach/XPC services
(keychain, pasteboard, launchd) and IPC. The environment is built from scratch
(worker paths and a synthetic worker identity only), so no `PORTOS_API_TOKEN`, provider key, cloud credential or proxy
setting is inherited. The process runs in its own process group: cancellation
and every limit `SIGKILL` the group, and the result reports whether the group
was verified empty. Limits: wall time, total bytes and file count of the
writable directories (watchdog), single-file size (`RLIMIT_FSIZE`), resident
memory (watchdog), open descriptors, no core dumps. Output that is not a
regular, singly-linked file (a symlink or hard link the worker made) fails the
run and is never handed to the caller.

On Linux, bubblewrap starts from an empty filesystem, mounts only system/tool
code and staged input read-only, and maps the three writable directories under
`/workspace`. The synthetic root is read-only too, so it cannot become
unmetered scratch space. PID, network, IPC, UTS and user namespaces isolate the
worker; all capabilities are dropped. A seccomp filter denies process creation,
network sockets and namespace changes while permitting native threads. The
filter rejects unknown ABIs and makes `clone3` fall back to the older, flag-
checked `clone` syscall. Cancellation kills the wrapper's process group;
bubblewrap's parent-death handling tears down its PID namespace. Memory
accounting includes the wrapper's descendants, not just the wrapper itself.

A capability probe runs trusted system code to verify namespaces before any
package is staged. Missing bubblewrap, unsupported architecture, restricted
user namespaces (including Ubuntu AppArmor restrictions), or failure of the
adversarial check keeps execution refused. PortOS never installs bubblewrap,
changes host policy or falls back to an uncontained worker automatically.
The dedicated Linux CI job requires a functioning real mechanism: unavailable
bubblewrap fails that job instead of silently skipping its boundary tests.

Installed tools are operator-owned machine-local settings
(`codeAnimationExecution` in `data/settings.json`). Packages cannot name an
executable, install command or mount. A tool must be an existing absolute
executable outside PortOS data; workers can read its app bundle (macOS
`.app`), its prefix's `bin/`, `lib/`, `libexec/`, `share/` and `Frameworks/`
when it lives in a `bin/` directory, or otherwise its own directory — and none
of those may contain PortOS data or the home directory.

- `GET /api/code-animation/execution` reports the platform mechanism, the
  configured tools, selected execution mode, last check and each lane's readiness.
  Readiness fails closed: the Blender lane is ready only after the selected
  mode's check has passed in this server process for the configured executable
  and engine, and its fixed test scene has rendered successfully. Every save
  revokes the check. Stage evidence binds its executable fingerprint, version,
  engine, mode and check timestamp; changing readiness prevents reuse.
- `PUT /api/code-animation/execution/tools` sets `{ blender: { executable,
  executionMode, engine, acknowledgeHostAccess } }`. Defaults preserve
  `contained` / `CYCLES`; `trusted-local` requires acknowledgement. `null`
  clears the executable. This remains an operator-only host-control route.
- `POST /api/code-animation/execution/probe` runs the containment check on
  demand (host control; never at boot; no provider call). PortOS's own Node
  interpreter runs synthetic hostile scripts through the same staging, profile,
  environment and limits, and each check must observe the sandbox refusing:
  reading a file outside the workspace, listing PortOS data or the home
  directory, writing outside the workspace or into staged input, starting a
  process, writing a file over the size limit, inheriting environment
  variables, connecting to a loopback listener (which must see no connection)
  or to the network. Positive control: the worker must still write its report.
  Separate runs must be terminated by the wall-time, disk, memory and
  cancellation limits with an empty process group. A configured Blender is then
  asked to build and render a fixed 64 × 64 cube scene in the saved mode using
  `--background --factory-startup --disable-autoexec --python-exit-code 1`.
  The baseline is Blender 4.2.0, matching the existing pinned rigging runtime,
  with the selected Cycles / CPU or EEVEE / GPU engine, eight samples and seed zero. Other versions remain
  unverified and fail this probe. The check decodes the PNG, requires the exact
  dimensions and nonblank pixels, validates the runtime/engine/device report,
  and records its image SHA-256 and elapsed time. A version banner, successful
  exit or `bpy` import alone cannot pass. No generated project code runs here;
  no dependency installation is attempted.

In trusted-local mode the check runs wall-time, workspace-disk, memory and
cancellation controls plus the fixed Blender scene; it does **not** report the
host-access adversarial checks as passing. Contained mode still requires all
adversarial checks. Cycles CPU can be substantially slower than GPU rendering.
EEVEE availability must be established by its own actual render; no engine or
execution mode is substituted silently. Seatbelt is deprecated by Apple and a
host or Blender build may not work inside its profile; that lane stays refused.

**Supported Blender path.** macOS (Apple silicon) in **Trusted local** mode is the supported way to run Blender code animations. Contained Blender is not a goal on macOS: the Seatbelt profile (no fork, no Mach services) cannot run the official build, and relaxing it would weaken the containment this mode exists to guarantee. Windows has no containment mechanism and no Blender lane; Linux is untested. Trusted local runs scene code with the operator's full host access, so run only source you trust.
Memory and disk limits are watchdog-enforced, so brief overshoots are possible.

## Blender production adapter

**Create painterly Blender starter** creates a data-only package containing the
original `build_scene(config)` Python source for *Lantern in a Painted Garden*:
a deterministic brush-stroke pigment atlas, faceted paper forms, a subject animated on
twos with anticipation/squash and sparks that lag on threes, a warm lantern light
against a cool moon-side fill, dark foreground leaves, and a continuously keyed
perspective camera with shallow focus on the lantern. No external assets,
downloads, add-ons, provider calls or rendering occur on import. The default
format is 10 seconds at 1920 × 1080 / 24 fps, Blender 4.2.0 / Cycles CPU. The
project's authoring provider remains independent from its renderer.

After an explicit production start, the existing stage controller runs native
style frames, a complete low-sample pilot, evidence inspection, optional repair
through the saved authoring route, soundtrack, and final render. Preview uses
four samples; final uses sixteen. Both use a fixed seed and two CPU threads.
PortOS owns the Blender driver and loads the package's scene entrypoint; it
forces the requested format, renderer and quality settings. The driver rejects
live physics/particle simulations, requires constant subject/FX keys on the
declared cadence, measures evaluated transforms across every frame, and checks
that camera transforms vary continuously. Cycles excludes held subjects and
their children from motion blur; EEVEE disables blur to preserve the holds.
These are transform/cadence checks, not a claim that arbitrary mesh deformation
or semantic visual quality was independently reviewed.

The baked `.blend` packs original textures (the driver packs each image once; repacking an
already packed image re-encodes it and corrupts its colour channels). Scene, report, every decoded PNG,
pilot MP4 and final sequence are immutable run artifacts, separate from accepted
source revisions. Missing frames, malformed output, unsupported runtime/engine,
revoked readiness, worker failure and cancellation cannot pass. PNG geometry
and complete decoding are checked before shared ffmpeg encoding; the result is
probed for geometry and frame count. Final output uses the existing media
history and soundtrack mux flow. Run records display engine/device/mode and
link the pilot, final movie and baked scene. Project time/render/disk budgets
apply throughout; cancellation keeps earlier accepted artifacts. Failed native
workers never fall back to browser rendering or a different engine.

Runtime/format/cadence fixtures test these contracts but do not constitute real
Blender acceptance. That is established by
`scripts/code-animation-blender-acceptance.js`, which drives the production
`renderBlenderSequence` against an operator-supplied Blender 4.2.0 executable and
writes an `evidence.json` verdict. It refuses to reuse an output directory, never
writes machine settings, fingerprints the executable rather than recording its
path, and `--mode trusted-local` prints the no-containment warning.

```bash
node scripts/code-animation-blender-acceptance.js --executable <Blender 4.2.0> --out <new dir> \
  --mode trusted-local --phase pilot|final            # full 10 s sequence
node scripts/code-animation-blender-acceptance.js ... --repeat --times 1,5,9   # repeat sampled frames
node scripts/code-animation-blender-acceptance.js ... --cancel-after 40        # real cancellation
node scripts/code-animation-blender-acceptance.js ... --engine BLENDER_EEVEE_NEXT --backend METAL
```

**Acceptance run, 2026-10-02.** Official Blender 4.2.0 macOS arm64 build (the
download's SHA-256 matched the published checksum), Apple Silicon host, explicit
trusted-local mode, bundled starter source SHA-256
`3e108ac6e3610219dfe8249a8292a499cae1e55db730826296713845c98d3b16`, seed 17, two
CPU threads, 1920 × 1080 / 24 fps / 10 s. Every run produced all 240 PNGs, a
packed `.blend`, a complete decode of every frame, and an H.264 MP4 probed at
exactly 240 frames and 1920 × 1080 / 24 fps.

| Engine / device | Profile | Samples | Wall time | Retained | MP4 SHA-256 |
|---|---|---|---|---|---|
| Cycles / CPU | pilot | 4 | 27.1 min | 1.08 GB | `1952dd80…133f3e` |
| Cycles / CPU | final | 16 | 103 min | 0.88 GB | `963a0e30…f27394` |
| EEVEE Next / GPU (Metal) | pilot | 4 | 55 s | 0.63 GB | `a3409aef…18ea` |
| EEVEE Next / GPU (Metal) | final | 16 | 76 s | 0.59 GB | `f93885a3…133c` |

Cycles CPU costs roughly 30× (pilot) to 80× (final) the wall time of EEVEE on this host, so the
preview/final choice is a real cost decision. The cadence check passed in every
run: the lantern holds on twos, nine sparks hold on threes, motion blur is off for
held subjects, and the camera moves on every frame. Reported engine, device and
backend came from Blender itself, and no engine was substituted.

- **Repeatability.** Two independent renders of seconds 1, 5 and 9 gave
  byte-identical decoded pixels for Cycles CPU (SHA-256 `59195b0d…ce3b`,
  `e66853ca…58bd`, `77992468…ec36`) and for EEVEE Next/Metal, on the same
  executable and host. This does not claim cross-machine or cross-version identity.
- **Cancellation.** Aborting a Cycles pilot after 40 s terminated the worker
  (`reason: canceled`, SIGKILL) with an empty process group and no accepted
  artifacts.
- **Memory.** A full EEVEE Next pilot peaked near 9.7 GiB resident and was killed
  by the 8 GiB worker watchdog before the limit was raised for that engine only
  (16 GiB; Cycles CPU stays on the default). The watchdog still applies.
- **Missing or unsupported runtime.** The script refuses a missing executable
  before starting a worker, and the readiness gate refuses an unchecked or
  mismatched runtime. Contained mode on this macOS host fails closed: the Seatbelt
  profile cannot start Blender, so nothing is accepted and no mode is substituted.
- **Malformed output.** Truncated, missing and mismatched output is exercised by
  the fixtures in `blenderRender.test.js`; the real runtime was not made to emit
  malformed output.

Not demonstrated, and not planned: contained-mode Blender acceptance on any platform
(macOS Seatbelt cannot start Blender; Linux bubblewrap is not a project target) and a
GPU backend other than Metal. Cross-machine repeatability is also unverified. The Cycles pilot was produced by the first revision of
the acceptance script; the remaining runs used the current one, which calls the same
`renderBlenderSequence`.

The browser lane does not use this worker. It reuses the HTML-composition
renderer sandbox (`server/services/htmlComposition/browser.js`): an in-memory
asset snapshot (symlinks refused), every request intercepted with only the
snapshot origin fulfilled, network/WebSocket/WebRTC/workers/frames refused, and
a disposable credential-free browser context closed on cancel or failure. Its
limits: it runs inside the shared managed Chromium (Chromium's renderer sandbox
contains page code, not a PortOS-owned process group), with per-command
timeouts and render cancellation but no per-render memory cap. Its boundary
tests are `server/services/htmlComposition/index.test.js`.


## Offline Production sound

Production stage runs produce sound only after an explicit **Run production stages** / **Start run** action. Packages with intentional `silence` remain silent.
Legacy `procedural` notes and unstaged `external` declarations fail visibly;
they do not earn a successful soundtrack verdict. Fast HTML export keeps its
existing procedural/upload limitation notes.

Package v1 remains readable. Package v2 introduces audio contract version 1:

```json
{"kind":"procedural","version":1,"events":[
  {"label":"Impact","atSeconds":0.5,"effect":"impact","durationSeconds":0.2,"gain":0.8},
  {"label":"Reveal","atSeconds":1.25,"effect":"reveal","durationSeconds":0.4,"gain":0.6}
]}
```

Times are seconds, rounded to the nearest film frame and then the 48,000 Hz
sample grid. Impact/reveal effects produce deterministic 16-bit mono WAV bytes.
The timeline is bounded to 128 events, four seconds per event and 180 seconds
of total synthesis work. Event durations must fit the film. Preview plays the
persisted WAV used by final muxing; a live Web Audio clock is never captured.

Portable `file` audio is normalized to this same grid (trimmed or padded, without
looping), preserving stereo channels. `POST /api/code-animation/projects/:id/sound-assets` accepts an explicit
`revisionId`, `source` (`upload` or `library`) and existing audio `filename`
basename. It copies validated asset bytes into a new immutable package candidate;
there are no host-path inputs. The portable package limits still apply (2 MiB
per file, 8 MiB total). Importing or staging never calls a provider.

Sound artifacts and measured evidence live in the existing project run records
and managed run directories. Package, source, timeline and audio hashes bind
that evidence to its immutable revision. Failed/canceled candidates leave
accepted source and earlier sound artifacts intact. A restart marks stranded
runs interrupted; resume is an explicit action and sound is rebuilt/remeasured.
The disk, time and render budgets cover offline audio as well as visual work.

Final MP4 sound must pass real ffprobe stream/duration checks and bounded PCM
decode measurements, including synthetic event placement. Listening quality
remains unverified. A `generated` declaration (package v2, `version: 1`, `prompt`)
is distinct from procedural/file sound: a stage request requires explicit
`audioConsent`, `audioProviderId`, `audioModel` and a separate positive
`audioBudgetUsd`. No provider audio adapter is available yet, so even consented
requests fail before provider dispatch; stage externally produced bytes as a
portable file instead. There are no startup audio calls or automatic resumes.
