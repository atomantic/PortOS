# HTML compositions

Render a local, seekable HTML scene to a text-faithful H.264 MP4 without an AI
provider. Start the managed browser and install ffmpeg before submitting a job.
Chrome must support CDP hidden targets; unsupported browsers fail the job rather
than opening a visible tab.

Put `index.html` and its assets in a directory such as
`data/compositions/example/`. The page exposes:

```html
<div id="block" style="position:absolute;width:40px;height:40px;background:red"></div>
<script>
globalThis.portosComposition = {
  durationSec: 2, fps: 24, width: 1280, height: 720,
  async seek(t) {
    document.getElementById('block').style.left = `${t * 200}px`;
  }
};
</script>
```

`seek(t)` must finish all asynchronous work for that frame before resolving.
Drive animation from `t`, not wall-clock playback, CSS animation timers or random
state. The renderer awaits each seek, then captures frame `n` at `n / fps`.
The in-app live preview is different: the browser paints whenever `seek`
yields, so every `await` inside it can reach the screen. Load and decode first
(`await img.decode()`; for video, `seeked` plus a presented frame, as
`seekVideo` in the layered template does), then clear, draw and toggle layer visibility
in one synchronous block. A page that fills a canvas or flips `visibility`
before awaiting an image flashes that half-drawn state in the preview (most
visibly in iPhone Safari, which decodes slowly) while the render stays clean.
Duration is 1–120 seconds, fps is an integer from 12–60, and their product must
be a whole number of frames. Dimensions are exactly 1920×1080, 1080×1920,
1080×1080 or 1280×720. Invalid contracts name the field in the job error.

Submit `POST /api/html-composition/render` with:

```json
{"directory":"compositions/example","musicTrack":"example.wav"}
```

`musicTrack` is optional and names an existing Music-library file. It loops if
shorter than the video, is trimmed to duration, and fades out over the final half
second. A missing requested track fails the job.

Use `audioUpload: "example.wav"` instead to include a file from `data/uploads/`
with the same loop, trim and fade behavior. Choose one audio source per render;
missing files and unsupported audio formats fail the job.

For procedural music, submit `synthesizeMusic: true` instead of `musicTrack`.
Define `async portosComposition.renderAudio({ sampleRate, durationSec })` to return
an ordinary array containing exactly `Math.round(sampleRate * durationSec)` mono
PCM samples. The renderer supplies 24000 Hz and the video duration; every sample
must be finite and between -1 and 1, and the soundtrack must not be silent.
Use native `OfflineAudioContext`, deterministic JavaScript synthesis, or locally
available Tone.js/Strudel code capable of returning this contract. Convert an
AudioBuffer channel with `Array.from(buffer.getChannelData(0))`. Live browser
playback is not captured. The renderer writes temporary PCM WAV audio, muxes it
with the same tail fade, and removes the temporary file after completion or
failure. No music model, Python runtime, downloaded samples or music-library
write is required. Missing or invalid audio fails the job.

### Loudness mastering

Audio PortOS itself produces or mixes, a `synthesizeMusic` score or a
`musicTrack` or `audioUpload` bed, is mastered by default (#10249). The encode first runs an
ffmpeg `loudnorm` measurement pass over the trimmed bed, then applies it in
linear mode inside the same encode to **-14 LUFS integrated, -1.5 dBTP, LRA 11**
(`MASTER_LOUDNESS` in `server/lib/ffmpeg.js`). A bed that measures below -50
LUFS fails the job with a "Soundtrack is silent" error before any frame is
captured. After the encode the finished file is measured again, and the job result
and each Media History entry carry
`loudness: { integratedLufs, truePeakDb, loudnessRange, masteredFrom: { integratedLufs, truePeakDb }, targetLufs }`.
The launch-video panel and the Code Animation export show it as one line, for
example "-14.1 LUFS, peak -1.6 dB (was -27.3 LUFS)".

Submit `masterLoudness: false` to opt out: the bed is then muxed exactly as before
and no `loudness` is reported. A Music Video's exact master (`audio.path`) is never
mastered; when a sound-design bed is mixed under the song, the mix only ends with an
`alimiter` at the -1.5 dB ceiling, so the song's own level is unchanged.

SuperCollider is a planned optional native code-audio runtime, described in the
[integration decision](decisions/2026-10-01-supercollider-code-audio.md). It is not
currently installed or enabled by PortOS and cannot run through this JavaScript
PCM contract.

## Several formats from one timeline

One job can render the same composition at several aspect ratios, so a launch
posted to several platforms is one film recomposed per frame rather than one
agent run per format. The composition declares the extra sizes it supports and
an optional layout hook:

```js
globalThis.portosComposition = {
  durationSec: 20, fps: 24, width: 1920, height: 1080,
  formats: ['1920x1080', '1080x1920', '1080x1080'],
  async layout({ width, height }) { /* reflow type and UI for this frame */ },
  async seek(t) { /* same timeline in every format */ },
};
```

The render request names formats: `"formats": ["landscape", "vertical", "square"]`
(1920×1080, 1080×1920, 1080×1080). The renderer renders them in that canonical
order, in sequence, on the same page and frozen asset snapshot: for each one it
resizes the viewport, awaits `layout({ width, height })` when defined, then seeks
every frame. Duration, fps and timing are shared, and synthesized music is
rendered once and muxed into every format. A requested format whose size is
neither the composition's own `width`×`height` nor listed in `formats` fails
the job before any output, naming the missing size. Without `formats` in the
request, a job renders the composition's own size exactly as before.

Each format is its own Media History entry (`<jobId>-<format>`), all written in
one history update, so a job registers every format or none. The completed
job result keeps `generationId` as the job and names the first format in
`id`/`filename`/`thumbnail`, and lists all of
them in `videos: [{ format, id, filename, thumbnail, path }]`.

## Motion blur

Set `motionBlur` on `portosComposition` to blend sub-frames on fast moves.

- **Integer `1`–`4`** (default `1`): captures that many sub-frames spread over
  the whole frame interval and blends them with ffmpeg `tmix`. `1` is no blur.
  Fast moves show separated copies rather than a streak.
- **Object `{ shutter, samples, tolerance }`**: samples a centred fraction of
  the frame time, at `t = (n + (k/count - ½) · shutter) / fps`, and averages
  the sub-frames in linear light. `shutter` is 0.05–1 (default 0.5; 0.2 is a
  short filmic streak, 1 smears the whole interval). `samples` is a fixed
  count from 4–64 or `'auto'` (the default). `tolerance` is 1–8 levels out of
  255 (default 2).

`'auto'` starts at the frame's centre and refines 1 → 3 → 9 → 27 → 81 samples,
reusing every earlier sample. It stops when the worst 8×8 block of the new
average differs from the previous average by less than `tolerance`. A frame
whose centre matches both neighbouring frames' centres is still and costs a
single capture. The job result's `sampleHistogram` maps each sample count to
the number of output frames that used it.

Shutter blur relies on two scene rules:

- Output must be a pure function of `t`. Sub-frames are rendered out of order,
  may repeat, and the first frame's shutter clamps negative times to `0`.
- Per-frame flicker (grain, jitter, a random seed per frame) must stay constant
  across the shutter. Key it to `PortosMotion.frameIdx(t, fps)`, which rounds
  to the nearest frame, not to `Math.floor(t * fps)`.

```js
motionBlur: { shutter: 0.5, samples: 'auto', tolerance: 2 }
```

## Motion kit

`server/services/htmlComposition/kit/portos-motion.js` is a deterministic
helper script for compositions. Copy it beside `index.html`, load it with
`<script src="portos-motion.js"></script>`, and read `globalThis.PortosMotion`:

- `spring(t, stiffness, damping)` — closed-form damped spring from 0 to 1, a
  pure function of the time since the move started. `SPRINGS` holds
  `snappy`, `default`, `heavy` and `playful` presets.
- `track(t, [[time, value], ...])` — a value that retargets several times, as
  one spring per change, so motion never restarts or pops.
- `indicator(t, stops, width)`, `swapAlpha(t, tIn, tOut)`, `loopT(t, dur)` —
  stretching selection bars, content swaps inside a morphing container, loops.
- `frameIdx(t, fps)` — the output frame `t` belongs to, constant across a
  motion-blur shutter; key per-frame flicker to it.
- `rng(seed)` — seeded noise (mulberry32); never use `Math.random`.
- `beats(bpm)` — a beat grid (`at`, `bar`, `index`, `phase`, `list`).
- `song(audioAnalysis)` — seekable song lookups from a music-video project's
  analysis JSON: `env('rms'|'low'|'mid'|'high', t)` (interpolated 0..1),
  `hit('kick'|'snare'|'hat', t, halfLife)` (decaying pulses from past onsets;
  band heuristics, not stems), `beatAt`, `barAt`, `beatPhase`, `sectionAt`.
  `ready` is false when the analysis has no feature track (re-analyze).
- `renderCues({ sampleRate, durationSec, cues })`, `mixCues`, `toPcm` —
  synthesized `click`, `tick`, `pop`, `thump`, `whoosh` and `riser` cues
  that return the plain PCM array `renderAudio` needs.

Launch-video runs start with the kit already copied into their composition
directory. It is ordinary UTF-8 source, so it passes the launch asset gate.

## Proof renders (contact sheets)

Add `proof: { everySec: 1 }` (0.25–10 seconds) to the render request to get a
silent contact sheet instead of a video. `proof.format` (`landscape`,
`vertical` or `square`) checks one declared framing, running `layout` first;
a proof request cannot also carry `formats`. The renderer applies the same contract
and launch-video gates, seeks one frame per interval (at most 60), and tiles
them six across at phone size (360px wide, 240px for vertical) into one PNG.
A proof is silent, so the request must omit `musicTrack`, `audioUpload` and
`synthesizeMusic`. Nothing is registered in Media History and no
launch-video artifacts are delivered. The completed job's result carries
`proof: { file, url, times, columns, width, height }` (plus `format` when one was requested), where `file` is
relative to the data directory (never an absolute host path) and `url` serves
it under `/data/`; tile *n* shows `times[n]`.
Launch runs write `proofs/contact-<jobId>.png` beside the run; other
compositions write `data/composition-proofs/`. Both are excluded from backups. Code Animation exports stage `data/code-animation-exports/<job-id>/<export-id>/` (also excluded): the stored HTML with a shim that maps `ANIMATION_META`/`renderFrame(t)` onto `portosComposition`, stops the page's own `requestAnimationFrame` clock, and hides everything but the film canvas.

Code Animation includes the saved audio automatically: Music-library and generated
soundtrack files use `musicTrack`, while uploaded audio uses `audioUpload` (a
filename in `data/uploads/`). Both loop and trim to the video length with the
same half-second tail fade and loudness mastering. Missing or unsupported audio
fails the export. Procedural Web Audio playback is still excluded from
frame-exact exports; its export note explains how to attach a soundtrack.

The 202 response contains the media queue's `jobId`. Subscribe to
`GET /api/html-composition/:jobId/events` for the usual queued, started, progress,
complete, error and canceled SSE frames. Cancel through
`POST /api/html-composition/:jobId/cancel` or the existing media-job controls.
Jobs use the serialized local lane and are never offered to a federated peer.

The renderer snapshots local assets (up to 256 MiB / 4096 files), rejects
symlinks, and fulfills requests from that snapshot at a virtual HTTPS origin.
Use relative asset URLs. Nothing is served by a new HTTP listener. A fresh,
hidden browser target has no access to the operator's normal browser context.
Network URLs, missing assets, frames, workers, popups, WebSockets and WebRTC are
refused; a refusal fails the job instead of silently dropping content. Browser
disconnects, failed encoding and cancellation remove partial outputs. Cancellation
is refused once the final history write has begun.

Successful outputs have BT.709 tags, fast-start MP4 layout, and a thumbnail in
Media History. Source compositions are externally editable files, not a new
relational store. Outputs and job state use the existing video-history and media
queue storage contracts; no new JSON store, migration, seed or sync channel is
introduced. Source files under `data/` follow the existing backup filters.

The real-browser contract suite in
`server/services/htmlComposition/index.test.js` needs Chrome and ffmpeg. It uses
a temporary browser profile and data root, never the live managed browser.
Set `CHROME_PATH` when Chrome is not in a standard location. The suite skips
explicitly when either binary is unavailable; route and queue tests still run.

## Music-video typography overlays

A Music Video project whose composition manifest is in `composed` mode
(#8984) renders its timed text cues through this same sandbox. PortOS writes a
generated overlay page (`server/services/musicVideo/composition.js`) to
`data/music-video-compositions/<jobId>/`, opens it with the composition
browser on a transparent background, and captures only the time ranges where
text is on screen into alpha overlay clips. The music-video renderer then lays
them over the cut footage in its single ffmpeg pass, so the song remains the
only audio. A cue's state at a time is a pure function of that time
(`cueStateAt`), and text is kept inside a 10% title-safe inset at any aspect.
The scratch directory is removed when the render ends, swept at boot, and
excluded from backups.

With timed lyrics and no Subtitle text cues (Hero cues are titles over the
words, not a stand-in for them), a composed render also draws the sung lyrics
in the shared lyric type, exactly as the storyboard animatic shows them: it
stages the animatic's lyric overlay page (`documentTemplates/lyricOverlay`)
beside the typography page and captures it over each line's window
(`composedLyricWindows`, the first onset to two seconds past the line's end).
Each shot's lyric placement, style and size apply; a title card shot already draws its
text (else its sung line), so the overlay keeps its lines off it. A Subtitle cue hands the words
back to the text cues, so "Copy timed lyrics" swaps the lyric type for plain
subtitles.

A composed render also honors each scene's visual layer (#8985): its
generated footage (the default), its selected still frame with a deterministic
hold, push-in or pan, or a title card — a solid colour whose text is drawn by
the same typography overlay for exactly that section. Still and card sections
need an authored start/end instead of a clip, and every section is cut to a
whole number of frames on the song's timebase, so the edit never drifts from
the authored timeline. A plain concat render ignores the layer and plays
footage, exactly as before.

A project's pre-production **treatment** (#8980,
`server/services/musicVideo/treatment.js`) plans for this layer instead of
fighting it. Each directed shot names a typography role (none, subtitle,
hero) and a reserved region (upper third, center, lower third); applying the
treatment adds that region to the scene's frame and motion prompts as clean,
low-detail negative space and asks the image/video model for no lettering, so
the generated picture leaves room for the composited text rather than baking
text into pixels. Apply can also add text cues from the timed lyrics, placed
in each shot's reserved region; it never switches the render to `composed`.
Apply also maps direction onto the scene's own render fields, but only while
they are still at their defaults: a shot routed to 2D/code motion becomes a
title card carrying its first sung line (or a pushed-in still when it has no
line), and a performance shot becomes a `performance` shot mode only when the
project's video backend has a source-audio lip-sync lane (fal.ai today).
The treatment's proof checklist treats readable text and audio alignment as
judgeable only in the final render.

## Music-video render grades

In **Compose → Render grade**, explicitly choose Neutral, Teal night, Golden
hour, or Monochrome, with an optional per-section override and bounded grain.
The selection is stored in `composition.grade`; clones remap section overrides
to their new scene IDs. Neutral is the default and a true filter bypass. A
neutral section override disables the default look for that section; resetting
to neutral clears every override. Grades affect composed and document exports,
not plain footage or code-rendered mode. The live document preview is ungraded;
render an excerpt to judge the selected look.

Both encoders use the same bounded RGB curves and deterministic, song-time
frame-addressed grain. Composed footage is graded before typography, and
excerpt trimming happens after grading. Document captures receive the same
filter before encoding, with the excerpt offset and document frame rate, so
section changes and grain stay on the song clock. Black/white endpoints are
preserved to keep document lettering readable. Source assets are unchanged;
selecting a grade does not infer a look from references or invoke a provider.
Saving the selection gates rendering until the server has accepted it.

See the [synthetic visual validation and remaining acceptance](validation/9302-music-video-grade.md).

## Music-video film look

A finishing filter for the analog, imperfect feel image and video models rarely
give on their own: soft focus, halation, color bleed, grain, fade, a color cast,
split toning, vignette, light leaks, gate weave and flicker, plus the film
emulation tools a grading plug-in like Dehancer centers on: a per-channel print
response (**Film color response**, dye crossover toward cyan-green shadows and
amber highlights), **Halation spread**, a sharp-center **Lens fall-off**, and
for tape a sideways **Tape softness** and a **Tracking** strip with dropouts.
These are version-2 controls (`since: 2`); a version-1 look draws byte-for-byte
as before, and in version 2 a light leak fogs in from the frame edge. One definition in
`server/lib/filmLook.js` (`FILM_LOOK_CONTROLS`, `FILM_LOOK_PRESETS`,
`filmLookFilterMarkup`) serves three surfaces, so what is tuned on a still is
what the preview shows and what the render bakes:

- **Compose → Film look** stores the look on the project (`project.filmLook`,
  validated by `filmLookValidation.js`, normalized by `normalizeFilmLook`).
  Every slider move reaches the docked live preview at once; releasing a
  control saves. `null` is the bypass.
- **The image viewer (Film look)** on any gallery image, Cast & sets plate or
  mood-board still previews the same filter in the browser and **Save filtered
  copy** bakes it server-side (`POST /api/image-gen/:filename/film-look`,
  `services/imageGen/filmLookBake.js`) into a new image beside the untouched
  original, grouped with it like a cleaned copy. Inside a music video project
  the editor also offers **Use on project**.
- **The final render** installs the same runtime in every worker browser
  (`documentRenderInitScripts` → `openComposition({ initScripts })`), so the
  split render (#10365) and the overlay text probe see the filtered page. The
  code-rendered style takes the same scripts. A **footage render** (the
  composed or plain-cut ffmpeg encode, final or excerpt) gets the look as a
  **finishing pass** (`services/musicVideo/filmLookFinish.js`): the finished
  MP4 plays full-frame in a one-video page in the composition browser, the
  shared encoder captures it frame by frame on song time, and the render's own
  audio is copied back untouched. Paid clips are never regenerated to change
  the feel. The pass takes the second half of the render's progress bar and a
  cancel aborts it.
- **Composed final renders go shot by shot** (`services/musicVideo/shotSegments.js`).
  Each section of the cut is a cached segment in two stages: the base (its
  frames from `buildMusicVideoFfmpegArgs`' `segment` mode, which draws the same
  chain the whole-film graph draws there, cut effects borrowing the next shot,
  fades, grade, glitches and the typography over it) and the look (the base
  through the shot's film look on song time). A shot may keep its own look
  (`scene.filmLook`; `null` follows the video's). A look change redoes only the
  look stage of the shots it reaches, a shot change only that shot (and a
  neighbor whose cut effect reads it). The shot card's **Final render** row
  renders one shot now and plays it silent; **Render final** renders whatever
  is missing, joins the segments by stream copy and lays the song under them.
  Segments live in `data/music-video-segments/<projectId>/`, machine-local and
  excluded from backups; publishing a final render drops ones it no longer uses.
- **The composition document preview** carries playback mode with each seek
  into the OS-isolated preview worker. Playing frames use the same lightweight
  motion layers as the animatic: CSS focus/tone/saturation and weave on the
  root, with pointer-transparent overlays above document and lyric layers.
  Noise tiles are rasterized once into canvases from trusted inline filters,
  preserving the worker's image restrictions. Each overlay blends directly
  with the document and preceding layers rather than an isolated overlay group.
  Pause, scrub and frame stepping restore the exact SVG filter. This mode is
  preview-only; final renders remain exact and generated HTML stays isolated.
- **The storyboard animatic** (the docked preview for footage projects) shows
  the look live over the whole picture, lyrics included, on the song frame.
  Paused, that is the exact filter; **while the song plays** it is the light
  playback version (`filmLookMotionLayers`, `FilmLookFrame.jsx`): a browser
  re-runs an SVG filter chain over every decoded video frame, and the full
  look took a phone's animatic from 30 fps to under 1 after #11215. The playback
  version is compositor-only: CSS filter functions for focus, tone and
  saturation, the gate weave as a transform, and the cast, grain, tape bands,
  vignette and leak as blended overlays (the noise rasterized once as tiles
  and shifted per song frame). The glows, fringing and split tone wait for the
  pause. The **Film look** button under the animatic turns the preview look
  off for that viewer (remembered on the device); the render still applies it.

The filter is an SVG `<filter>` applied to the document root (or to the
`<img>` for a still). Radii and offsets scale with the filtered element's
width, so a 390px phone preview, the 1920-wide render and a 4K still read
alike. Every time-varying effect (grain seed, gate weave, flicker, light-leak
drift) is a pure function of the song frame, so the four render workers agree
and a still is one bake. `filmLookRuntimeSource()` inlines the markup function
by `toString()` into sandboxed pages, which is why `filmLookFilterMarkup` must
stay self-contained; the runtime wraps `portosComposition.seek()` to advance
the frame before the page paints. A neutral look emits no filter at all.

**Continuous film motion vs timed film events.** The look's *Continuous film
motion* group holds gate weave and flicker plus their speeds (`weaveRate`,
0.25–3, and `flickerRate`, 0.1–1, both defaulting to 1): a speed multiplies the
song frame the drift is computed from, so it never moves a shot or the audio,
and a look saved without them draws exactly as before. The *Home movie* preset
is the restrained starting recipe (slow weave, a breathing flicker). Timed film
events are each shot's **Effects** (`scene.glitches`, `musicVideoTransitions.js`):
a gate jump, shutter, film burn, light leak or any glitch at a moment, each with
an optional `strength` (0 switches it off, 1 or absent is the style as declared),
a repeat (`count` plays, `everySec` apart on the song clock, never past the
shot), and for a light leak a `color` and entry `edge`. `glitchFrameParams` turns
those into the frame both the animatic canvas and the ffmpeg chain paint, so a
scrub, an excerpt and the full render meet each repeat on the same song frame.
The shot card's **Home-movie events** adds a half-strength gate jump every 3 s
and one soft warm leak.

Each control names its effect in photography terms, and the **In a prompt**
box rewrites the current settings as the words that ask a model for the same
qualities (`describeFilmLook`), so tuning a look also teaches the vocabulary
for the next generation prompt. A composed project's render grade (above)
still applies inside the ffmpeg encode; the film look follows it.

## Music-video opening title card

The MTV-style credit block a video opens with: song title, artist, year and an
optional extra line (album, director), fading in over the opener and out again.
**Look → Opening title card** (under the docked preview) stores it on the project (`project.titleCard`,
validated by `musicVideoTitleCardSchema`, normalized by `normalizeTitleCard` in
`server/lib/musicVideoTitleCard.js`; `null` = none, `enabled: false` keeps the
text). Turning it on fills the song title (the project name without its version
suffix), the artist named for DistroKid under Where you post, this year, and a
window that ends half a second before the first sung line. Timing (in, out,
fade), position (four corners, bottom centre, centre), font, size, look and
colors are all editable. Fonts are the lyric type's Archivo, Helvetica, serif,
Plex Mono, and six bundled OFL faces (`TITLE_CARD_FONT_FACES`: Oswald,
Audiowide, Orbitron, Righteous, Pacifico, Playfair Display, files and licences
in `server/services/musicVideo/titleCardFonts/`), picked from swatches drawn in
each face. Text is drawn exactly as typed;
the panel flags a sung line that starts while the card is up and offers to end the
card before it. **Also at the end** (optional, off by default: `outro`) shows the
same card again in its own window (`outroStartSec`–`outroEndSec`, song time);
turning it on times that window from the song's length (`titleCardOutroWindow`:
as long as the opening one, ending a second before the song does). The runtime's
fade covers both windows, and a composed cut gets one capture cue per window
(`titleCardWindows`). While the card shows, a lyric line in a default zone that
would collide with the card's corner steps across the frame (a lower-left card
sends it to the upper left); a Text zone set on the line's shot stays as set.

The card is not part of the composition document. `titleCardRuntimeSource()`
is a page script installed beside it, in the live preview's head (live edits
arrive as `portos-mv:title-card` messages) and in every render browser
(`documentRenderInitScripts`). It draws on its own canvas fixed over the page,
fitted to the render's aspect, registers the bundled faces from data URLs
embedded in the script (`services/musicVideo/titleCardFonts.js`, so every page
draws the same face whatever it declares itself), and wraps `portosComposition.seek()` (chaining
the film look's wrapper) so the card is drawn for each frame after its faces
load. It has two looks (`style`). `outline` follows the lyric type: cream fill, ink
outline, no plate. `mtv` is the classic lower third: the artist over the title, on a dark translucent plate with a colored bar on its leading
edge (`accentColor`, cyan by default) and the title in `titleColor` (yellow by
default). Both sit inside the same title-safe insets, and a block wider than
its zone shrinks rather than running off frame. Like the lyrics it sits under the film look. It also rides
on the lyric pages (the lyric-timing playthrough and the lyrics laid over the
storyboard animatic, which carry no film look), so it can be checked against
the timed words before the composition exists. A composed render (`composition.mode:
'composed'`) and its draft excerpts draw it too: `projectTypographyPlan` adds a
text-less `title-card` cue, and `buildTypographyDocument` installs the same
runtime on the transparent overlay page captured over the cut.

## Music-video composition documents

A Music Video project can own its whole edit as a composition document: set
the render style to **Composition document** (`composition.mode: "document"`)
and start from the shipped `layered` template, import a `.zip`, or copy a
folder that already sits inside `data/`. Each import is an immutable version
folder under `data/music-video/<projectId>/composition/`; imports refuse
symlinks, special files, traversal names and the reserved names below
(`server/services/musicVideo/compositionDocument.js`). Routes, all under
`/api/music-video/:id/composition/document`: `GET` (manifest), `POST /zip`
(multipart `file`), `POST /directory` (`{ directory }`), `POST /template`
(`{ template: "layered" }`), `GET /export` (zip), `GET /preview`,
`GET /file?path=` (one document file, served inert), `DELETE` (detach).

Every render of the project — the final render, a draft excerpt, its contact
sheet and the auto-review excerpt — copies the document into a job-private
folder under `data/music-video-song-renders/<jobId>/` and adds, before the
snapshot freezes (`server/services/musicVideo/documentRender.js`):

- `portos-mv.js` — `window.PORTOS_MV = { project: { id, name, aspect }, render:
  { width, height, fps, frames, durationSec }, song: { durationSec, bpm, beats,
  downbeats, sections, words }, lyrics, lyricMarkers, scenes: [{ sceneId,
  label, startSec, endSec, shotMode, visualLayer, stillMove, cardText,
  cardColor, textZone, lyricRole, lyricSize, lyricText, direction, media: { kind, src, inSec, outSec, fps,
  width, height } | null }], titleCard: { position, windows: [{ startSec, endSec }] }
  | null, textCues, composition: { mode, style, posterSec, overlay } }`. Load it with `<script src="portos-mv.js">`; the sandbox
  refuses `fetch`.
  A shot's `speedFps`/`offsetFrames` are baked into the staged clip, so a render
  seeks `media.inSec + (t - startSec)`. The live preview bridges the original
  bytes instead: its `media` keeps source-time `inSec`/`outSec` and adds
  `timing: { rate, leadSec, startSec }` (only for a retimed shot), and the page
  seeks `startSec + max(0, (t - scene.startSec) - leadSec) * rate`.
- `song.json` — the same song block the code-rendered mode reads.
- `media/scene-<sceneId>.<ext>` — each scene's selected take (its clip when
  it has one, else its still), named by `scenes[].media.src`.

Staged audio/video is streamed from disk by byte range rather than held in
memory, so a song's worth of footage fits. The document stays on song time:
an excerpt seeks the same song times as the full render (`startSec + n / fps`,
snapped to the frame grid). The picture is captured silent and the master song
(plus the optional sound-design bed) is muxed under it. The project's aspect
ratio picks the frame; a page authored at another aspect must list that size
in `portosComposition.formats` (its `layout({ width, height })` hook
reframes).

**Social cuts (#9280).** A draft excerpt can render at another frame than the
project's: `POST /api/music-video/:id/excerpt` takes `aspect` (`16:9`, `9:16`,
`1:1`) and `fade` (fade-in 0.08 s and fade-out 0.6 s on the excerpt's audio).
The render re-frames the project for that one job, so `PORTOS_MV.render` and
`PORTOS_MV.project.aspect` report the cut's frame, and the page must declare
that size in `formats` (or read its size from `PORTOS_MV.render`). The stored
project keeps its own aspect, and the excerpt records `aspect`, `fade`, `width`
and `height`. Footage (ffmpeg) projects refuse a re-framed cut
(`EXCERPT_ASPECT_UNSUPPORTED`), because cropping their 16:9 frame slices
through the type layers. `GET /api/music-video/:id/social-cuts?count=&minSec=&maxSec=`
suggests hook windows: sung lines, lip-sync coverage, chorus sections,
loudness and the title lyric, returned as non-overlapping `{ startSec, endSec,
score, label, reasons }`. The Review stage lists them with a one-click
"Render 9:16".

A `seek(t)` that rejects — for example a `<video>` that failed to
seek — fails the render and names the frame. A page that draws `<video>`
frames must await `seeked` before painting; the template seeks to the middle
of the source frame so a frame boundary can never round to the previous one.

The shipped `layered` template (`server/services/musicVideo/documentTemplates/layered/`)
draws each scene's take with a gentle camera move and beat punch-ins, film
grain and a vignette, a title card for card scenes, kinetic lyric type (the
subtitle text cues, else the timed lyrics, plus hook slams for cues flagged
`hero`) through the shared lyric-type module below, and an optional HUD from
`composition.overlay` (title lines, a meter with keyframes, a ticker,
timecode). It declares all three frame sizes. Its fonts (IBM Plex Mono, IBM
Plex Sans Condensed, Big Shoulders Stencil Display, Archivo) are SIL Open Font
License; the licenses ship beside them. Once copied into a project the files
are the project's to edit — project-specific cards belong there, not in the
template.

### Shared kinetic lyric type (`lyricType.js`)

Any composition document can draw its sung words with one consistent look
instead of writing its own type engine
(`server/services/musicVideo/documentTemplates/shared/`):

```js
import { createLyricType } from './lyricType.js';
const lyricType = createLyricType(window.PORTOS_MV);
await lyricType.ready;
// each frame, after the picture:
lyricType.draw(ctx, t, { width, height });
```

Link `lyricType.css` from the page for the bundled faces (Archivo variable
widths and IBM Plex Mono, OFL licences in `fonts/`). When a stored document
references `lyricType.js` or `lyricType.css` without shipping them, PortOS adds
its copies and the faces at the document root; a document's own copy is kept.

Lines come from `PORTOS_MV.lyrics` with their aligned word times (or
`options.lines`), and every timing is read from the song data. Each line gets
one of four roles: `line` (default sung line: words rise and fade in on their
onsets, the line drifts up and fades 0.3s after its last word ends, but never
before that word has shown for 0.8s), `hook` (wide
caps centred in the zone, the lower band unless the shot names one, each word
slams in on its onset, one outline-only accent word with ink beneath its light
outline, cut on the next beat; a chorus phrase slams the first time it is sung
and its repeats come back as sung lines unless `hookRepeats: 'hook'`),
`stamp` (a three-frame stamp with a small tilt, optional strike-through) and `data` (mono HUD caption whose numbers roll;
at most one per shot). A per-line override or the line's own `role` wins,
then the shot's `lyricRole`, then the lyric sheet: the line's `lyricMarkers`
delivery direction (spoken/shouted lines stamp), else its section header
(choruses, hooks, refrains and drops are hooks), else `line`. Each shot's `textZone` (the corners `upper-left`, `upper-right`,
`lower-left`, `lower-right`, centred `upper` / `lower`, `center`, or `none` to
keep the shot clear) places the words so they never cover the subject, and its
`lyricSize` (`small`, `large`, or null for normal; `LYRIC_SIZE_SCALE`) scales the
type and its share of the frame, never below the floor. A line never shows before its first word onset, stays at
least 0.8s, and sung type stays at least 56px at 1080p. Type stays out of the
picture's way: one caption covers at most 6% of the frame (hooks 10%, data
readouts 4%; `LYRIC_FIT`) in at most two balanced rows, shrinking to fit but
never below that floor. Palette tokens
(`fill`, `ink`, `accent`, `strike`), fonts and an optional ink-boil jitter are
options. Upgrading a pre-module layered engine adds the module's two tags in
front of the template's engine tag.

The in-app composition, code-video, and code-animation previews do not run
generated HTML in the user's browser. A private local Chromium worker executes
the page and returns JPEG frames (and, for a recording, the finished WebM).
The worker is wrapped in macOS Seatbelt (`/usr/bin/sandbox-exec`) or Linux
bubblewrap (`/usr/bin/bwrap --unshare-net`). Seatbelt denies IP sockets, then
allows the browser's own Unix sockets so Chrome can start, and denies the
system resolver socket (`/private/var/run/mDNSResponder`) plus the DNS mach
services. Bubblewrap's empty network namespace blocks direct UDP and TCP, and
existing host resolver sockets are covered with `/dev/null`. Chrome's own
process sandbox cannot initialize inside that jail (`sandbox_init` returns
EPERM and the renderer crashes), so the worker starts with `--no-sandbox`.
The OS jail is the egress boundary. Windows, Firefox,
and WebKit have no such jail: the preview shows an explicit unavailable state
and does not fall back to an iframe. Chrome's HTTP proxy is not the boundary.
A fresh srcdoc realm can still open WebRTC; the OS deny is what stops UDP,
HTTP, and navigation. The egress test drives a real local STUN, HTTP, and
WebSocket collector, including a nested srcdoc, and treats a silent negative
control (no jail) as an invalid proof. DNS is not proven by binding port 53.
On macOS the same profile must make `getaddrinfo` fail for a name that resolves
outside the jail, because the system resolver would send that query itself.

Seek, film look, and the title card go over the private render protocol.
Project media stays on the server (`streamMedia`); the client never fetches it
into the page. Exact document or job revisions retire the previous worker.
Closing the session kills the browser process group and deletes the scratch
directory under `music-video-song-renders/`.

During cooperative playback, the viewer presents valid images in arrival order
with at most two pending images and one presenting image. Actual visible-image
decode and one animation-frame opportunity precede the next presentation task.
Queued images cannot replace that current image early. A 100 ms receipt-to-
acknowledgement deadline and queue bound stop the preview clearly when the
consumer cannot keep up; intermediate images are never silently discarded.
This adds bounded viewer latency without changing the source/audio clock.
Pause, scrub, visual controls and session changes retire pending work; exact
images keep their generation rules, and Save frame uses the actual known
decoded current image. URLs retire after their DOM references. Native cadence,
lag and drift still require measured evidence for the particular source.

New Canvas and Three.js candidates generated by PortOS package this complete-frame
producer automatically. The host awaits packaged fonts and any selected media,
draws with the existing renderer into private surfaces, and commits only the
finished frame. Three.js retains its scene, text and lens passes and exact
subframe timing outside narrative holds. Section functions must finish synchronously before returning;
Promise/deferred drawing and retaining `ctx` violate the generation contract.
The packaged `engine-reference.js` retains the original renderer for comparison.
Existing generated, imported and customized documents keep their existing path.

### Optional authored complete-frame playback

A custom music-video document can explicitly supply a cooperative producer
without PortOS rewriting its engine. Ship `preview-playback.json` beside
`index.html`, containing exactly:

```json
{"version":1,"contract":"portos-complete-frame-v1"}
```

Before document readiness, install an own `previewPlayback` data property on
`portosComposition`. Its own data properties declare `version: 1`, `fps: 30`,
`presentation: 'atomic-canvas-v1'`, and `mediaTiming: 'staged-output-v1'`, and
provide the methods below. PortOS snapshots and binds the methods with their
original receiver once. Replacing the public API later cannot redirect calls.

| Method | Input | Successful result |
| --- | --- | --- |
| `clock()` | None | Synchronous, finite, nonnegative, nondecreasing `performance.now()` milliseconds |
| `prepare(input)` | `{epoch, sequence, t}` | `{epoch, sequence, status:'prepared', t}` with the requested values |
| `play(input)` | `{epoch, sequence, t, workerTime}` | `{epoch, sequence, status:'playing'}` |
| `sync(input)` | `{epoch, sequence, t, workerTime}` | `{epoch, sequence, status:'accepted', driftSec?}`; optional drift is finite |
| `pause(input)` | `{epoch}` | `{epoch, status:'paused'}` after all owned work retires |
| `dispose()` | None | Release author-owned resources; host closure also destroys the owned page |

Replies have no extra fields. `play` may instead return `resync-required`,
`superseded` or `stale`; `sync` may return `resync-required` or `stale`, retaining
the same correlation fields. A current operation that reports stale/superseded
requests synchronization. The host's bounded resynchronization policy still
applies. Operation sequence and captured-frame sequence are separate values.

The producer owns atomic visible commits: finish source/font/image preparation
and every asynchronous drawing dependency before publishing the complete frame
in one synchronous task. Retained callbacks must not mutate the visible document
after publication or pause. Honor the request's epoch/sequence and cancel stale
work before it can publish. Use the staged `PORTOS_MV` media timebase, applying
rate/lead transformations once; keep original song time separate from quantized
or held drawing time. Advance the film-look and title finishing hooks from song
time, preserve lyric stacking and pointer behavior, and keep exact `seek(t)`
consistent with paused/scrubbed frames and the final renderer.

The synthetic reference in `server/test/authoredPreviewFixture.js` packages its
own scheduler and complete-frame bridge, with asynchronous source preparation
and a deliberately limited, checked source mapping.

Declaration and handshake are an author's promise of this behavior. They do not
prove arbitrary JavaScript purity, isolate same-realm canvas/DOM effects, certify
untracked embedded media, or establish content throughput. The host enforces
method shape, correlation, clock checks, queue ordering and deadlines: clock,
play and sync have 1.5 seconds; prepare and pause have 3 seconds. It gates frames
immediately before retirement. An invoked producer that fails, exceeds its
deadline or returns an invalid reply loses the owned page; uncertain work never
continues into exact rendering on that page. An explicit reopen is a new session.

Missing declarations preserve the existing canonical recognition/exact path.
Present malformed, unknown or incomplete contracts retain exact fallback without
source rewriting. Eligibility still requires the verified Chromium 155+ capture
baseline, native video-frame request/cancel callbacks, and trusted finite selected
video cadence above 10 fps. This does not establish 30 fps for every source or
document, 1080p/4K decoding, GPU presentation, or audible A/V synchronization.

Previously generated documents with older or customized engines are not
automatically opted in. Their hosts may ignore section Promise returns;
rewriting them would change historical semantics. Generate and accept a new candidate
to use the current generation contract. Custom authors implement the API and
re-import; historical engine adoption remains an explicit version change.

Two limits stay explicit. The lyric-overlay animatic still mounts the shipped
lyric template in an iframe because the storyboard has to show through it; that
template is not given private media. Final MP4 encodes still use the existing
owned Chromium with HTTP interception, not this OS deny. Authenticated agents
keep the same preview authority as the signed-in user.

Inside the worker the page still seeks with `portos-mv:seek`. Assign a media
`src` when a frame needs the file. The server stages that file; the user's
browser only receives the rendered frame.

Bound your own decoded-image cache the same way. A decoded 2048×1152 frame
costs about 9 MB however small its JPEG is, so a cache of 90 atlases can hold
most of a gigabyte, and iPhone Safari reloads the tab ("A problem repeatedly
occurred") or purges and re-decodes images mid-playback. Keep a few seconds
around the playhead (for example the current frame plus the next one or two
seconds), release the rest by dropping their `Image` objects, and decode the
next frame inside `seek` before drawing it.

## Launch-video admission (API foundation)

`POST /api/html-composition/render` accepts `launchVideo: { targetDurationSec: 20 }`.
This option is required for directories rooted at `launch-videos/` and can also
be applied to other composition directories. An app's **Launch Video** tab
(`/apps/<appId>/launch-video`, also linked from Overview) queues a user-triggered CoS task with
tone, direction, one or more formats (landscape, vertical, square), duration (15–120 seconds), an optional **Dynamic motion
graphics** style, optional generated original
music or an existing Music-library track (each listed with its filename and an
inline audio preview), and an optional
provider/model/effort pin (Auto uses the normal CoS provider selection).
Closing its drawer does not cancel the run; use CoS agents to follow or cancel it.
Overlapping submissions for the same app are refused until its task settles.
No schedule or boot-time provider call is installed. Generated music is explicitly
opted into for this run. **Music creation** offers **Agent composition**
(`musicMethod: "agent"`, the default) and **Configured music service**
(`musicMethod: "service"`). Agent composition writes an instrumental score using
the PCM contract above, so absent music engines do not block it. The service
option selects a ready music engine, writes an instrumental prompt, waits for its
media job, and passes the resulting library filename to the renderer. An explicit
service choice still reports missing setup rather than silently changing methods. Shorter music beds loop to fill the video. A generation
failure is reported instead of silently dropping the soundtrack.

**Motion style** (`motionStyle`) picks the film's grammar: `walkthrough` (the
default: a paced tour of the key flow), `showreel` (beat-cut kinetic type,
color-field swaps and generative geometry around the key flow) or `ui-morph`
(one container that never cuts, morphing through the product's states on a
120 BPM beat and looping seamlessly). The legacy `motionGraphics: true` means
`showreel`. Every style carries house rules: springs instead of easing curves,
a hook in the first two seconds, something new every two to four seconds, one
accent color, and no centered-title-on-gradient, fade-everything, corner-label
or frame-border defaults. The same privacy and reading-time gates apply, so
every kinetic word is a storyboard line with a readable hold.

**Critique rounds** (`critiqueRounds`, 0–4, default 2) make the agent render a
proof contact sheet, score its own frames (hook, phone readability, variety,
composition, brand accuracy, storyboard fidelity), log the three worst problems
in `plan.md`, fix them and proof again before the final render, stopping early
when every score reaches 8.

**Consult motion skills** (`motionSkills: true`) is offered once
`npm run setup:motion -- --skills` has installed any skill pack. The server
resolves the installed skill names and refuses the option when none are
present. Skills are technique references only: the run still produces the
`portosComposition` contract and renders through PortOS.

The task supplies the selected app repository and process ports separately from
the PortOS media API origin. Product evidence comes from that repository; PortOS
serves only as the orchestration/rendering service unless it is the selected app.

App runs pass `appId` and `runId` together in `launchVideo`, with directory exactly
`launch-videos/<appId>/<runId>/composition`. The run is pinned to this instance.
On success, the renderer exclusively creates `plan.md`, `storyboard.json`,
`caption.txt`, `video.mp4` and `poster.jpg` beside `composition/`, using the
validated in-memory source snapshot. A run that asked for several formats
(`formats` on the launch-video request; the older single `format` is a
one-item list) gets one composition written against `layout`, and its render
delivers `video-<format>.mp4` and `poster-<format>.jpg` per format with the
plan, storyboard and caption once. Every format's history entry carries the
same `launchVideo.runId`, and the privacy and storyboard gates run once per job
on the frozen assets. A revision re-renders every format its source run
delivered. Media History retains its normal video
and thumbnail copies with app/run metadata. The Launch Video tab previews the
recent takes (the selected video is the `?video=<id>` URL param, newest by
default), groups a run's formats into one take with a format switcher and a
download per format, and offers caption copy and a new-run action. Existing artifacts are never
overwritten. This reuses CoS queues and media history; it adds no record store.

Alongside `index.html`, put non-empty `plan.md`, `caption.txt`, and
`storyboard.json` in the composition directory. A storyboard has this shape:

```json
{
  "posterSec": 5,
  "scenes": [{
    "durationSec": 20,
    "lines": [{
      "text": "Plan your next great project",
      "wordCount": 5,
      "holdSec": 2
    }]
  }]
}
```

Scene durations must total 15–120 seconds, within two seconds of the requested
15–120 second target. Each line's actual whitespace-separated word count must
match `wordCount`; its hold must be at least `max(0.8, 0.3 × words)` seconds and
fit inside the scene. The composition's runtime duration must equal the total.
`posterSec` must be inside that duration and selects the generated thumbnail.

Admission scans all UTF-8 HTML, CSS, JavaScript, JSON, SVG, Markdown, and text
assets, including the plan, storyboard, and caption, for the shared PII patterns
and recognizable secret tokens. It refuses detected values rather than silently
redacting them; errors identify the pattern and file without quoting the value.
Only WOFF/WOFF2 fonts are accepted as binary assets. Raster images, footage, and
other uninspectable formats are refused on this path. Existing general HTML
composition renders retain their asset support.

The same checks run again on the renderer's frozen in-memory assets before any
browser script executes, covering edits while a job waits in the queue. These
are text-pattern and declared-storyboard checks, not proof that arbitrary code
cannot construct private text or violate its declared timing. Producers must
still avoid secrets and live records, use fictional content, and make the
composition faithfully implement the storyboard. Nothing is uploaded or posted.

## Motion studio setup

`npm run setup:motion` reports and installs the optional motion toolkit:

- **ffmpeg** — installed with Homebrew, winget, apt or dnf after confirmation
  (`--yes` skips the prompt; non-interactive runs print the command instead).
- **Skill packs** (`--skills` for all, or `--skills=hyperframes,remotion`) —
  HyperFrames (`hyperframes-animation`, `hyperframes-creative`,
  `motion-graphics`, `product-launch-video`), Remotion
  (`remotion-best-practices`) and Claude Animation (`claude-animation`),
  installed user-wide for Claude Code and Codex through the `skills` CLI.
- `--status [--json]` prints what is installed. `GET
  /api/html-composition/toolkit` returns the same view to the launch-video form.

The seek(t) renderer, motion kit and proofs need nothing beyond ffmpeg and the
managed browser (`npm run setup:browser`).
