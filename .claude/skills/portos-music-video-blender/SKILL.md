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
grid, in order, no overlap), and for the storyboard `summary`, `action`, `staging`, `camera`, `transition`. List
`deps` (files and folders under `src/`) so editing one shot does not make every other render stale.

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
- Frame numbers are song frames: frame `f` is `f / fps` seconds into the song.
- Target Blender 5: the EEVEE engine id is `BLENDER_EEVEE` (use `ctx.engine`), `scene.node_tree` is gone (the
  compositor is `scene.compositing_node_group`), `Action.fcurves` is gone, and materials and worlds already have
  node trees. Build meshes with `bmesh` and `bpy.data`, not `bpy.ops`, where you can.
- Use `portos_film.music` (`beats`, `downbeats`, `sections`, `nearest_beat`, `beats_between`, `pulse`,
  `envelope(song, "low"|"mid"|"high"|"rms", t)`, `cue_words`, `words_between`) and `portos_film.timing` (`ease`,
  `clamp`, `remap`, `stepped` for on-twos holds). They read `song.json`; do not parse audio yourself.
- Lyrics are not drawn for you. Typography is part of the film.

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

`tool.ready: false` in the state carries the reason. A `409 MUSIC_VIDEO_BLENDER_NEEDS_TRUSTED_LOCAL` means Blender
is in contained mode. Do not change the execution mode or run the execution check yourself: it grants host
access, so tell the operator and stop.
