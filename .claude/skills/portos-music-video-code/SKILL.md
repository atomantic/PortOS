---
name: portos-music-video-code
description: Author and review a treatment-driven mixed-media music-video composition in PortOS.
---

# Mixed-media composition authoring

Use the Music Video **Compose → Document → Generate mixed-media composition** action after the song is analyzed, the treatment is approved, and each footage or still scene has a timed, selected local asset. The provider and model shown beside the button write only section drawing functions. No footage or still provider runs during this step. Missing selected media is a preflight error to resolve on the scene board.

PortOS assembles the functions into an immutable candidate version of its layered document. The active document remains selected while the candidate is previewed. Scrub the candidate through each section boundary, selected clip in-point and out-point, repeated hooks and lyric onsets; play it with the master song to judge movement and audio alignment. Accept the reviewed version to render it, or discard it. **Regenerate section** writes a new candidate with the same shared style contract and every other section unchanged. If the treatment, song, scene timing or selected media changed, generate a fresh candidate.

Author each `function render(ctx, env)` as a deterministic drawing function of song time. `env.t` is absolute song time; `env.localT` is time since this section began; `env.frame` is the integer frame for seeded motion. Use `env.song.beats`, `env.song.downbeats`, lyric word times, the safe inset and the approved palette. A seek to the same time must draw the same pixels regardless of prior seeks. Change repeated hook direction, staging or seed deliberately while preserving motif and color identity. Keep the host's lyric pass readable: leave negative space and avoid painting over words at the bottom of a scene.

The Canvas document host draws selected stills and clips according to each scene's explicit visual layer, then invokes the section function. Compose purposeful subject/prop graphics, camera staging, typography and transitions at the energy specified in the approved choreography; do not treat restrained overlays as the universal goal. Preserve the meaning and readability of selected media. For procedural/card scenes, author the whole animated world, characters, props and action rather than a background with incidental particles. The host resolves only selected project assets and seeks video asynchronously using the chosen performance in/out edit. Do not use network requests, remote URLs, arbitrary paths, dynamic imports, clocks, entropy, or DOM loading in section code. PortOS stages local assets through `window.PORTOS_MV`, owns the sandbox, and renders previews, excerpts and final output from the same song clock.

Manual ZIP/folder documents and native Code videos have separate controls. Code-only is a media policy and can use rich composition documents. Generation keeps the active document selected until the candidate is accepted.


## Timed choreography and playback review

Before authoring, save **Production review → Edit visual guide and storyboard → Timed choreography and energy plan** in the existing motion-language field. Start with a chosen energy target (for example, restrained verse into driving chorus, or explosive throughout), justified by the song and director's intent. Do not assume subtle motion is good direction. The implementation/feasibility field explains how the selected renderer will execute the plan; it does not replace the choreography.

For each section or shot, record time ranges and music anchors (downbeats, beat counts, lyric words or section entries), then specify subject/prop actions, pose changes and travel, camera path, typography timing, and the entry/exit handoff. Keep intentional still holds distinct from missing motion. On repeated choruses, preserve visual identity while deliberately escalating or transforming action, staging, camera depth, pose range or transition scale. Save corresponding action, staging, camera and transition details in the storyboard and bind lyric anchors. UI authoring and autopilot receive these saved fields as the human-reviewed choreography; changing them invalidates the associated review basis.

Render and watch a continuous chorus proof with its entry and exit, normal-speed playback and master audio. Compare the saved energy target against the result: do major subject/prop actions read, do accents land on the chosen beats/words, do camera and typography support the action, are holds readable, and does the next chorus develop rather than merely repeat? Check motion throughout the interval, including transitions; attractive stills, changing pixels, deterministic seeks and a valid render contract cannot establish choreography quality. If the proof is static or sluggish against an energetic plan, revise the authored actions and test playback again before approving. Record actionable feedback by time range and intended versus observed action. Fill the proof review’s energy comparison and timestamped playback notes (for example, `0:04` or `4.5s`); they are saved against that exact excerpt and filename. A replacement proof needs fresh notes and acknowledgement. Acknowledge audio playback against the saved choreography only after making that comparison; keep the server's revision-bound art, storyboard and proof gates intact.

Production approvals use the existing signed-in session, including authenticated agent sessions; do not ask for the instance password again or mint a new credential. Review authority does not establish review quality. An agent reviewing a proof must inspect continuous motion and audio alignment against the saved plan, then submit `proofReview.method: "machine"`, `watchedWithAudio: false`, the exact excerpt ID and filename, an energy comparison, timecoded notes, and `machineEvidence` containing `visualReview`, `audioReview`, and `limitations`. Describe the actual inspection method, observed actions and musical anchors, and any limits; never fabricate watched/listened evidence. Still frames, waveform checks or a successful render alone are insufficient. If available tools cannot assess motion and audio, leave proof approval pending and identify the missing review. Human playback continues to use its explicit playback acknowledgement. The server records the authenticated session and review evidence; a shared agent credential cannot identify the individual agent. Final public publishing remains manual.

Respect renderer capabilities while pursuing this direction: native Code uses its documented Canvas restrictions and native output size; composition documents support richer local fonts, authored worlds and the deterministic `seek(t)` contract. Code-only prohibits imagegen for guides as well as output. Build its guides and proofs from code-rendered scenes. A limitation is a reason to revise the implementation plan or choose a supported renderer, not to silently substitute raster assets or remote dependencies.

## Revisions and footage variants

Use **Fork vN** before revising a finished code video when the original must stay independently editable. For manual composition documents, **Export ZIP**, edit the HTML/JS locally, then import the revised ZIP/folder into the fork. Imports write immutable versions; unreferenced versions may be pruned, so fork before replacing a document you want to keep. Code-only sections also remain editable through the composition API and the section regeneration action.

Use **Fork for video generation** to adapt a code or document video into footage. It preserves song, analysis, timed lyrics, storyboard, parent/root lineage and immutable document/development artifact references. It starts in Composed mode with footage scenes, a fresh Cast & Sets stage and no selected mood board, reference images or video takes. Source publishing outputs and active runs are not carried into the fork. The source project is unchanged and forking calls no providers.

In the new project, choose the new mood board, prepare its photographic cast and set sheets, review the retained storyboard and prompts for the new medium, and select the image/video services and generation budget before starting production. Old sheets remain development references, not approval of the new cast. The original code document stays available for export or switching back to Document mode; retain the source project as the code version.

## Whole-scene media modes and rich worlds

Choose **Design and composition media** independently of **Authoring renderer**. Code only admits procedural code, local fonts and the master audio: never request imagegen for guides, mood exploration, storyboards or final frames. Develop visual guides from code-rendered candidate frames. Code + images admits stills throughout planning and composition; Code + images + video also admits footage. Tool selections and budgets remain additional limits. Existing code-only tool briefs migrate restrictively; historical assets remain stored and must be deselected before use under a narrower mode.

In **Compose → Document**, choose **Three.js authored worlds → Generate authored 3D composition** for complete geometry scenes. Each section's `render(ctx, env)` receives `ctx.THREE`, a fresh `ctx.scene`, a perspective `ctx.camera`, and the transparent Canvas2D `ctx.text`. Author environments, articulated characters, props, lights, camera movement and dramatic actions from absolute song time. Every seek creates a fresh world; do not integrate physics or depend on earlier frames. This generated renderer currently composes geometry and typography only. Use the Canvas layered renderer or an imported document for selected images/video. Native **Code** remains a separate 720p Canvas capability, not the definition of code-only.

PortOS packages installed Three.js, license, local fonts, validated author functions and a dependency hash manifest in the immutable document version. It does not install packages, load CDNs or grant network access. Preview supports acyclic local static ES-module graphs (including inline module entrypoints); remote/bare/dynamic imports are unsupported. The same `portosComposition.seek(t)` drives preview, excerpt and final capture, normally 1080p24. Finish every `await` (image decode; video `seeked` plus a presented frame, as the layered template's `seekVideo` waits for) before clearing, drawing or showing a layer: the render waits for the whole seek, but the live preview paints at each await, so clear-then-await flashes in the preview only. Preview media loads on demand when a media `src` first names it, so a far scrub waits for that file inside `seek`; keep decoded-image caches to a few seconds around the playhead (a 2048×1152 frame decodes to about 9 MB), or iPhone Safari reloads the tab. Imported documents may declare supported motion blur; export honors that contract. A valid contract proves execution, not art quality: inspect authored characters/action and changing frames, then the existing treatment/proof workflow decides readiness.

Code-only autopilot preserves text direction and defaults to this document authoring path, retaining explicitly saved legacy Code choices. It never requests image guides or an image/video provider. Code-rendered prototypes and visual planning remain required by the production review workflow; skipping raster moodboard assets is not approval to skip art direction.

## Toon worlds

Use the shared `toonWorld.js` kit for cel worlds. Import it at the document root
(`import * as kit from './toonWorld.js'`); PortOS copies missing kit and local
Three.js vendor files into the immutable document. Both spatial and layered
manual documents can import it. Generated spatial sections receive
`ctx.toonWorld`, with no imports or globals in the authored function.

- `toonMaterial(ctx.THREE, { lit, mid, shadow, bands: 3 })` uses explicit palette
  colors, including tinted shadow-map receiving. Lighting selects discrete bands.
- `shellLathe(profile, thickness, segments = 64)` takes base-to-rim
  `[radius, height]` points and closes the inner/outer contour, rim and base.
  Keep thickness smaller than the local radius of curvature. Never use a
  single-surface bowl, cup or shell.
- `solidify(geometry, thickness)` closes the boundary of an orientable triangle
  sheet; vertex normals define its front. It preserves the source geometry.
- `layoutRow({ count, footprint, gap, curve })` and `layoutGrid({...,
  columns})` return centered `{x,y,z}` positions. Footprint is the full,
  axis-aligned width/depth (a number or `{x,z}`), including rim thickness,
  rotation and animation excursions. Curve is `(x, row) => z`; grid rows
  expand around its excursions. Call `warnOverlaps(THREE, placedMeshes)` at
  author time to inspect actual transformed bounding boxes.
- Set `ctx.lens.ink = true` or `{ color, width, depthThreshold,
  normalThreshold }` in spatial sections. Width is in render pixels; depth
  threshold is relative view depth; normal threshold is one minus absolute
  normal alignment. Ink uses the nearest visible depth surface, after
  DOF/bloom and before grade/grain; the optical passes can be on or off.
  Never use inverted-hull outlines on thin or concave meshes.
- For a manual post stack, `createInkPass(THREE, renderer, options)` exposes
  `render(depthTexturedInputTarget, camera, outputTarget)` in linear color
  before the caller's grade/grain. Keep input and output distinct. Call
  `dispose()` when done. The spatial host fuses ink into its existing
  composite pass to avoid a second geometry render.

Render a seven-dish parabolic row at dusk from inside, outside and rim-level
views. Verify visible rim thickness, clear footprints, hidden-edge occlusion,
and ink with DOF/bloom/grade enabled and disabled before accepting a candidate.
