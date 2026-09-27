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
- `rng(seed)` — seeded noise (mulberry32); never use `Math.random`.
- `beats(bpm)` — a beat grid (`at`, `bar`, `index`, `phase`, `list`).
- `renderCues({ sampleRate, durationSec, cues })`, `mixCues`, `toPcm` —
  synthesized `click`, `tick`, `pop`, `thump`, `whoosh` and `riser` cues
  that return the plain PCM array `renderAudio` needs.

Launch-video runs start with the kit already copied into their composition
directory. It is ordinary UTF-8 source, so it passes the launch asset gate.

## Proof renders (contact sheets)

Add `proof: { everySec: 1 }` (0.25–10 seconds) to the render request to get a
silent contact sheet instead of a video. The renderer applies the same contract
and launch-video gates, seeks one frame per interval (at most 60), and tiles
them six across at phone size (360px wide, 240px for vertical) into one PNG.
Soundtrack options are ignored. Nothing is registered in Media History and no
launch-video artifacts are delivered. The completed job's result carries
`proof: { path, times, columns, width, height }`; tile *n* shows `times[n]`.
Launch runs write `proofs/contact-<jobId>.png` beside the run; other
compositions write `data/composition-proofs/`. Both are excluded from backups.

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

## Launch-video admission (API foundation)

`POST /api/html-composition/render` accepts `launchVideo: { targetDurationSec: 20 }`.
This option is required for directories rooted at `launch-videos/` and can also
be applied to other composition directories. An app's **Launch Video** tab
(`/apps/<appId>/launch-video`, also linked from Overview) queues a user-triggered CoS task with
tone, direction, format, duration (15–120 seconds), an optional **Dynamic motion
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
validated in-memory source snapshot. Media History retains its normal video
and thumbnail copies with app/run metadata. The Launch Video tab previews the
recent takes (the selected one is the `?video=<id>` URL param, newest by
default), with caption copy, an MP4 download, and a new-run action. Existing artifacts are never
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
