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
be applied to other composition directories. The app-detail action and CoS
planning task are not part of this API foundation yet (tracked in #8649).

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

Scene durations must total 15–25 seconds, within two seconds of the requested
15–25 second target. Each line's actual whitespace-separated word count must
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
