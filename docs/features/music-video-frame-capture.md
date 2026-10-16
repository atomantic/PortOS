# Storyboard paused-video color and frame capture

The storyboard keeps continuous playback in a native muted video element. On
pause, each visible footage layer presents its decoded frame in an explicitly
sRGB Canvas2D surface. Save frame freezes that same canvas, then rasterizes the
actual preview layout, transitions, exact paused film look, lyrics and outro.
Native playback resumes without a JavaScript per-frame rasterization loop.
Hidden preloaded clips do not allocate decoded canvas frames.

`PreviewVideo.jsx` owns the shared surface for ordinary footage and incoming
transition footage. The wrapper owns fitting/background and opacity; the video
and canvas have the same object fitting. Seeks invalidate the previous surface,
and presentation waits two animation frames after decoded data/seek completion.
The existing song-to-source mapping still owns offsets, speed, reverse and loop.
Save frame waits for the visible paused surfaces (bounded to two seconds) and
rejects a changed, seeking or unavailable surface instead of exporting native
video through a different color path. Canvas storage is capped at 16 megapixels,
matching capture's limit. Unsupported Canvas2D or SVG foreignObject capture
reports an error; it does not upload a blank image.

## Interpretation and evidence

This is a shared SDR preview/capture interpretation, not a color-specific
correction. The browser decodes the source's matrix and range into sRGB Canvas2D.
The composed renderer (`server/services/musicVideo/render.js`) processes source
YUV through FFmpeg scale/format and encodes yuv420p. Its independent matrix-to-RGB
decode is the numeric comparison in the regression. The layered document
renderer also uses Canvas2D `drawImage`. This change does not add an HDR tone map,
a wide-gamut mastering workflow, or a new primaries/transfer conversion to the
final renderer; agreement with a calibrated native-video display is not claimed.

The synthetic browser fixture generates the original 120×240 cyan VP8 clip and
480×240 VP9 charts with eight saturated/neutral patches, a sixteen-step grayscale
ramp and an alternating, frame-specific marker. RGB is actually converted into
limited-range SMPTE170M (BT601) or BT709 YUV before encoding. `VideoFrame.colorSpace`
assertions verify matrix, primaries, transfer and range at the decoder boundary.
Metadata-only BT709 tags on the original VP8 clip still reported SMPTE170M in
Chrome, so that clip cannot stand in for a correctly decoded BT709 test.

macOS arm64, headless Google Chrome 155.0.8059.80, forced sRGB display profile:

| Source / patch | Native video screenshot RGB | Decoded canvas / paused preview / PNG RGB | FFmpeg matrix decode RGB |
| --- | --- | --- | --- |
| BT601 cyan | 70, 253, 255 | 1, 255, 255 | 0, 255, 255 |
| BT601 red | 248, 36, 0 | 254, 0, 0 | 254, 0, 0 |
| BT601 magenta | 249, 52, 255 | 255, 0, 254 | 255, 0, 254 |
| BT709 cyan | 0, 254, 255 | 0, 254, 255 | 0, 254, 255 |
| BT709 red | 255, 1, 0 | 255, 1, 0 | 255, 0, 0 |
| Both grayscale ramps | 0, 17, …, 255 | 0, 17, …, 255 | 0, 17, …, 255 |

The original standalone VP8 cyan reproduction gave native RGBA
`[70,253,255,255]` versus Canvas2D `[1,255,255,255]`, before any PortOS compositor.
Prior probes with ImageBitmap default/none conversion, VideoFrame, neutral CSS
filters, extra animation frames, and a display-P3 canvas converted back to sRGB
did not eliminate it. The VP9 matrix checks above distinguish that presentation
boundary from an incorrectly tagged source.

`server/services/musicVideo/animaticCapture.browser.test.js` retains native-video
measurements as diagnostic evidence, while assertions compare the real paused
preview screenshot to the saved PNG without replacing DOM nodes. The existing
mean-channel-error limit stays below 1; patch readback/export differences are at
most 1 and the independent FFmpeg comparison allows 3 for 8-bit decoder rounding.
Forward/backward and adjacent-frame seeks check the alternating marker, and
pause/resume checks native playback restoration. Fitting, incoming footage with
film look, still motion/effects, lyrics, title and outro remain covered.

Run the fixture with:

```sh
npm test --prefix server -- services/musicVideo/animaticCapture.browser.test.js
```

The CI planner selects it when the capture helper, Save frame control or paused
video surface changes. Hosted Linux Chrome runs the same fixture and emits its
own browser/version and numeric evidence. Local macOS results do not substitute
for that CI result. Safari was present but could not create a WebDriver session
because Allow remote automation was disabled; Safari pixels remain unverified.
No browser settings were changed for this investigation.
