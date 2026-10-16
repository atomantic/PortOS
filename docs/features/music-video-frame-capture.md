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
YUV through FFmpeg scale/format and encodes yuv420p. The regression independently
checks encoded YUV against the source matrix and browser raw video planes.
FFmpeg's matrix-to-RGB decode remains a diagnostic comparison. The layered document
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

macOS arm64, headless Google Chrome 155.0.8059.80, hardware-decoded NV12, forced
sRGB display profile:

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

The hosted Linux x64 diagnostic (Chrome 155.0.8059.39, FFmpeg 6.1.1) exposed a
separate CPU conversion limit: BT709 magenta was `[254,0,244]` in native video,
paused canvas and PNG, while FFmpeg produced `[253,0,253]`. Yellow, green and blue
also differed in the blue channel. On the same local Chrome 155, disabling GPU
and hardware video decoding changed NV12 to I420 and reproduced those blue
values while browser raw YUV still matched FFmpeg exactly. FFmpeg 6.1.1 arm64/x64
and FFmpeg 9.0.2 synthetic probes independently verified the encoded matrix.

This is consistent with libyuv's default BT709 blue coefficient being capped at
128/64 rather than 135/64; see the [pinned conversion source](https://chromium.googlesource.com/libyuv/libyuv/+/eeb06a6451ba2e21f8ff272c7b42fc62b9faecc5/source/row_common.cc#1645).
The source YUV `[78,214,229]` predicts blue 244 with that approximation. Thus a
universal three-level bound between FFmpeg RGB and browser RGB is invalid even
when source tagging and decoding are correct. PortOS does not compensate for
individual colors or promise identical RGB across CPU/GPU decoder paths.

`server/services/musicVideo/animaticCapture.browser.test.js` validates source and
presentation separately. Each saturated patch, grayscale step and moving marker
must encode within two YUV levels of the mathematical limited-range 601/709
matrix (the lossy chart's quantization bound). The browser's raw I420/NV12 planes
must exactly match FFmpeg's decoded YUV for the requested frame, and matrix,
primaries, transfer and range metadata must match. The paused product canvas must
exactly match a fresh, independent sRGB draw of the source video. This catches
stale canvas frames without treating the product canvas as its own reference.

The real paused preview screenshot is compared to the saved PNG without replacing
DOM nodes: mean channel error remains below 1, and patch readback/export differences
remain at most 1. Native video and FFmpeg RGB remain diagnostic evidence; failures
include complete synthetic samples and versions even when CI silences console
output. Forward/backward and adjacent-frame seeks check the alternating marker,
and pause/resume checks native playback restoration. Fitting, incoming footage
with film look, still motion/effects, lyrics, title and outro remain covered.

Run the fixture with:

```sh
npm test --prefix server -- services/musicVideo/animaticCapture.browser.test.js
```

The CI planner selects it when the capture helper, Save frame control or paused
video surface changes. Hosted Linux Chrome runs the same fixture; failing assertions retain its
browser/version and numeric evidence. Local macOS results do not substitute
for that CI result. Safari was present but could not create a WebDriver session
because Allow remote automation was disabled; Safari pixels remain unverified.
No browser settings were changed for this investigation.
