---
name: portos-music-video-code
description: Author and review a treatment-driven mixed-media music-video composition in PortOS. Invoke when generating or revising a code, Canvas or Three.js composition document, its choreography plan, or its proof review.
---

# Mixed-media composition authoring

1. Analyze the song, verify its lyric timing or mark it instrumental, and save
   the treatment and visual guide. Save **Timed choreography and energy plan**
   in the art direction's motion-language field. Assign shot timing, musical
   anchors, subject actions, camera, readable type and transitions on the
   storyboard. Plan how repeated choruses develop.
2. Choose the media policy and renderer in **Compose → Document**. Code only
   uses procedural scenes, local fonts and master audio throughout, including
   guide frames. Canvas layered documents can use selected stills and footage.
   Three.js authored worlds use geometry and type. Select timed local assets
   on the Board before generating mixed media. Manual ZIP/folder import and
   native Code use separate controls.
3. Generate the document. Author deterministic `render(ctx, env)` functions:
   `env.t` is song time, `env.localT` is section time and `env.frame` seeds
   motion. Complete drawing synchronously. The host loads/decodes selected
   media and fonts. Use time and musical anchors for motion and maintain
   readable text over the planned action. For imported page code, complete
   asynchronous seeks before committing the visible frame. Use only staged
   assets and local dependencies. Start from the shipped layered or cel
   template for authored variants.
4. Scrub the candidate at boundaries, clip edits and lyric onsets. Play it at
   normal speed with the master. Accept the inspected candidate to replace the
   active version. Regenerate one section when the rest of the production
   basis is current, or generate afresh after treatment, song, timing or
   selected-media changes. Use **Fork vN** to preserve an independently
   editable original and **Fork for video generation** for a footage variant.
5. Watch a continuous chorus proof including its entry and exit. Compare
   energy, movement, transitions and audio anchors with the saved choreography.
   Record observed versus intended action at timecodes and revise weak ranges.
   Submit proof evidence only for the exact reviewed excerpt and filename.
   Use the machine proof contract in the Music Video guide if reviewing as an
   agent. Leave it pending when motion and audio alignment cannot be inspected.
6. Render final after the current review gates pass. Authenticated agents can
   review and prepare drafts within the configured grants and budgets. Public
   Suno publication and social posting require the human.

- [Music Video project and review contract](../../../docs/features/music-video.md)
- [HTML seek and render contract](../../../docs/HTML_COMPOSITIONS.md)
- [Composition routes](../../../server/routes/musicVideoComposition.js) and
  [staging metadata](../../../server/services/musicVideo/documentRender.js)
- [Layered engine](../../../server/services/musicVideo/documentTemplates/layered/engine.js),
  [cel template](../../../server/services/musicVideo/documentTemplates/cel/)
  and [shared lyric type](../../../server/services/musicVideo/documentTemplates/shared/lyricType.js)
