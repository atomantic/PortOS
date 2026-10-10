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
`musicTrack` bed, is mastered by default (#10249). The encode first runs an
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
A proof is silent, so the request must omit `musicTrack` and
`synthesizeMusic`. Nothing is registered in Media History and no
launch-video artifacts are delivered. The completed job's result carries
`proof: { file, url, times, columns, width, height }` (plus `format` when one was requested), where `file` is
relative to the data directory (never an absolute host path) and `url` serves
it under `/data/`; tile *n* shows `times[n]`.
Launch runs write `proofs/contact-<jobId>.png` beside the run; other
compositions write `data/composition-proofs/`. Both are excluded from backups. Code Animation exports stage `data/code-animation-exports/<job-id>/<export-id>/` (also excluded): the stored HTML with a shim that maps `ANIMATION_META`/`renderFrame(t)` onto `portosComposition`, stops the page's own `requestAnimationFrame` clock, and hides everything but the film canvas.

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
split toning, vignette, light leaks, gate weave and flicker. One definition in
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
  split render (#10365) and the overlay text probe see the filtered page.

The filter is an SVG `<filter>` applied to the document root (or to the
`<img>` for a still). Radii and offsets scale with the filtered element's
width, so a 390px phone preview, the 1920-wide render and a 4K still read
alike. Every time-varying effect (grain seed, gate weave, flicker, light-leak
drift) is a pure function of the song frame, so the four render workers agree
and a still is one bake. `filmLookRuntimeSource()` inlines the markup function
by `toString()` into sandboxed pages, which is why `filmLookFilterMarkup` must
stay self-contained; the runtime wraps `portosComposition.seek()` to advance
the frame before the page paints. A neutral look emits no filter at all.

Each control names its effect in photography terms, and the **In a prompt**
box rewrites the current settings as the words that ask a model for the same
qualities (`describeFilmLook`), so tuning a look also teaches the vocabulary
for the next generation prompt. The look works on composition-document
projects; the composed render style keeps its own render grade above.

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
  cardColor, textZone, lyricRole, lyricText, direction, media: { kind, src, inSec, outSec, fps,
  width, height } | null }], textCues, composition: { mode, style, posterSec,
  overlay } }`. Load it with `<script src="portos-mv.js">`; the sandbox
  refuses `fetch`.
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
onsets, the line drifts up and fades 0.3s after its last word), `hook` (wide
caps centred in the zone, each word slams in on its onset, one outline-only
accent word with ink beneath its light outline, cut on the next beat),
`stamp` (a three-frame stamp with a small tilt, optional strike-through) and `data` (mono HUD caption whose numbers roll;
at most one per shot). A per-line override or the line's own `role` wins,
then the shot's `lyricRole`, then the lyric sheet: the line's `lyricMarkers`
delivery direction (spoken/shouted lines stamp), else its section header
(choruses, hooks, refrains and drops are hooks), else `line`. Each shot's `textZone` (`lower-left`, `upper-right`,
centred `upper` / `lower`, `center`, or `none` to keep the shot clear) places
the words so they never cover the subject. A line never shows before its first word onset, stays at
least 0.8s, and sung type stays at least 56px at 1080p. Palette tokens
(`fill`, `ink`, `accent`, `strike`), fonts and an optional ink-boil jitter are
options. Upgrading a pre-module layered engine adds the module's two tags in
front of the template's engine tag.

The in-app preview is a self-contained `srcdoc` in an opaque-origin sandbox
with no network: the server inlines the document's scripts, stylesheets and
small assets, and the scrubber posts `portos-mv:seek` messages. Larger media
is bridged on demand: the PortOS page posts only the list of files
(`window.PORTOS_MV_ASSETS` resolves to `{ src: src }`), and the first time a
script sets a media element's `src` to one of them, the page fetches that file
on the user's behalf and posts it in as a Blob (`window.PORTOS_MV_ASSET(src)`
returns a promise of its blob: URL for other uses). The page keeps a bounded
cache of fetched files, and object URLs idle for a few seconds are revoked
once the preview holds more than 64 MB, unless a media element still plays
them. So assign `src` when a frame needs the file, not every file at startup.

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
