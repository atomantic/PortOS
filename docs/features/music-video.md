# Music Video

Music Video Studio (`/music-video`) takes a song from setup and analysis through
art direction, storyboard, proofs, final render and release assets. Start with
a library track or use **Autonomous** to turn a brief into a song and video.
The [project schema](../../server/lib/musicVideo/musicVideoValidation.js),
[request schemas](../../server/lib/musicVideo/routeValidation/) and
[API router](../../server/routes/musicVideo.js) define supported fields and
operations. See [agent API access](../AGENT_API_KEY.md) for session setup.

## Autonomous production

`POST /api/music-video/autonomous` starts a run and returns `202 { project, run }`.
The stages are **brief → lyrics → style → song → analyze → produce**. Instrumentals
skip lyrics; the style stage makes a text mood board. The song stage defaults to
Suno and can use local Music Designer engines. Production uses the chosen footage
tools or a code renderer. Set tools, model pins and budgets at start, or configure
them explicitly for the `music-video-autopilot` scheduled task.

Use `/:id/autonomous/resume` under the same API prefix to approve a checkpoint,
apply its edits or retry the stage that stopped. Checkpoints can pause after
lyrics, style or song. The cast checkpoint uses the production run's Cast & Sets
review. A song retake is explicit. Stop parks the run, and cancel ends it. Run
state is install-local and does not travel to peers or forks. Provider selection
follows a request pin, then the stage pin, the code-authoring pin (authoring only),
the direction model and the eligible install default. A lyric-review stage can
review and revise a draft before the song is submitted. The **Orchestrator** option
delegates checkpoints to the selected model and records its decisions and issues
with the run, within configured revision and spend limits.

Suno creation requires the signed-in PortOS Browser. Resume after sign-in if the
run parks with `PUBLISH_LOGIN_REQUIRED`. Export waits for generation to finish,
uses Suno's M4A Download UI, verifies the stamped song ID and fully decodes the
file before import. Retrying an export reuses the recorded song IDs and avoids
another Create action or credit charge.

See the [autonomous and production routes](../../server/routes/musicVideoRuns.js),
[autonomous driver](../../server/services/musicVideo/autonomousService.js),
[Suno adapter](../../server/services/musicVideo/autonomousSuno.js),
[model routing](../../server/services/musicVideo/llmRoute.js) and
[orchestrator review](../../server/services/musicVideo/orchestratorReview.js).
Render placement and peer eligibility follow the
[render-pool ADR](../decisions/2026-10-04-music-video-render-pools.md).

## Setup and production review

Analyze the exact master to get the beat and downbeat grids, sections and feature
track. Check lyric placement against the song. Vocal projects require positive,
bounded lyric word times and verification for the current audio and timing
revision. Changing words, times or audio invalidates that basis. Instrumentals
use the explicit instrumental setting. Turning **Show automatic lyric overlays**
off preserves lyric timing for planning and leaves independently authored text
and title cards in place. See [local alignment](../../server/services/musicVideo/lyricAlign.js)
and [verification](../../server/services/musicVideo/lyricVerify.js).
MMS_FA requires supported host Python and platform wheels. Intel macOS and
macOS below 14 are refused before the local separation/alignment install.
Manual LRC, SRT or WebVTT import and saved timings remain available.

Save the visual guide and art direction before approving the storyboard. Include
the timed choreography and energy plan in motion language, then record action,
staging, camera, transitions and lyric anchors on the corresponding shots. Bind
imported shots to existing Board scenes or explicitly create their scenes.
Imports supply a draft and do not verify timing or confer approval. Catalog-only
Cast & Sets resolves live subject IDs, forms and images. Missing inputs are
reported and changes to the reviewed catalog basis stale approval. Legacy
sources stay as history on conversion. See the
[catalog approval schema](../../server/lib/musicVideo/musicVideoCatalogCheckinValidation.js)
and [catalog resolver](../../server/services/musicVideo/catalogCheckin.js).

Creative approvals and feedback resolution use existing authenticated operator
sessions, including delegated agent sessions. Decisions bind the server-derived
audit identity to the exact guide, storyboard or proof revision and require
genuine inspection. An authorized `autoApprove` grant may cover art and
storyboard. It still requires the current review basis and inspection evidence.
Review changes that invalidate that basis require fresh evidence.

Review a continuous proof with its entry and exit against the master and the
saved choreography. Compare actions, camera, readable holds and energy against
the intended beats or words. Human proof review acknowledges playback with
`watchedWithAudio: true`. A machine proof submits `method: 'machine'`,
`watchedWithAudio: false`, the exact excerpt ID and filename and
`machineEvidence` with `visualReview`, `audioReview` and `limitations`. Record
the energy comparison and timecoded notes with the proof. Keep approval pending
when continuous motion and sound cannot be assessed. A production footage
pilot has its own review checkpoint. See the
[review routes](../../server/routes/musicVideoProductionReview.js),
[review gates](../../server/services/musicVideo/productionReview.js) and
[browser acceptance suite](../../server/routes/musicVideoProductionReview.browser.test.js).

For a performance take, stream-duration parity and temporal lip-sync measure
different things. The take records the actual conditioning audio and its
provenance. Compare continuous performance to that audio at timecoded anchors.
Use the [production pilot](../../server/services/musicVideo/productionPilot.js),
[temporal analyzer](../../server/services/musicVideo/temporalPerformance.js)
and [delivery routes](../../server/routes/musicVideoDelivery.js) for the current
proof and excerpt flows.

## Composition documents and finishing

**Compose → Document** supports the shipped layered and cel templates, ZIP or
data-directory import, and generated mixed-media compositions. Imports and
regenerations create immutable versions. Generated candidates leave the active
version in place until accepted. Regenerate a single section against the same
style and production basis, or regenerate the document if the treatment, timing
or selected assets change. Fork before revisions that need an independently
editable original. A footage adaptation retains the song, timing, storyboard and
lineage while starting fresh footage conditioning and production.

The [document router](../../server/routes/musicVideoComposition.js) defines
manifest, import, generation, candidate, accept, export and playback endpoints.
[Document staging](../../server/services/musicVideo/documentRender.js) packages
`portos-mv.js` (`window.PORTOS_MV`), `song.json` and selected media in a
job-private snapshot. Metadata includes song analysis, render size and timing,
lyric cues, scene layers and selected effects. The
[layered engine](../../server/services/musicVideo/documentTemplates/layered/engine.js)
is the reference for media time mapping, video seeks and visibility. For staged
clips, rate and offset are already applied. Live preview maps original source
bytes using the supplied timing. Apply the mapping once.

Implement the [seek contract](../HTML_COMPOSITIONS.md) on the absolute song
clock. Excerpts seek the corresponding window on that same frame grid. The
renderer captures silent picture and muxes the master beneath it. Document social
cuts can request a different aspect when the composition supports the target
size. The master stays at its original level. Optional sound design mixes
beneath it with a peak limiter. Finishing uses the current project grade, film
look, timing effects and title settings. Steady titles are painted above film
look when a finishing pass follows. Custom engines must declare and implement
selected effects and automatic-lyric visibility as required by the render gate.
Use the [render service](../../server/services/musicVideo/compositionRender.js)
and [shared lyric type](../../server/services/musicVideo/documentTemplates/shared/lyricType.js)
for that behavior.

Preview has an exact seek path and an optional authored complete-frame contract.
The latter needs an explicit declaration and handshake, publishes complete
frames atomically, and retires stale operations before they can paint. The
[playback validator](../../server/services/musicVideo/authoredPreviewPlayback.js)
and [synthetic example](../../server/test/authoredPreviewFixture.js) define the
protocol and eligibility. Use the exact path for fallback and final rendering.

The Board supports repeated still sequences at frame, time or musical intervals
without changing shot length. [Paused footage](../../client/src/components/musicVideo/PreviewVideo.jsx)
presents a decoded sRGB surface for preview and frame capture. The capture uses
the actual preview composition, including active transitions, film look and text.

## Blender films

Blender mode shares its authoring and render engine with
[Code Animation Films](../CODE_ANIMATION_PACKAGES.md#film-projects). Music Video
owns the song, Board, review and finishing. The workspace owns `src/`, managed
`song.json`, the synced `manifest.json` and generated `renders/`. Only edit
source under `src/`. The [starter film](../../server/services/film/py/starter/film.py)
shows `describe(ctx)`, `build_shot(ctx, shot)` and
`frame(ctx, shot, t, frame)`. Film scripts run with the operator's host access
in Trusted local. Use reviewed local source. Readiness and authorization are
checked by the shared execution configuration.

A shot can use `renderer: 'code'` with a local module exporting
`render(ctx, env)`. Canvas is the default and `space: 'three'` selects a
Three.js shot. A Blender shot can add Canvas `layers` over or under its plate.
These modules draw deterministically from song time in the composition browser
sandbox. A code-only film whose `describe(ctx)` needs no Blender imports can
sync with system Python and render without launching Blender. See the
[code shot and layer examples](../../server/services/film/codeShot.test.js).

Use ordered, nonoverlapping shot ranges on the exact render frame grid.
`ctx.frame_to_seconds(f)` expresses a boundary. Cover the song through its last
frame. A lead-in is contiguous and ends at song time zero. It contributes
picture before the song while Board cold-open settings supply its sound.
`deps` scopes source staleness to a shot. The scanner also follows imports.
Shot handles render outside the main range without lengthening the shot's
video. A dissolve requires outgoing and incoming handles; a beat toggle can
require the incoming handle. Missing required handles block final render.

Sync validates and mirrors the manifest to one Board scene per shot. Failed
sync preserves the prior edit. Re-sync after changing the shot list, declared
options or frame rate. Iterate with stills, contact sheets and previews. Play
the whole film against the master or assemble a preview cut to review it.
Use current final shots for delivery. Full coverage, creative approvals and
current final renders are required for the final join. Re-rendering a shot or
making it stale invalidates the existing final's basis. Review excerpts can
use current finals or fitted previews.

Blender typography is authored in the film using `song.json` timings. Finishing
applies the grade, supported cut and timed effects, project/camera/shot film
look and the opening title card. An explicit Clean look overrides inheritance.
Finished frame cleanup retains the encoded shot videos, stills and cuts. A fork
copies editable source, settings and synced inventory into its own workspace
and renders independently.

See the [Blender request schemas](../../server/lib/musicVideo/musicVideoBlenderValidation.js),
[shared film router](../../server/routes/filmRoutes.js),
[manifest handling](../../server/services/film/manifest.js),
[driver](../../server/services/film/py/portos_blender_driver.py) and
[final assembly](../../server/services/musicVideo/blender/finalRender.js).

## Review, exports and publishing

| Workflow | Contract |
| --- | --- |
| Publish kit | Build from the approved final. As mixed is the default. The Web preset targets −14 LUFS and −1.5 dBTP per generated copy, measures the output and preserves the source. Failed or canceled builds retain the previous kit. See the [publish routes](../../server/routes/musicVideoPublish.js) and [kit builder](../../server/services/musicVideo/publishKit.js). |
| Private sharing copy | Prepare and download a local size-limited copy from the final render panel. The full-quality download remains available. See the [sharing service](../../server/services/musicVideo/sharingCopy.js). |
| Making-of export | Select planning artifacts and explicit rights/attribution, preview the inventory, then download a local ZIP bound to that preview's digest. Changes require a fresh preview. See the [export service](../../server/services/musicVideo/makingOf.js). |
| Festival packet | Save editable credits, rights declarations and festival notes. An empty field means unknown. The packet assists submission preparation. See the [packet routes](../../server/routes/musicVideoFestivalPacket.js) and [packet service](../../server/services/musicVideo/festivalPacket.js). |

Authenticated agents may prepare private drafts and render final files within
the configured authorization, quotas and budgets. The human reviews and
submits public Suno publication or social posts on the destination platform.
