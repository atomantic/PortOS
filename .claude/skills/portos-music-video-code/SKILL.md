---
name: portos-music-video-code
description: Author and review a treatment-driven mixed-media music-video composition in PortOS.
---

# Mixed-media composition authoring

Use the Music Video **Compose → Document → Generate mixed-media composition** action after the song is analyzed, the treatment is approved, and each footage or still scene has a timed, selected local asset. The provider and model shown beside the button write only section drawing functions. No footage or still provider runs during this step. Missing selected media is a preflight error to resolve on the scene board.

PortOS assembles the functions into an immutable candidate version of its layered document. The active document remains selected while the candidate is previewed. Scrub the candidate through each section boundary, selected clip in-point and out-point, repeated hooks and lyric onsets; play it with the master song to judge movement and audio alignment. Accept the reviewed version to render it, or discard it. **Regenerate section** writes a new candidate with the same shared style contract and every other section unchanged. If the treatment, song, scene timing or selected media changed, generate a fresh candidate.

Author each `function render(ctx, env)` as a deterministic drawing function of song time. `env.t` is absolute song time; `env.localT` is time since this section began; `env.frame` is the integer frame for seeded motion. Use `env.song.beats`, `env.song.downbeats`, lyric word times, the safe inset and the approved palette. A seek to the same time must draw the same pixels regardless of prior seeks. Change repeated hook direction, staging or seed deliberately while preserving motif and color identity. Keep the host's lyric pass readable: leave negative space and avoid painting over words at the bottom of a scene.

The host draws selected stills and clips according to each scene's explicit visual layer, then invokes the section function. Add restrained graphics over those assets; for a card scene, draw the entire background. The host resolves only selected project assets and seeks video asynchronously using the chosen performance in/out edit. Do not use network requests, remote URLs, arbitrary paths, dynamic imports, clocks, entropy, or DOM loading in section code. PortOS stages local assets through `window.PORTOS_MV`, owns the sandbox, and renders previews, excerpts and final output from the same song clock.

Manual ZIP/folder documents and code-only videos have separate controls. The mixed-media action does not alter them until the generated candidate is accepted.


## Revisions and footage variants

Use **Fork vN** before revising a finished code video when the original must stay independently editable. For manual composition documents, **Export ZIP**, edit the HTML/JS locally, then import the revised ZIP/folder into the fork. Imports write immutable versions; unreferenced versions may be pruned, so fork before replacing a document you want to keep. Code-only sections also remain editable through the composition API and the section regeneration action.

Use **Fork for video generation** to adapt a code or document video into footage. It preserves song, analysis, timed lyrics, storyboard, parent/root lineage and immutable document/development artifact references. It starts in Composed mode with footage scenes, a fresh Cast & Sets stage and no selected mood board, reference images or video takes. Source publishing outputs and active runs are not carried into the fork. The source project is unchanged and forking calls no providers.

In the new project, choose the new mood board, prepare its photographic cast and set sheets, review the retained storyboard and prompts for the new medium, and select the image/video services and generation budget before starting production. Old sheets remain development references, not approval of the new cast. The original code document stays available for export or switching back to Document mode; retain the source project as the code version.
