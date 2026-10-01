# Autonomous Music Video

One prompt in, a finished music video out. The Music Video page's **Autonomous** entry point (and the `music-video-autopilot` scheduled task) starts a server-owned run that does everything the hand-driven flow asks you to set up first: it writes the creative brief, the lyrics and a mood board, makes the song in Suno, and produces the video with the tools you allowed. Approval checkpoints are optional; with none chosen the run is fully unattended.

## Pipeline

```
brief → lyrics → style → song → analyze → produce
```

| Stage | What happens | Costs |
|---|---|---|
| `brief` | One LLM call turns the prompt into a title, a musical description, a compact Suno style line, a visual concept and a mood-board spec. The project is renamed to the title. | one provider call |
| `lyrics` | Original lyrics written against the musical description (skipped for an instrumental). | one provider call |
| `style` | A **Mood Board** (text notes + a composite look prompt and an avoid list) is created and linked as the project's mood board; the concept is set from the brief. No images are generated. | free |
| `song` | The PortOS Browser drives the Suno web UI (custom mode: lyrics, style, title), the song is downloaded from Suno's CDN into the music library, a Track is created, the take is recorded with `source: 'suno'`, and the project is linked to it. | Suno credits |
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

## Failure handling

- A signed-out Suno parks the run **`needs-human`** (`PUBLISH_LOGIN_REQUIRED`): sign in to Suno in the PortOS Browser, then Resume.
- Any other stage failure parks **`failed`** with the error; Retry re-runs that stage only. Songs already submitted to Suno are stored the moment Suno accepts the request, so a failed download retries the same songs and never spends credits on a second generation.
- A parked or failed delegated production run parks this run `needs-human`; Resume resumes the production run.

The Suno adapter fills the form through `placeholder` / role selectors and reads the new `/song/<id>` links; everything after Create is plain HTTP against the CDN. If Suno redesigns the page, the failing step is named in the error (`Suno: fill the lyrics (…)`).

## API

| Method | Path | |
|---|---|---|
| `POST` | `/api/music-video/autonomous` | Start (202 `{ project, run }`). Body: `prompt` plus optional `tools`, `models` (per-tool model pin), `budgetUsd`, `limits`, `checkpoints`, `instrumental`, `guidance`, `providerId`/`model` (brief + lyrics LLM), `authoring` (code-rendered video). |
| `GET` | `/api/music-video/:id/autonomous` | The run. |
| `POST` | `/api/music-video/:id/autonomous/resume` | Approve the checkpoint, retry the stage that stopped, or resume an interrupted run. |
| `POST` | `/api/music-video/:id/autonomous/stop` / `cancel` | Pause / cancel (also stops/cancels its production run). |

Progress is pushed over the `music-video:autonomous` socket event (`{ projectId, runId, run, project }`).

## Scheduled task: `music-video-autopilot`

A programmatic scheduled task (no agent). Each run picks the **oldest active Brain idea no earlier run used** (optionally only ideas carrying one of `ideaTags`), turns it into the prompt and starts an autonomous run with the task's saved settings (`taskMetadata.musicVideoAutopilot`: `tools`, `models`, `budgetUsd`, `limits`, `checkpoints`, `instrumental`, `guidance`, `providerId`/`model`, `authoring`, `ideaTags`). Set a cadence on its Schedule card; Run Now fires it once.

- It declines while a previous scheduled run is still live, so videos never pile up behind a slow Suno login or a long production.
- An idea counts as used once its run is live or finished; a failed or canceled run leaves the idea available for the next fire.
- The shipped default is the free local tool set with no checkpoints and no budget cap — nothing metered is spent until you opt in.
- Like every scheduled automation it is gated on Config → Improve being enabled.

## Where it lives

`server/lib/musicVideoAutonomous.js` (vocabulary, brief normalizer, Suno limits, idea picker) · `server/services/musicVideo/autonomous{Service,Brief,Board,Suno}.js` · `server/services/scheduledHandlers/musicVideoAutopilot.js` · `client/src/components/musicVideo/Autonomous{StartDrawer,RunPanel}.jsx`.
