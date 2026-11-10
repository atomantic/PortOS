# Native playback for shipped-template composition previews

## Context

Decision record for #15618. The docked "Composition (live)" preview of a composition
document is drawn by a jailed local Chromium worker and streamed to the page as JPEG
frames (`useGeneratedPreview`, `CompositionPreviewPlayer`, "isolated preview" in
[HTML_COMPOSITIONS.md](../HTML_COMPOSITIONS.md)). Keeping that stream smooth has been
expensive: #15609, #15613 and #15616 were all defects of the frame pipeline, and on a
phone over the tailnet a 100 ms receipt-to-acknowledgement deadline is the weakest
link. The question was whether a document built from the shipped layered template
needs that pipeline to play.

**Decision: go, as a hybrid.** Play verified shipped-template documents with the
in-browser player that already exists, and keep the worker for exact frames and for
every document that carries authored code.

## What exists today

`StoryboardAnimatic.jsx` is already a native composite player. It is the "Storyboard
animatic" source in every render style and, with `variant="composite"`, the
"Composition (live)" source of the composed style (`PreviewDock.jsx`,
`liveCompositeSource` in `client/src/lib/musicVideoStages.js`). It reads the project's
scene list, never the document, and plays:

- each shot's selected clip in a muted `<video>` kept in step with the song's
  `<audio>` clock, with the shot on screen and the next two mounted and preloaded
  (`ShotClip`, `CLIP_PRELOAD_SHOTS`), including clip offset, speed and reverse;
- stills with their still move, image effects with end frames, and photo sequences
  (`ImageEffectStill`, `stillFrameTransform`, `scenePhotoSequence`);
- the video look, per-shot and per-camera looks, camera frame, overscan and on-screen
  display (`FilmLookFrame`, `shotFilmLook`, `cameraFrameCss`), and shot colour match;
- cut glitches and wipes on the frames the render paints them (`TransitionGlitch`,
  `WipeOverlay`);
- sung lyrics and the opening title card through the server's words-only page in a
  sandboxed iframe, the cold open, and the ending.

So the proposal in #15618 is not a new player. It is a routing change plus a parity
list.

## Why the worker exists, and where that reasoning stops

The worker gives three guarantees: generated HTML never runs in the user's browser,
project media is never fetched into a generated page, and the preview is drawn by the
engine the final render uses, so a paused frame is exact.

The first two are about authored code. A document whose `engine.js`, `index.html`,
helpers and fonts are byte-identical to the shipped layered template has none: that is
exactly what `adaptStagedDocumentPreview` (`documentPreviewPlayback.js`) already
proves before it admits the live path. The native player does not execute the document
at all. It renders project scene data with PortOS's own components, which is the
security posture the animatic has today. Nothing new is exposed.

The third guarantee is real and is the reason for a hybrid rather than a replacement.

## Answers to the four questions

**1. How much is already in the animatic, and can it take a document's scene list?**
Nearly all of the playback, and it needs no document scene list: both players read
the same project scenes. The document adds a drawing layer on top of those scenes
(next answer), not different media or timing.

**2. Which document features have no client-side equivalent?** From
`documentTemplates/layered/engine.js`:

| Engine behaviour | Native player today |
| --- | --- |
| Constant vignette (0.5) and grain (0.09) on every frame | Not drawn. Only the film look is. |
| Footage "breathes": slow dolly in, 8% over the shot from a 1.02 base (`GENTLE.footage`) | Clip plays unscaled. |
| Still moves through the camera rig (`moveFor`, `cameraView`), including planned `scene.camera` moves and on-beat snaps | `stillFrameTransform` covers hold, push and pan. Rig moves and beat snaps need checking against it. |
| Beat punch: up to 1.8% scale pulse on beats or downbeats | Not drawn. |
| Glitch on downbeats in high-energy sections (chorus, hook, drop, final, climax) | Not drawn. Selected cut glitches are. |
| HUD (corner marks, title lines, REC) when the document defines one | Not drawn. |
| Card scenes (`visualLayer: 'card'`) drawn by the template's card painter | Shown as label text or the lyric layer. |
| Narrative events and authored section functions | Not drawn. Authored sections exist only in generated documents, which stay on the worker. |
| Lyric type merged from hook cues and sung lyrics, drawn in canvas | Sung lyrics through the overlay page. Hook cue parity needs checking. |

None of these needs the worker. Each is deterministic drawing over media the page
already plays, and the rig, effect and lyric modules are already shared files.

**3. Is a hybrid acceptable?** Yes, and it is the recommendation. While the song
plays, show the native player. On pause, scrub, frame step and Save frame, show the
worker's exact frame. The worker session opens on the first of those, not on mount, so
a phone that only plays never starts a renderer. A visible difference between the
playing and paused picture is acceptable only while the parity list is open, and the
player says which engine drawing is missing, the same way it names unsupported effects
today.

**4. Does serving media to the page change the security posture?** No. The animatic
already loads the same clips and stills from the same routes in every render style.
The page still never loads the document or its assets.

## Plan

1. **Route** (#15619). In document mode, when the server reports the document as an
   unmodified shipped template, "Composition (live)" plays through the native player
   and uses the worker for exact paused frames. Any other document keeps today's path.
   The server already computes the admission; expose it on the project or preview
   response rather than re-deriving it in the client.
2. **Parity** (#15620). Close the table above in the native player, sharing the
   engine's modules. Order by how visible the gap is: base vignette and grain, footage
   and still camera moves, beat punch and high-energy glitch, cards, HUD, hook cues.
3. **Retire** the cooperative JPEG playback path for shipped-template documents once
   parity holds. Generated and customized documents keep exact-seek playback, which
   needs none of the presentation deadline machinery.

Until step 1 ships, a user who wants smooth playback of a document project can pick
"Storyboard animatic" in the dock's source picker. It is the same native player.

## Verification

- Phone measurement for step 1: play 60 s in WebKit at a phone viewport on both paths
  and record late or blank presentations per animation frame. The method used for
  #15616 (sample the visible element each frame) applies to the worker path; the
  native path is measured with `requestVideoFrameCallback` drift against the audio
  clock.
- Parity for step 2: for each row, a browser test that captures the native player and
  the engine at the same song frame and compares them within a stated tolerance.
- No change to final renders, which stay on the engine.

## Limits of this record

The feature table comes from reading the engine and the animatic, not from frame
comparisons. Rows marked as needing a check were not compared. No measurement of the
native player on a physical phone was taken.
