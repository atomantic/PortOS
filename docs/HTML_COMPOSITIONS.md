# HTML compositions

Render a local, seekable HTML scene to H.264 MP4 with the managed browser and
ffmpeg. Chrome must support CDP hidden targets. The renderer refuses unsupported
browsers rather than opening a visible tab. The
[request and page schemas](../server/lib/htmlCompositionValidation.js),
[API router](../server/routes/htmlComposition.js) and
[renderer](../server/services/htmlComposition/index.js) define the contract.

## Page and render request

Put `index.html` and its assets in a directory such as `data/compositions/example/`.
Expose a deterministic composition on the page:

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

The general renderer accepts 1–120 seconds, integer 12–60 fps and a whole
number of frames, at exactly 1920×1080, 1080×1920, 1080×1080 or 1280×720.
Frame `n` seeks to `n / fps`. Derive every frame from time, with seeded
randomness where needed. Finish asynchronous work before resolving a seek.
Decode images and wait for the sought video frame before clearing or drawing.
Commit the visible frame synchronously after those waits so live preview never
paints half of a frame.

Submit `POST /api/html-composition/render` with
`{"directory":"compositions/example"}`. The 202 response includes `jobId`.
Read `GET /api/html-composition/:jobId/events` for SSE job status and use
`POST /api/html-composition/:jobId/cancel` to cancel before the history write.
Jobs use the serialized local queue.

The renderer freezes up to 256 MiB and 4096 local files and fulfills relative
asset URLs from that snapshot at a virtual HTTPS origin. Symlinks, missing
assets, external network requests, frames, workers, popups, WebSockets and
WebRTC are refused. The hidden browser target is isolated from the operator's
browser context. No additional listener is opened. Failures and cancellation
remove partial outputs. Successful renders produce tagged BT.709, fast-start
MP4s with thumbnails in Media History.

## Audio

Choose at most one source. `musicTrack` selects a Music-library filename,
`audioUpload` selects a filename in `data/uploads/`, and
`synthesizeMusic: true` uses the page's
`async renderAudio({ sampleRate, durationSec })`. This function returns a
plain array of exactly `Math.round(sampleRate * durationSec)` finite mono
samples in [-1, 1] at the requested 24,000 Hz. The result must contain sound.
An offline audio context or deterministic JavaScript can generate the array.
Live browser audio is excluded.

File beds loop and trim to fit. All beds fade over the final half second and
default to measured loudness mastering at −14 LUFS integrated, −1.5 dBTP and
LRA 11. Missing or invalid requested audio fails the job. Mastering refuses
beds below −50 LUFS and stores the measured loudness in the result and Media
History. `masterLoudness: false` opts out. For the Music Video master and its
separate rules, see [Music Video](features/music-video.md#composition-documents-and-finishing).

## Several formats from one timeline

Request `formats` with `landscape`, `vertical` or `square`. Declare supported
sizes on the page as strings such as `"1080x1920"` in
`portosComposition.formats` (its own width and height are implicit). Implement
`async layout({ width, height })` to reframe before seeking when the scene needs
it. The renderer runs each requested format in canonical order on the same
snapshot, with the same timeline and soundtrack. A missing size fails before
rendering. The result lists `videos` by format and registers every format
together in Media History. Omit the request field to render the page's own size.

## Motion blur

Set `portosComposition.motionBlur` to 1–4 samples (1 disables blur), or use
`{ shutter: 0.5, samples: 'auto', tolerance: 2 }` to average samples across a
centered shutter in linear light. The object accepts shutter 0.05–1, samples 4–64 or `'auto'`,
and tolerance 1–8. Auto refines until the block-level image difference meets
tolerance or the 81-sample limit. The result's `sampleHistogram` counts frames
per sample count. Seeks can repeat or arrive out of order. Keep grain and
other per-frame motion stable across a shutter with
`PortosMotion.frameIdx(t, fps)`. See the [shutter implementation](../server/services/htmlComposition/shutterBlur.js).
The render request can override the page with `motionBlur: 'off' | 'light' | 'film'`.

## Motion kit

Copy [portos-motion.js](../server/services/htmlComposition/kit/portos-motion.js)
beside the HTML and load it as a local script. `globalThis.PortosMotion` exposes
deterministic springs and retargeting tracks, loop and swap helpers, seeded RNG,
beat and song lookups, frame indexing and PCM cue synthesis. Launch-video runs
include the kit in their staging directory.

## Proof renders (contact sheets)

Request `proof: { everySec: 1 }` to capture a contact sheet. Interval is
0.25–10 seconds, capped at 60 captures. Optional `proof.format` checks one
declared framing. Omit `formats` and soundtrack inputs for a proof. The
result's `proof` includes file, URL, sample times, columns and dimensions.
Proofs use the same composition and launch admission gates and skip Media
History and final delivery. Saved Code Animation exports wrap
`ANIMATION_META` and `renderFrame(t)` in the seek contract and export supported
attached audio. See the [export adapter](../server/services/codeAnimation/export.js).

## Launch-video admission

The app's **Launch Video** tab queues an explicit CoS run pinned to this
instance. It accepts direction, motion style, formats, a 15–120 second target,
optional music, a provider/model/effort pin and proof critique rounds.
Agent composition uses the offline PCM contract. The configured music service
option requires a ready engine and reports failure. Consult optional installed
motion skills for technique. The composition still renders through PortOS.
See the [app route](../server/routes/apps/launchVideos.js) and
[launch validation](../server/lib/launchVideoValidation.js).

Submit `launchVideo: { targetDurationSec: 20 }` with the render request for
launch admission. The option is required under `launch-videos/`. App runs
include both `appId` and `runId`, with directory
`launch-videos/<appId>/<runId>/composition`. Alongside `index.html`, include
nonempty `plan.md`, `caption.txt` and a `storyboard.json` such as:

```json
{
  "posterSec": 5,
  "scenes": [{
    "durationSec": 20,
    "lines": [{"text": "Plan your next great project", "wordCount": 5, "holdSec": 2}]
  }]
}
```

Scene durations total 15–120 seconds, within two seconds of the target, and
match the page's duration. Each line's word count must match the text. Holds
fit within the scene and last at least `max(0.8, 0.3 × words)` seconds. The
poster time must be within the composition.

Launch admission scans text assets for recognizable secrets and shared PII
patterns, then repeats the check on the frozen renderer snapshot before
executing scripts. Only WOFF/WOFF2 are accepted as binary assets on this path.
Use fictional data and implement the declared holds in the scene. The scan
covers file patterns and declared timing, so it cannot verify all generated
text or rendered timing. Successful app runs write the plan, storyboard,
caption, MP4 and poster beside the composition, with per-format video and
poster names for multi-format runs. Delivery stays local and keeps earlier takes.

## Motion studio setup

`npm run setup:motion -- --status` reports optional tooling.
`npm run setup:motion` can install ffmpeg and `--skills` selects optional
authoring packs. `npm run setup:browser` sets up the managed browser.
See the [real-browser renderer suite](../server/services/htmlComposition/index.test.js)
for temporary-profile coverage and Chrome/ffmpeg prerequisites.
