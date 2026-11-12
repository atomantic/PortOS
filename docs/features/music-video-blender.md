# Music Video: Blender film

A music video can be produced as a **Blender film**: Python scripts that build and animate every shot in Blender.
PortOS stores the settings, reads the shot list from the scripts, renders each shot, plays the previews, assembles
cuts against the song, and joins the final video. The scripts are the source of truth for the shots.

Pick it as the project's render style (`composition.mode: "blender"`, shown as "Blender film").

## Shared engine and ownership

`server/services/film/` owns the workspace, Python driver and starter kit, sync,
render queue, resume, render index, stills, previews and cut joining. It imports
no Music Video services. Every engine call receives a film owner with `kind`,
`id`, `workspaceDir`, `timeline()`, `song()`, `readRecord()`, `writeRecord(change)`
and `emit(event)`. Record changes are functional patches; the owner serializes
them against its freshest record. `onSynced(manifest, { change, replaceScenes })`
can commit that patch and the owner's shot mirror atomically; without a mirror,
the engine writes the patch itself. Optional `beforeSync` checks owner conflicts
before starting Blender, and `workspaceLabel` controls the displayed path.

Music Video's `blender/owner.js` supplies the existing project record, song
projection, Board mirroring and `music-video:blender` events. Its API adapters
keep the routes, state and errors unchanged. `sceneMirror.js`, `titleCard.js`,
`finishFilter.js` and `finalRender.js` remain in Music Video; its cut wrapper
adds finishing and private review drafts around the shared join. No standalone
film endpoint is exposed by this extraction.

A no-song owner returns `null` from `song()`: `song.json` then has empty analysis,
lyrics and audio paths, while coverage uses `timeline().durationSec`. The join
can write a silent cut. Music Video still requires its song for a cut. Existing
workspaces stay at `data/music-video/<projectId>/blender`; render metadata and
`renders/pending.json` retain their format and resume without a migration.

## What you need

- **Blender 4.2 or newer**, selected and checked under Blender execution (Code Animation › Production, or the film
  panel's Settings tab).
- **Trusted local mode.** A film renders on the GPU and writes frames into the project workspace, which the
  contained sandbox cannot do. In contained mode every run answers `409 MUSIC_VIDEO_BLENDER_NEEDS_TRUSTED_LOCAL`.
  PortOS never changes that setting for you. Choosing the mode and saving it is all it takes: there is nothing to
  acknowledge.
- **A passed check.** Check Blender runs PortOS's own test of the saved Blender, mode and engine. You run it once.
  After a PortOS restart the same check runs again by itself while those three are unchanged, so the film is ready
  without another click (the first read after a restart can take a few seconds). Change the Blender, the mode or the
  engine, or replace the Blender app, and the next check is yours to run.
- **ffmpeg**, to turn frames into video.
- The song analyzed (the shot list is checked against its length).

**A film is your own code running with your account's access to this machine.** It can read and write files, use
the network and start programs. Only run source you trust. The routes that write the source, run it, assemble
video or open Blender need operator authority (a local connection, an operator session or a PortOS agent token).

## The workspace

Each project has one folder on this machine:

```
data/music-video/<projectId>/blender/
  src/            the film: your scripts and assets. Entry point: src/film.py
  manifest.json   the shot list from the last sync
  song.json       the song, rewritten before every job
  renders/        everything PortOS renders (safe to delete; re-rendered on demand)
    <shotId>/preview/frames/frame_000123.jpg, shot.mp4, poster.jpg, render.json
    <shotId>/final/frames/frame_000123.png, shot.mp4, poster.jpg, render.json
    <shotId>/stills/t000012345.png, stills.json
    <shotId>/shot.blend          when "Save .blend" is on
    cuts/<quality>-<time>.mp4, cuts.json   the newest 8 per quality
    logs/<jobId>.log                       the newest 60
```

Frame files are named by their frame number on the song, stills by their song time in milliseconds.

Edit `src/` with any editor, with a coding agent, or in the panel's Files tab. The API reads and writes text files
(`.py .json .txt .md`, up to 2 MiB); images, HDRIs, fonts, audio, models and `.blend` files are placed in the folder
and only listed. A file sits at most five folders below `src/`, and symbolic links are not followed.
A workspace with more than 5,000 supported source files is refused explicitly; it is never partially hashed or copied.

**Create starter workspace** copies a small complete film into `src/`: a stage, three figures and lights that follow
the song's beats and loudness, in three shots. Use it as a template.

## The film contract

`src/film.py` defines three functions. PortOS calls them inside Blender.

```python
def describe(ctx) -> dict:
    return {
        "title": "Example Film",
        "shots": [
            {"id": "s010", "label": "Cold open", "start": 0.0, "end": 4.5,   # seconds on the song
             "handles": {"in": 0.0, "out": 0.5},                              # optional 0..4 s handles
             "set": "stage", "summary": "one line", "action": "...", "staging": "...",
             "camera": "...", "transition": "Cut", "deps": ["film.py", "shots/s010.py", "kit"]},
        ],
        "options": [                                                          # optional: see Film options
            {"key": "palette", "label": "Palette", "type": "choice", "default": "dusk",
             "choices": [{"value": "dusk", "label": "Dusk"}, {"value": "neon", "label": "Neon"}]},
        ],
    }

def build_shot(ctx, shot) -> None:        # build the scene for this shot: objects, lights, camera
    pass

def frame(ctx, shot, t, frame) -> None:   # optional: pose everything for song time t before each frame
    pass
```

Shot rules:

- `id`: 1 to 40 letters, digits, `_` or `-`, starting with a letter or digit. Unique, ignoring case.
- Shots are listed in time order and never overlap. `0 <= start < end <=` the song's length. A song rarely ends on
  a frame boundary, so the last shot may end on the boundary just after it (the picture then covers the whole song).
- `start` and `end` fall on a frame boundary (within 0.001 s; they are snapped). At most 400 shots.
  In `describe`, use `ctx.frame_to_seconds(f)` to express exact boundaries. PortOS passes `build_shot` and `frame`
  a shot whose `start` and `end` are exactly `frame / fps`, using the same grid as `ctx.frame_to_seconds` and
  each frame's song time `t`. The first frame's `t` equals `shot["start"]` exactly, so shot-relative holds such as
  `stepped(t - shot["start"], ctx.fps)` start on the first pose. `manifest.json` still stores six-decimal times
  for display and comparison; restoring exact times for the film does not mark existing renders stale.
- `summary`, `action`, `staging`, `camera` and `transition` are optional text, up to 4,000 characters each.
- `handles` (optional): `{"in": seconds, "out": seconds}` — each 0 to 4 s on the frame grid (`in <= start`). PortOS
  renders `[start - in, start)` into `handle_in_<frame>.<ext>` and `[end, end + out)` into `handle_out_<frame>.<ext>`
  under `frames/` by calling `frame()` for those song times. A shot with handles must build a scene valid slightly
  outside its own `[start, end)` range. Handle frames are NOT part of `shot.mp4`, resume with the shot, mark only
  that shot stale (`handles`) when changed, and stay on disk when shot frames are cleared (`Clear rendered frames`)
  until the shot re-renders or leaves the film.
- `deps` lists the files and folders under `src/` the shot is built from. Without it, the shot depends on all of `src/`.

`ctx` carries: `song` (the contents of `song.json`), `options` (the film's options, below), `fps`, `width` and `height` (already scaled), `scale`, `samples`,
`quality` (`still`, `preview`, `final` or `describe`), `engine` (Blender's own engine id), `workspace`, `src`,
`out_dir`, `shot`, `log(message)`, `seconds_to_frame(t)` and `frame_to_seconds(f)`.

For each shot PortOS starts from an empty scene, sets the engine, size, frame rate and samples, calls
`build_shot`, then for each frame sets the frame, calls `frame` and renders. The film is free to set the look,
color management and compositor in `build_shot`. Every frame should depend only on song time, so a render can stop
and resume anywhere.

Helpers a film may import (`portos_film`, standard library only):

- `portos_film.music`: `beats(song)`, `downbeats(song)`, `sections(song)`, `section_at(song, t)`,
  `nearest_beat(song, t)`, `beats_between(song, a, b)`, `beat_phase(song, t)`, `pulse(song, t)`,
  `bar_time(song, bar, beat=0.0)`, `bar_at(song, t)`, `phrases(song, bars=4)`,
  `onsets(song, band="low", min_gap=0.12, sensitivity=1.5)`, `swell(song, band, t, window=2.0)`,
  `cue_words(song, cue_index)`, `words_between(song, a, b)`, `envelope(song, band, t)`. Bar numbers are 1-based
  from the first downbeat; bar lookup and timing extrapolate using the median tracked bar length. Phrases span
  consecutive groups of bars through song end. Onsets are spaced peaks in positive envelope changes; `swell`
  averages the envelope around a time. Missing analysis returns empty lists, `(1, 0.0)` for `bar_at` and `0.0`
  for scalar helpers.
- `portos_film.timing`: `clamp`, `remap`, `ease`, `stepped(t, fps, on=2)` (hold poses on twos).

### Film options

A film can declare options for the operator to set in PortOS: a look, a palette, a debug overlay. `describe`
returns them as `options`, a list of at most 24:

| Field | Meaning |
|---|---|
| `key` | 1 to 40 letters, digits, `_` or `-`, starting with a letter or digit. Unique, ignoring case. The name in `ctx.options` |
| `label` | What the form calls it (up to 80 characters; the key when left out) |
| `type` | `choice`, `boolean`, `number` or `text` |
| `default` | Required, and valid for the type: one of the choices, `True`/`False`, a number inside `min`/`max`, or text up to 2,000 characters |
| `choices` | `choice` only: 1 to 32 of `{"value": "...", "label": "..."}`, values unique |
| `min`, `max`, `step` | `number` only, all optional |
| `help` | One line under the field (up to 400 characters) |

A sync stores the declaration in `manifest.json`. The Settings tab then shows a **Film options** group drawn from
it: a select for a choice, a checkbox for a boolean, a number or text field. The values are saved with the render
settings (`settings.options`, on this machine only). Only values that differ from the film's default are stored, so
a project that never touched an option follows the film when its default changes.

Every film call reads them as **`ctx.options`**, a dict with one entry per declared option: its default, or the
saved value where one is set. During the very first sync nothing is declared yet, so `describe` should read an
option with a fallback (`ctx.options.get("palette", "dusk")`). A value the film stops declaring or accepting is
dropped at the next sync, and saving a value an option does not accept is refused, never adjusted.

A render records the options it was built with. **Changing an option marks every preview, final and still out of
date**, and the next render starts clean instead of resuming old frames. If `describe` itself depends on an option
(a shorter cut, say), sync again after changing it.

The starter film declares one, `palette`: each shot's own colors, or one palette for the whole film.

### song.json

```jsonc
{ "projectId": "...", "title": "Example Song", "durationSec": 161.5, "fps": 24,
  "audio": { "master": "<path to the song file>", "vocalStem": "<path> or null" },
  "analysis": { "bpm": 120, "beats": [], "downbeats": [],
                "sections": [{ "label": "Chorus", "startSec": 40, "endSec": 62, "energy": 0.8 }],
                "features": { "envelopes": { "fps": 30, "rms": [], "low": [], "mid": [], "high": [] } } },
  "lyrics": { "cues": [{ "index": 0, "id": "...", "text": "...", "startSec": 12.5, "endSec": 14.5,
                         "words": [{ "w": "word", "startSec": 12.5, "endSec": 12.9 }] }],
              "markers": [{ "type": "section", "label": "Chorus", "kind": "chorus", "line": 0 }] } }
```

## Settings

| Setting | Range | Default |
|---|---|---|
| Engine | EEVEE or Cycles (Cycles uses the GPU when one is available) | EEVEE |
| Size | even numbers, 320 to 7680 wide and 180 to 4320 high | 1920 × 1080 |
| Frame rate | 12 to 60 | 24 |
| Preview scale | 0.25 to 1 | 0.5 |
| Preview samples | 1 to 1,024 | 16 |
| Final samples | 1 to 4,096 | 64 |
| Parallel renders | 1 to 4 Blender processes | 2 |
| Save .blend | also keep each shot's scene for **Open in Blender** | off |

The film's own options (above) are saved with these settings. Settings and notes stay on this machine. The render
style itself syncs to your other machines, which show the project but have no workspace to render from.

Changing the frame rate moves every shot onto another frame grid, so renders wait (`409
MUSIC_VIDEO_BLENDER_NOT_SYNCED`) until the shots are synced again.

## The review loop

1. **Sync shots from scripts** runs `describe`, checks the list, saves it, and mirrors each shot to one Board
   scene. A shot keeps its scene across syncs; a shot that is gone takes its scene with it. Scenes the film did not
   make are a conflict until you confirm replacing them. A refused list changes nothing and names every problem.
   `describe` is your code and may take a while, so a sync is a background job: the button shows how long it has
   run and can cancel it, and it gives up by itself after five minutes.
2. **Render stills** to check a look: one frame per shot (its midpoint, or the song times you ask for) at full size.
3. **Render previews**: scaled JPEG frames and a shot video, fast enough to iterate on.
4. **Watch the film live** in the preview at the top of the Shots step: the whole film against the song, straight
   from the shot renders, with nothing to assemble (see [Watching the film](#watching-the-film)).
5. **Assemble a preview cut** when you want the film as a file. Shots without a video are black for their own
   length. **Also publish as review draft** makes the cut the project's review draft.
6. Leave a **note** and a status (`todo`, `wip`, `review`, `approved`) on each shot.
7. **Render finals**: full-size PNG frames and a shot video.
8. **Final render** (the project's Final render step) joins the final shot videos and the song.

### Watching the film

There are three ways to watch, from the quickest to the most exact.

- **One shot.** The film panel's Shots tab plays the selected shot's render on a loop, with the song under it.
- **The whole film, live.** The preview docked at the top of the Shots step plays **Film (live)** once the shots
  are synced; the other steps offer it in the preview's source picker. It needs no job and makes no file. Each
  shot's clip is the best render it has, played from its first frame at normal speed and cut on the song: a
  current final, else a current preview, else an out-of-date final, else an out-of-date preview. The line under
  the picture says which one is playing. A shot with no finished render is black, labelled **Not rendered yet**,
  for exactly its length, so the film keeps its timing. A render that finishes while the page is open takes its
  place without a reload.

  Over the shots, the browser draws what a cut paints: the project's film look (turn on **Film look** under the
  picture; it is off by default because it is heavy on a phone), the effects set on each mirrored Board scene, on
  its cuts and at moments inside it (glitches, gate jumps, shutter blinks, light leaks), and the title card. A
  change to the film look, a scene's Effects or the title card shows in the player at once. As in a cut, wipes
  are not drawn and no lyrics are laid over the film. The color grade is not previewed live; an assembled cut
  shows it. Seeking, the shot buttons and frame stepping work as they do for footage, and a frame step is one
  frame at the film's own frame rate.

  The live preview and the panel's shot player both play the song, so they take turns: starting one pauses the
  other, and the shot player does not start by itself (a newly selected shot, a render that just landed) while
  the film is playing.
- **An assembled cut** (the film panel's Cut tab) is a video file: the shot videos at one quality joined with the
  song, with the grade, effects and title card painted in and, when ticked, the film look pass. Assemble one to
  see exactly what will be encoded, to share it, or to publish it as the review draft. A cut holds the renders as
  they were when it was assembled; the live preview always plays the current ones.

A render is **stale** (out of date) when the files in its shot's `deps`, the shot's times, the settings it used
(engine, size, frame rate, scale, samples), a film option, or the song context it received
(title, audio paths, analysis and lyrics) have changed since; the panel says which
(`staleReasons`: `source`, `timing`, `settings`, `options`, `song`). Stale renders still play. A render that was cancelled
or interrupted keeps its finished frames and resumes them, unless it went stale. Older render and still
metadata without a song-context hash reads as stale; re-rendering records the context without rewriting older metadata.

Rendering many shots at once takes a scope: **Missing or out of date** (the default: every shot without a
complete, current render), **Out of date only** (renders that exist and went stale; a shot never rendered is left
out), or **Every shot** (re-renders current ones too).

Jobs run one shot at a time per Blender process, in the order queued. Still requests for the same shot run
one after another so their images and index stay together. Syncing shots is refused while renders are active;
new renders are refused until syncing finishes. Preview and final batches are remembered on this machine in
`renders/pending.json` and resume 15 seconds after a restart, skipping completed shots and reusing partial
frames. Automatic recovery stops after two restarts, or if the tool is unavailable or the film needs syncing;
the server logs the project and remaining shot count. Cancel removes pending work. Stills are not resumed.
Completed, failed and canceled shots are removed from the marker; an empty batch leaves no marker.

### What the pipeline still requires

The Blender film uses the same gates as every other style: approve the art direction (with a visual guide),
verify the lyric timing (or mark the song instrumental), and approve the storyboard. The storyboard is the mirrored
Board, so each shot needs `action` (or `summary`), `staging` and a transition, and the shots must cover the song.

The final render is refused with `409 MUSIC_VIDEO_BLENDER_SHOTS_NOT_READY` (listing `missing` and `stale` shots)
until every shot has a complete, current final render and the shots cover every song frame, starting at frame
zero and ending on the frame boundary at or just after the song ends. A song shortened since sync requires a
new shot sync when the old list extends past that boundary. Once it is made, the final
video reads as out of date (the Final render step reopens) as soon as a shot goes stale or is rendered again: it
was joined from the shot videos as they were. Excerpts and proofs cut their
window from the best video each shot has: a current final, else its preview fitted to the final size.

### Finishing

- **Film look.** The project's film look (grain, gate weave, halation, VHS looks) is applied to the final render
  and to excerpts as a finishing pass, as it is for footage. For a cut, tick **Film look** (off by default: the
  pass is slow).
- **Grade and shot effects.** The project's color grade, `fade-black` cut effects, and the timed effects set on each
  mirrored Board scene (glitches, gate jumps, shutter blinks, light leaks, on a cut or at a moment), are painted when
  shots are joined. `fade-black` fades inside each shot's own frames (no handles required). A `dissolve` of length `D`
  is drawn in cuts, excerpts and the final centred on the cut by blending the outgoing shot's `out` handle with the
  incoming shot's `in` handle across `D` (preserving film length and sync); `beat-toggle` uses the incoming shot's `in`
  handle on beat flips before the cut. When a scene requests a dissolve or beat toggle whose shot lacks the needed
  handle, the film's `problems` list names it (`Shot s020 needs 0.25 s of out handle for its dissolve`) and the final
  render refuses with `409 MUSIC_VIDEO_BLENDER_SHOTS_NOT_READY` rather than hard-cutting silently. Live preview keeps
  drawing a hard cut and labels it (`Dissolve (drawn in cuts)`). Wipes between shots stay undrawn.
- **Title card.** The project's opening title card (the MTV-style credit block set on the Look step: artist, title,
  year, and optionally again at the end, with its fades and its slide in) is drawn over the film in every cut,
  excerpt and final render. Leave room for it in the corner it sits in, and keep the film's own type out of its
  windows. Where it is drawn depends on **Keep steady** (on by default for the lower-third look, off for the
  outlined one):
  - **Steady**, and a film look pass follows (a final render or excerpt of a project with a film look, or a cut
    with the film look ticked): the join leaves the card out and the film look pass draws it over the look, so
    the look's gate weave does not move it and its flicker and grain do not touch it.
  - **Not steady**, or no film look pass follows (a neutral look, or a cut without the film look ticked): the join
    lays the card over the shots, after the grade and the shots' timed effects, and a film look pass that follows
    runs over it with the rest of the picture.

  Either way the shots' own timed effects (gate jumps, glitches) never move the card. The live preview follows the
  same rule: a steady card is drawn over the previewed film look, any other card under it.
- **Lyrics** are not drawn automatically. Typography is authored in Blender; `song.json` carries the timed words.

## Disk use and rendered frames

Frames are the bulk of a workspace: a three-minute film at 1920 × 1080 is several thousand PNG frames and many
gigabytes. PortOS needs them only until a shot's video is encoded. What it keeps:

- An **unfinished** render keeps its frames, so rendering that shot again resumes them.
- A **finished** render keeps its frames (the lossless master of the shot) until you clear them, or until the shot is
  rendered again from changed scripts, settings or options, which replaces them.
- A shot that **leaves the film** loses its frames at the next sync. Its videos and stills stay, in case it comes
  back, until frames are cleared.

The Settings tab shows what the renders take and offers **Clear rendered frames**: it removes the frames of every
finished render and everything rendered for shots the film no longer lists. Shot videos, posters, stills, cuts and
logs stay, so nothing stops playing. It waits while shots are rendering. `renders/` is excluded from backups by
default ([BACKUP.md](../BACKUP.md)).

## Forking a film

A fork of a project (**Fork**, or **Fork & revise song**) gets its own copy of the film: `src/`, the synced
`manifest.json` and `song.json`, with the shots mapped to the fork's own Board scenes and the settings and
option values carried over. Renders, cuts and director notes are not copied: the fork renders its own, and
editing its scripts never touches the original. A source that has no film workspace, and a footage adaptation,
carry only the settings.

## API

All under `/api/music-video`. State is the answer to the read and to the settings, workspace, file and note
changes; a sync, a render and a cut answer with the jobs they queued.

| Route | Purpose |
|---|---|
| `GET /api/music-video/:id/blender` | State: settings, Blender readiness, workspace, synced shots, renders, cuts, jobs, notes |
| `PUT /api/music-video/:id/blender/settings` | Save some settings; film option values as `{ options: { <key>: value } }` (`null` clears one). `400 MUSIC_VIDEO_BLENDER_OPTION_INVALID` for a value an option does not accept |
| `POST /api/music-video/:id/blender/workspace` | Copy the starter film into `src/` (`409` once `film.py` exists) |
| `GET /api/music-video/:id/blender/files` | List the film source |
| `GET /api/music-video/:id/blender/file` | Read one text file (`?path=shots/s010.py`) |
| `PUT /api/music-video/:id/blender/file` | Write one text file `{ path, content }` |
| `DELETE /api/music-video/:id/blender/file` | Delete one file (`?path=`) |
| `POST /api/music-video/:id/blender/sync` | Start a sync `{ replaceScenes? }` → `202 { job }` |
| `GET /api/music-video/:id/blender/usage` | What the workspace takes on disk |
| `POST /api/music-video/:id/blender/frames/clear` | Clear rendered frames → `{ freedBytes, usage }` |
| `POST /api/music-video/:id/blender/render` | Queue renders `{ quality, shotIds?, times?, force?, onlyStale? }` → `202 { jobs, skipped }` |
| `POST /api/music-video/:id/blender/jobs/:jobId/cancel` | Cancel one job |
| `POST /api/music-video/:id/blender/cancel` | Cancel every job of the project |
| `POST /api/music-video/:id/blender/cut` | Assemble a cut `{ quality, animatic?, filmLook? }` → `202 { job }` |
| `PUT /api/music-video/:id/blender/shots/:shotId/note` | Save a note `{ text?, status? }` |
| `POST /api/music-video/:id/blender/shots/:shotId/open` | Open the shot's saved `.blend` in Blender |
| `GET /api/music-video/:id/blender/media` | Serve a file under `renders/` (`?path=s010/preview/shot.mp4`) |

Render selection: without `force`, shots whose render is complete and current are skipped; `onlyStale` renders only
shots whose existing render is stale (a shot never rendered is not one); stills always render.

A job is `{ id, kind: "sync" | "render" | "cut", status: "queued" | "running" | "encoding" | "done" | "error" |
"canceled", shotId?, quality?, frame?, index?, total?, secPerFrame?, queuedAt, startedAt, finishedAt?, error?,
code?, problems?, logFile? }`. A render counts frames (`index` of `total`, starting at 1); a cut counts percent. A
failed sync carries its error `code` and, when the shot list was refused, every problem in `problems`. Progress
arrives on the `music-video:blender` socket channel as `{ projectId, kind: "job", job }` (at most four a second per
job) and `{ projectId, kind: "state" }`; the state lists the active jobs and the last 20 finished ones.

Each render in the state is `{ file, poster?, frames, complete, stale, staleReasons, finishedAt, durationMs, width,
height, fps, partialFrames? }`. `file` and `poster` are paths for the media route; `file` is `null` while an
unfinished render has no video yet. Each cut is `{ id, quality, file, createdAt, durationSec, missing, stale,
rerendered, filmLook }`: `missing` and `stale` are the shots it was assembled without a current render of, and
`rerendered` the shots rendered since (the cut still shows their older picture). `finalStale` says whether the
project's final video is behind the shots (`null` when it has no final joined from this film).

## Limits

- One film per project; the film's frame size is its own, so excerpts cannot be re-framed to another aspect (a
  vertical social cut is fitted from the final video).
- 6 hours per shot job, 32 GiB of memory, 16 GiB per written file.
- Blender starts fresh for every job (`--factory-startup`): no add-ons, preferences or caches carry over.
- Frames are kept after encoding until you clear them (see Disk use and rendered frames). `renders/` is excluded
  from backups by default and is safe to delete whole: everything in it is rendered again on demand.
- A sync gives `describe` five minutes.
- No model or provider is called anywhere in this style.
