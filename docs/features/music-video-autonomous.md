# Autonomous Music Video

One prompt in, a finished music video out. The Music Video page's **Autonomous** entry point (and the `music-video-autopilot` scheduled task) starts a server-owned run that does everything the hand-driven flow asks you to set up first: it writes the creative brief, the lyrics and a mood board, makes the song (in Suno, or on this machine), and produces the video with the tools you allowed. Approval checkpoints are optional; with none chosen the run is fully unattended.

## Pipeline

```
brief → lyrics → style → song → analyze → produce
```

| Stage | What happens | Costs |
|---|---|---|
| `brief` | One LLM call turns the prompt into a title, a musical description, a compact Suno style line, a visual concept and a mood-board spec. The project is renamed to the title. | one provider call |
| `lyrics` | Original lyrics written against the musical description (skipped for an instrumental). | one provider call |
| `style` | A **Mood Board** (text notes + a composite look prompt and an avoid list) is created and linked as the project's mood board; the concept is set from the brief. No images are generated. | free |
| `song` | The PortOS Browser drives the Suno web UI (custom mode: lyrics, style, title), only M4A is selected in Suno's Download UI and the completed audio is validated and imported directly into the music library, a Track is created, the take is recorded with `source: 'suno'`, and the project is linked to it. | Suno credits |
| `song` (local) | `songSource: 'local'` renders the song with the on-device Music Designer engines instead (see [Local song source](#local-song-source)). | free (GPU time) |
| `analyze` | The usual offline beat / tempo / section analysis. | free |
| `produce` | **Footage** (any image/video tool picked): the existing server-owned production run (`/production-runs`) with a pool built from the picks, then the final render once it completes. **Code** (only `code:render`): a code-rendered video is authored and rendered directly. | per tool |

State lives on the project as `autonomousRun` — install-local like `productionRuns` (stripped from the peer wire, not carried into a clone). Each stage settles in one serialized project write, so a crash resumes at the stage that did not settle. After a server restart a run is shown **interrupted** and nothing advances until you resume it (no cold-bootstrap provider calls).

## Checkpoints

`checkpoints` names the stages that park the run in `awaiting-approval` until you approve:

- `lyrics` — review/edit the lyrics before anything else is spent.
- `style` — review the mood board and edit the Suno style line; the last stop before Suno credits are used.
- `song` — listen to the Suno song before the image/video quota is spent.
- `cast` — flips the existing Cast & Sets check-in to *review* (the production run owns it).

Approving can carry edits (`POST /api/music-video/:id/autonomous/resume` with `{ lyrics }` or `{ style }`).

## Local song source

`songSource: 'local'` makes the song with the Music Designer engines (ACE-Step, MiniMax, …) through the same audio media-job lane the Music studio uses — no browser, no Suno account. The request goes through `queueMusicGeneration` (`server/services/musicGeneration.js`, the pipeline behind `POST /api/music/generate`), called in-process.

1. The Track is created first (title, lyrics, prompt) and its id stored as `output.localTrackId`.
2. A ready engine is picked: a lyric-capable one for a vocal song, any ready one for an instrumental (`LOCAL_SONG_NO_ENGINE` when none can run — install one in Music Studio). The prompt is the musical description plus the (editable) style line; the duration is a full song clamped to the engine's window, or the engine's automatic duration.
3. The render is queued onto that Track and the job id stored as `output.localSongJobId`; the Music Studio completion hook lands the audio on the Track, and the stage settles once it is there. A retry rejoins the stored job (or starts a new one if it failed/was canceled) and never renders a track that already has audio.
4. Stop / Cancel on a run waiting in this stage cancels the queued render.

**Fallback.** With `localFallback: true` (Suno source only), a Suno failure *before Suno accepted the request* — signed out, no credits, page changed, browser down — switches the run to the local source instead of parking it (`output.songSource: 'local'`, `output.songFallbackReason`). Once Suno has accepted a request the credits are spent, so a later failure parks as usual and a retry reuses those songs. This fallback does not apply to a submitted song whose download or completion verification fails.

## Suno completion evidence

The CDN exposes playable partial files. Equal byte counts, an audio MIME header,
a duration, or successful decoding cannot prove that generation ended. The
adapter uses Suno's Download UI and waits for the browser to finish saving the
M4A export before validating and importing it. It never downloads a CDN preview.

Validation checks the container signature and uses ffmpeg to decode every audio
frame with file-only access, the MOV/M4A demuxer, a bounded process deadline, and
positive decoded-frame evidence. Original AAC or Opus audio and optional
subtitles remain unchanged. Invalid content, missing ffmpeg, timeout, or
cancellation prevents import. Temporary files are removed on success or failure;
diagnostics contain fixed reasons rather than decoder output or private paths.

[#9474](https://github.com/atomantic/PortOS/issues/9474) owns live acceptance of
the new browser export driver. Deterministic browser fixtures and real synthetic
decoder tests do not establish that live acceptance. Retry retains submitted IDs
and does not press Create or spend credits on a second generation.

## Failure handling

- A signed-out Suno parks the run **`needs-human`** (`PUBLISH_LOGIN_REQUIRED`): sign in to Suno in the PortOS Browser, then Resume.
- Any other stage failure parks **`failed`** with the error; Retry re-runs that stage only. Songs already submitted to Suno are stored the moment Suno accepts the request, so a failed download retries the same songs and never spends credits on a second generation.
- A parked or failed delegated production run parks this run `needs-human`; Resume resumes the production run.

The Suno adapter fills the form through `placeholder` / role selectors and reads the new `/song/<id>` links. It opens the first take in the same signed-in PortOS Browser, selects only M4A, and presses Download (or Unlock & Download) once. It waits for the browser download to finish saving, checks the container and decodes the complete audio to reject damaged files, and imports the original M4A without conversion. The export has a ten-minute deadline; timeout, cancellation, or invalid audio removes staging files and never imports a partial/error response. Failures identify the export stage using bounded reason metadata. A retry reopens the existing song rather than pressing Create again.

## API

| Method | Path | |
|---|---|---|
| `POST` | `/api/music-video/autonomous` | Start (202 `{ project, run }`). Body: `prompt` plus optional `songSource` (`suno` default, or `local`), `localFallback`, `tools`, `models` (per-tool model pin), `budgetUsd`, `limits`, `checkpoints`, `instrumental`, `guidance`, `providerId`/`model` (brief + lyrics LLM), `authoring` (code-rendered video). |
| `GET` | `/api/music-video/:id/autonomous` | The run. |
| `POST` | `/api/music-video/:id/autonomous/resume` | Approve the checkpoint, retry the stage that stopped, or resume an interrupted run. |
| `POST` | `/api/music-video/:id/autonomous/stop` / `cancel` | Pause / cancel (also stops/cancels its production run). |

Progress is pushed over the `music-video:autonomous` socket event (`{ projectId, runId, run, project }`).

## Scheduled task: `music-video-autopilot`

A programmatic scheduled task (no agent). Each run picks the **oldest active Brain idea no earlier run used** (optionally only ideas carrying one of `ideaTags`), turns it into the prompt and starts an autonomous run with the task's saved settings (`taskMetadata.musicVideoAutopilot`: `songSource`, `localFallback`, `tools`, `models`, `budgetUsd`, `limits`, `checkpoints`, `instrumental`, `guidance`, `providerId`/`model`, `authoring`, `ideaTags`). Set a cadence on its Schedule card; Run Now fires it once.

- It declines while a previous scheduled run is still live, so videos never pile up behind a slow Suno login or a long production.
- An idea counts as used once its run is live or finished; a failed or canceled run leaves the idea available for the next fire.
- The shipped default is the free local tool set with no checkpoints and no budget cap — nothing metered is spent until you opt in.
- Like every scheduled automation it is gated on Config → Improve being enabled.

## Where it lives

`server/lib/musicVideoAutonomous.js` (vocabulary, brief normalizer, Suno limits, idea picker) · `server/services/musicVideo/autonomous{Service,Brief,Board,Suno,LocalSong}.js` · `server/services/musicGeneration.js` · `server/services/scheduledHandlers/musicVideoAutopilot.js` · `client/src/components/musicVideo/Autonomous{StartDrawer,RunPanel}.jsx`.
