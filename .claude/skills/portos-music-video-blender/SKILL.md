---
name: portos-music-video-blender
description: Author a PortOS music video as a Blender film — Python scripts that build every shot, rendered per shot by PortOS and reviewed in the Music Video UI. Invoke when writing or revising a project's film scripts, syncing its shots, or driving its renders and cuts through the API.
---

# Authoring a Blender film in PortOS

A project with render style **Blender film** (`composition.mode: "blender"`) is made from Python you write. PortOS
runs it inside Blender, per shot. The scripts are the source of truth for the shot list. Full reference:
[docs/features/music-video-blender.md](../../../docs/features/music-video-blender.md).

**The scripts run as the operator, with full access to this machine.** Write only what the film needs. Never run
source you did not write or review, and never fetch code at render time.

## Where things are

`GET /api/music-video/:id/blender` returns the state; `workspace.path` is the folder on this machine:

```
<workspace>/src/film.py     entry point (plus any modules, folders and assets you add)
<workspace>/song.json       the song: read it, never write it
<workspace>/manifest.json   the last synced shot list
<workspace>/renders/        PortOS output: frames, shot videos, stills, cuts, logs
```

Call the API with `node scripts/portos-api.js` (see the `portos-api` skill). Edit files in `src/` directly, or with
`PUT /api/music-video/:id/blender/file`. No workspace yet: `POST /api/music-video/:id/blender/workspace` copies a
working three-shot starter. Read it before writing your own.

## The film contract

```python
def describe(ctx) -> dict:            # {"title": ..., "shots": [...], "options": [...]}  (options are optional)
def build_shot(ctx, shot) -> None:    # build the bpy scene: objects, materials, lights, a camera (scene.camera)
def frame(ctx, shot, t, frame):       # optional: pose everything for song time t, before each frame renders
```

Each shot: `id` (letters, digits, `_`, `-`; unique), `label`, `start`, `end` (seconds on the song, on the frame
grid, in order, no overlap), optional `handles: {"in": sec, "out": sec}` (each 0–4 s on the frame grid; on a song
shot `handles.in <= start`), and for the storyboard `summary`, `action`, `staging`, `camera`, `transition`.

A lead-in is shots with `start < 0` that form one contiguous run ending exactly at 0, each 0.5–120 s and at most
120 s together (`{"id": "s000", "start": -6.0, "end": 0.0}`). A gap, a shot that crosses 0, or a longer run is
refused at sync and the message names the shot. `build_shot` and `frame` get that negative `t` and song frame.
`ctx.seconds_to_frame` and `ctx.frame_to_seconds` accept them. Before 0, `portos_film.music` answers no beat
(`nearest_beat` is `None`, ranges are empty, `pulse` is `0.0`, `bar_at` is `(0, 0.0)`); time 0 is unchanged.
Frame files use an `m` prefix (`frame_m000144.png`, `handle_in_m000024.png`) and stills `tm` (`tm000006000.png`).
Sync mirrors each lead-in shot to a Board scene marked before the song, of the shot's length. Edit its sound with
the Board's cold-open controls; the film supplies the picture only. The cut, the live preview and the final play
the lead-in first, then the song, so they run longer by the lead-in and the song starts at that offset. The title
card and timed effects stay on the song clock.
Imported source files are tracked automatically; use `deps` (files and folders under `src/`) to add data and assets.

**Handles & cut effects.** Assembled cuts, excerpts and the final draw `fade-black` inside each shot's own frames,
`beat-toggle` using the incoming shot's `in` handle, and `dissolve` centred on the cut by blending the outgoing `out`
handle with the incoming `in` handle (wipes stay undrawn). A shot declaring `handles` gets extra frames rendered for
`[start - in, start)` and `[end, end + out)` by calling `frame()` for those times (so the scene must be valid slightly
outside `[start, end)`); changing only handles marks the shot stale (`handles`) and resumes existing frames. Missing
handles for a dissolve or beat toggle block the final render (`409`).

`ctx`: `song`, `options`, `fps`, `width`, `height`, `scale`, `samples`, `quality`, `engine`, `workspace`, `src`,
`out_dir`, `shot`, `log()`, `seconds_to_frame()`, `frame_to_seconds()`.

**Film options.** To let the director choose something without editing code (a look, a palette, a debug overlay),
declare it in `describe`'s `options` (at most 24): `{"key", "label", "type": "choice" | "boolean" | "number" |
"text", "default", "help"?, "choices"?: [{"value", "label"}] (choice), "min"?, "max"?, "step"? (number)}`. Every
call then reads `ctx.options[key]`: the default, or the value the director saved under Film options. In `describe`
use `ctx.options.get(key, fallback)`: on the first sync nothing is declared yet. Changing an option makes every
render stale, so declare an option only for a choice worth re-rendering for. Set one through the API with
`PUT /api/music-video/:id/blender/settings` `{ "options": { "<key>": value } }` only when the director asked.

Rules that keep a film renderable:

- The scene starts empty for every shot. PortOS sets engine, size, frame rate, samples and the frame range before
  `build_shot`, and size, frame rate and output format again after it. Do not set them. Look, color management and
  the compositor are yours.
- Make every frame a pure function of song time. Renders stop and resume on any frame, and shots render in
  parallel processes, so nothing may depend on an earlier frame or shot. Bake or avoid live simulation.
- Frame numbers are song frames: frame `f` is `f / fps` seconds into the song, and a lead-in frame is negative.
  In `describe`, use `ctx.frame_to_seconds(f)` for exact boundaries. The `start` and `end` passed to `build_shot`
  and `frame` are exactly on that grid: the first frame's `t` equals `shot["start"]`, so
  `stepped(t - shot["start"], ctx.fps)` starts on the first pose. The manifest keeps six-decimal times for display
  and stale comparisons.
- Target Blender 5: the EEVEE engine id is `BLENDER_EEVEE` (use `ctx.engine`), `scene.node_tree` is gone (the
  compositor is `scene.compositing_node_group`), `Action.fcurves` is gone, and materials and worlds already have
  node trees. Build meshes with `bmesh` and `bpy.data`, not `bpy.ops`, where you can.
- Use `portos_film.music` (`beats`, `downbeats`, `sections`, `nearest_beat`, `beats_between`, `pulse`,
  `bar_time(song, bar, beat=0.0)`, `bar_at(song, t)`, `phrases(song, bars=4)`,
  `onsets(song, band="low", min_gap=0.12, sensitivity=1.5)`, `swell(song, band, t, window=2.0)`,
  `envelope(song, "low"|"mid"|"high"|"rms", t)`, `cue_words`, `words_between`) and `portos_film.timing` (`ease`,
  `clamp`, `remap`, `stepped` for on-twos holds). They read `song.json`; do not parse audio yourself.
- Lyrics are not drawn for you. Typography is part of the film.
- PortOS hands `build_shot` and `frame` the shot from `describe`, with `start` and `end` restored to the exact
  frame grid. Do not rely on a key you
  dropped from `describe`, and load anything a shot needs from `ctx` (the song above all) before any code path
  that looks a shot up without one: a process-wide cache primed without `ctx.song` has no lyrics. A film that
  renders in your own runner can still fail here, so render one still through PortOS before queueing a batch.
- End the last shot on the last whole frame inside the song (`floor(durationSec * fps) / fps`), not on the
  song's length rounded to the grid: a shot ending past the song fails the storyboard check.
- The film carries no title. The project's title card (Look step) is laid over cuts, excerpts and the final
  render in a corner the director picks: keep that corner clear of faces and type in the windows it shows.
- Treat Blender's "Shadow buffer full" log line as a failed shot (shadows drop out though frames are written);
  raise `scene.eevee.shadow_pool_size` in the film's look setup.

## The loop

1. **Sync**: `POST /api/music-video/:id/blender/sync` answers `202 { job }` and runs `describe` in the background.
   Read the state until that job is `done`. An `error` job carries `error`, `problems` (every refused shot or
   option) and `logFile`. A `409 MUSIC_VIDEO_BLENDER_SCENES_CONFLICT` means the Board has shots the film did not
   make: ask the director before sending `{ "replaceScenes": true }`.
2. **Stills**: `POST /api/music-video/:id/blender/render` with `{ "quality": "still", "shotIds": [...] }` (or `times`
   in song seconds). Look at the image before going further: lit, framed, the subject readable.
3. **Previews**: `{ "quality": "preview" }` renders every shot that has no current preview, so send it again after
   each edit: it takes the shots that went stale and any not rendered yet, and skips the rest (`skipped`).
   `"onlyStale": true` narrows it to renders that exist and went stale; `"force": true` re-renders current ones.
4. **Preview cut**: `POST /api/music-video/:id/blender/cut` with `{ "quality": "preview", "animatic": true }` puts the
   whole film with the song in front of the director as the review draft.
5. **Notes**: read `notes` in the state (per shot: text and `todo`, `wip`, `review`, `approved`). Fix what they say;
   set a status with `PUT /api/music-video/:id/blender/shots/:shotId/note` only when the director asked you to.
6. **Finals**: `{ "quality": "final" }` once the previews are approved.
7. **Final render**: `POST /api/music-video/:id/render`. It refuses until every shot has a complete, current final.

Jobs run in the background. Watch `jobs` in the state; a failed job's `logFile` (read it with
`GET /api/music-video/:id/blender/media`) holds the Python traceback. Renders are **stale** when a shot's `deps`,
times, the render settings or a film option changed (`staleReasons` says which); re-sync after changing the shot
list, the options a film declares, or the frame rate (renders are refused until then).

Rendered frames are large. `GET /api/music-video/:id/blender/usage` says what the workspace takes;
`POST /api/music-video/:id/blender/frames/clear` removes the frames of finished renders (their videos stay). Clear
them only when the director asks.

## What the pipeline still requires

The film does not replace the production review. Before the final render the project needs an approved art
direction (with an HTML or image guide), verified lyric timing (or an instrumental song), and an approved
storyboard: every shot with `action` or `summary`, `staging` and a transition, and shots covering the whole song.
Approvals need an authenticated session and honest review evidence; never approve on the director's behalf
unless asked. Publishing stays manual.

## If Blender is not ready

`tool.ready: false` in the state carries the reason (`tool.reason`). Two different things can be behind it:

- **The execution mode is the operator's choice.** Never change it. A `409 MUSIC_VIDEO_BLENDER_NEEDS_TRUSTED_LOCAL`
  (or `tool.executionMode: "contained"`) means Blender is in contained mode, where a film cannot render: tell the
  operator and stop.
- **The execution check is only a self-test of the saved configuration.** It runs PortOS's own probe scripts and a
  fixed test scene, never the film, and changes no setting. PortOS re-runs it by itself after a restart, so a ready
  film normally stays ready. When `tool.ready` is false for a check reason (the check has not run in this server
  process, the Blender app or engine changed since the last check, or the test render failed), an authenticated
  session may run it: `POST /api/code-animation/execution/probe`, then read `lanes.blender` in the answer (or
  `tool` in the film state). If it still is not ready, report `lanes.blender.reason` to the operator and stop:
  do not edit the Blender path, mode or engine to get past it.
