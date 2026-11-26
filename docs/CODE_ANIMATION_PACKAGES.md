# Code Animation packages

**Download package** exports a finished Code Animation's saved HTML, brief,
frame settings and integrity hashes for portable authoring. Preview and MP4
export still use the saved job. `GET /api/code-animation/:id/package` returns 404
for a missing job, 409 for an unfinished one and 422 above the per-file limit.
Download HTML remains available. Review bundled source and artist-authored
brief text before sharing. Install-local provider IDs, attachments, upload URLs
and prompt text are excluded. Selected external audio is declared without its
bytes. Unrecorded seed and execution settings remain null.

## Package envelope

The [shared schema and builder](../server/lib/codeAnimationPackage.js) define
`{ schemaVersion, manifest, files, revisionHash }`. Versions 1 and 2 are
readable. Version 2 adds versioned procedural and generated audio declarations.
The manifest describes the renderer, format, brief, timing, entrypoints, assets,
audio and requested/effective execution metadata. Renderer metadata cannot
select a host executable, and imported execution metadata is a claim.
Validation rejects unknown fields and unsupported versions.

Each file contains a portable relative `path`, UTF-8 or canonical base64
`content` and SHA-256 of the decoded bytes. Limits are 64 files, 2 MiB per file,
8 MiB total and a 180-second timeline. Paths are slash-separated with exact
references to bundled files. Traversal, device names, case collisions and
duplicate or overlapping file paths are rejected. The revision hash binds
canonical manifest JSON, version and path-sorted file digests. Changing file
order, object-key order or byte encoding preserves identity. Changing source,
metadata or ordered timing arrays changes it.

The [API router](../server/routes/codeAnimation.js) defines export, import,
revision, stage-run and acceptance endpoints. Import validates integrity before
staging source, and import alone provides no evidence of readiness, safe
execution or successful review.

## Saved authoring settings

Save the scoped provider, model and effort selection, then use **Check saved
authoring settings**. `GET /api/code-animation/projects/:id/preflight` reports
configuration compatibility and stale pins without contacting a model. A
resolved configuration is a preview, with `effective: null` and
`executed: false`. The [preflight service](../server/services/codeAnimation/preflight.js)
defines readiness evidence. Authoring settings are machine-local and separate
from the renderer and production budgets.

## Contained production execution

Production package code defaults to an OS-contained worker and fails closed
where containment is unavailable. macOS uses Seatbelt, with Cycles CPU on
supported Apple silicon. Linux uses bubblewrap and seccomp where supported
by the host. Windows has no implemented containment mechanism. Read the
[containment overview](CONTAINMENT.md),
[platform policy](../server/lib/codeAnimationContainment.js) and
[worker](../server/services/codeAnimation/containedWorker.js).

The worker stages read-only inputs and writable output, temporary and home
directories in a fresh managed workspace. The sandbox denies network access,
extra processes and writes outside the approved roots. Tool configuration and
execution checks are host-control operations. The
[execution router](../server/routes/codeAnimationExecution.js) exposes readiness,
operator-owned tool settings and explicit probes. Check the current readiness
for the selected lane before running it.

**Trusted local** is an explicit operator-selected mode on macOS and Linux. It
runs reviewed source with the operator's filesystem, network and process
authority. A scrubbed environment and process supervision provide no OS
containment. Imports, manifests and stage requests cannot grant Trusted local
authority. Blender GPU execution on macOS uses Trusted local. Provider
credentials and research access stay with authoring, outside the render worker.

## Blender production adapter

**Create painterly Blender starter** stages a data-only short project without
installing dependencies, calling a model or running Blender. An explicit stage
run renders style frames and a low-sample pilot, measures evidence, can request
repair on the saved authoring route, and produces sound and a final render.
The PortOS driver controls format and render settings. It evaluates transforms
across the film to check held subjects and camera cadence. Review the actual
preview and measured evidence before accepting the output.

The [stage runner](../server/services/codeAnimation/stages.js),
[Blender adapter](../server/services/codeAnimation/blenderRender.js),
[driver](../server/services/codeAnimation/blenderDriver.js) and
[acceptance service](../server/services/codeAnimation/acceptance.js)
define stage order, limits, evidence and promotion to accepted output.

Use the [native Blender acceptance harness](../scripts/code-animation-blender-acceptance.js)
to check a real executable against the production adapter. Run
`node scripts/code-animation-blender-acceptance.js` with `--executable`,
`--blender-version` and `--out` (a new directory). It writes an
`evidence.json` verdict and leaves tool settings intact.

## Offline production sound

Explicit production stage runs support intentional silence, portable file audio
and deterministic procedural cues. Legacy live procedural sound and unstaged
external declarations fail the offline sound stage. Package v2 procedural
events use the audio contract's `version: 1` with labeled, timed
`impact` or `reveal` events. They snap to the frame grid and then the
48 kHz sample grid. Preview and final mux use the same persisted WAV.

`POST /api/code-animation/projects/:id/sound-assets` stages an upload or
library filename into a new immutable revision, under the package byte limits.
Files trim or pad to duration without looping. Evidence binds the audio and
timeline to the revision, and final audio is checked for stream, duration
and measured PCM. A failed candidate preserves earlier accepted output.
Generated audio declarations require explicit consent, a provider/model and
a separate budget. No generated Production audio adapter is available, so
stage externally produced bytes as a portable file. See the
[sound stage](../server/services/codeAnimation/sound.js) and
[asset staging](../server/services/codeAnimation/soundAssets.js).

## Film projects

**Production → Create Film project** opens the shared Blender multi-shot lane
with a 1–3,600 second timeline. A film can be silent or attach a Music-library
track or upload. Attachment explicitly runs local audio analysis. Creation
starts no analysis, provider call or render. Package projects keep their shorter
timeline and separate portable format. The projects list distinguishes
`kind: 'film'` from `kind: 'package'`.

Use the [shared Blender workflow](features/music-video.md#blender-films) to
create a workspace, author `src/film.py`, sync shots, inspect stills and
previews and render finals. **Assemble final cut** requires current final
shots covering the timeline, including the audio's final frame. It records an
accepted output in Media History. A failed attempt preserves the previous
accepted output. Music Video provides additional title, film look and
timed finishing controls.

**Send to Music Video** uses the host-control
`POST /api/code-animation/films/:id/promote` with a library track ID or
uploaded library filename. It copies source, settings, options and synced shot
inventory into an independent Blender-mode Music Video project. Renders, notes
and cuts stay with the source. The copy needs song analysis and a new sync
before rendering. Reported coverage against a stored track duration is
provisional until then. Repeating promotion makes another independent copy.

The [film router](../server/routes/codeAnimationFilms.js) defines create,
timeline, audio, promotion and shared `/blender/*` endpoints. See
[film ownership](../server/services/codeAnimation/films.js),
[final cut](../server/services/codeAnimation/filmCut.js) and
[promotion](../server/services/codeAnimation/promoteFilm.js) for state,
change invalidation and accepted-output handling.
