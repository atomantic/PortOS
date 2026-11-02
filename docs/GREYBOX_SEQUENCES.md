# Offline greybox reference sequences

The offline prototype exports timed spatial references through the existing
Three.js viewer. It never reads or changes catalog records, project shots,
media or live staging, calls a model, downloads software or restarts PortOS.

```sh
node scripts/greybox-sequence.js --input docs/examples/greybox-sequence.json --output /tmp/example-plan --plan-only
node scripts/greybox-sequence.js --input docs/examples/greybox-sequence.json --output /tmp/example-captures
node scripts/greybox-sequence.js --input docs/examples/greybox-sequence.json --output /tmp/example-reverse --shot reverse
```

The output directory must not exist. Captures require installed Chrome supported
by the existing OS-isolated composition renderer, and ffmpeg with libx264.
Plan-only needs neither. Failed/canceled exports retain partial files and a
status other than `complete`; choose another new directory for another export.

Each shot directory contains numbered PNGs, `reference.mp4`, `start.png` and
`end.png`. The last is the last encoded frame, not an extra exclusive-end sample.
Clips have no audio. `manifest.json` records fps, source hash and every frame's
absolute master time; `source.json` preserves the original input bytes.

## Input contract

See [the runnable example](examples/greybox-sequence.json). `scene` uses the
existing environment greybox contract. `durationSec` defines the master timeline.
`anchorTracks` reference existing figure/prop IDs with keys containing absolute
`timeSec`, `position` (meters, Y up) and `facingDegrees`. Angles are unwrapped:
350 to 370 crosses zero; 0 to 720 makes two turns. Values hold outside their
keys. Add enough position keys to describe turns; interpolation is linear.

`shots` reference saved cameras through `shotId`, with absolute `startSec` /
`endSec`. Give each cut a unique `id` to reuse one camera across multiple cuts;
when omitted, the camera ID is also the clip ID. `--shot` selects the clip ID.
Up to 2,000 cuts can reuse the layout’s saved cameras. Optional
camera keys contain absolute `timeSec`, `position`, `target`, `focalLengthMm`.
The saved camera supplies aspect and visible figures. Camera position, target
and lens interpolate linearly. Validation refuses unknown references, duplicate
tracks, unordered keys, overlapping/empty spans and GLB captures. Every sample
is checked for coincident camera and target before any output/browser work.

All shots share a frame grid (`frame / fps`) and half-open intervals, so even
fractional-time cuts assign each frame to at most one shot. Gaps may represent
memories/other locations; they never reset the performance. A non-frame-aligned
performance ends at the first frame boundary at or after its duration.
Keep that quantization in mind when cutting to the original music. Evaluation
does not mutate the source layout and supports sampling in arbitrary order.

## Production next steps

1. Lock a reusable floor plan, named landmarks, camera axes and prop marks.
2. Author continuous song-time blocking. Separate memories/other locations from
   the physical present-day route, and cold open/credits from song time.
3. Test wide, tracking and reverse angles against that same moving figure.
   Judge architectural landmarks, screen direction and position across cuts.
4. Author rigged skating cycles in Blender if needed, then use Three.js for
   playback. Unreal adds little to primitive blocking/reference capture.
5. Integrate the proven tracks into the project UI and persistent music-video
   timeline. Bind references to environment revision, actor track, time range
   and camera, marking dependent captures stale after edits.
6. Add depth/masks only for models that accept them. Test short guided takes
   before expanding to the entire song; generation can reinterpret geography.

Current limits: primitive layouts; capsule/box figures; one layout pass;
piecewise linear paths. This does not provide skeletal skating/foot-contact
reference, depth/normals/masks, live timeline editing, GLB sequence animation,
automatic choreography or attachment to video generation. Treat capsule motion
as spatial blocking, never proof of realistic skating.
