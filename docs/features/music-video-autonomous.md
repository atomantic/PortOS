# Autonomous Music Video

One prompt in, a finished music video out. The Music Video page's **Autonomous** entry point (and the `music-video-autopilot` scheduled task) starts a server-owned run that does everything the hand-driven flow asks you to set up first: it writes the creative brief, the lyrics and a mood board, makes the song (in Suno, or on this machine), and produces the video with the tools you allowed. Song-writing checkpoints are optional. Production requires revision-bound approval of the visual guide and lyric-timed storyboard. An animated proof is an optional check; it never holds the final render. Authenticated sessions may grant automatic planning approvals.

## Pipeline

```
brief → lyrics → style → song → analyze → produce
```

| Stage | What happens | Costs |
|---|---|---|
| `brief` | One LLM call turns the prompt into a title, a musical description, a compact Suno style line, a visual concept and a mood-board spec. The project is renamed to the title. | one provider call |
| `lyrics` | Original lyrics written against the musical description (skipped for an instrumental). With the lyric review on, a second pass then reviews and revises the draft (see [Models per stage](#models-per-stage)). | one provider call (two with the review) |
| `style` | A **Mood Board** (text notes + a composite look prompt and an avoid list) is created and linked as the project's mood board; the concept is set from the brief. No images are generated. | free |
| `song` | The PortOS Browser drives the Suno web UI (custom mode: lyrics, style, title), only M4A is selected in Suno's Download UI and the completed audio is validated and imported directly into the music library, a Track is created, the take is recorded with `source: 'suno'`, and the project is linked to it. | Suno credits |
| `song` (local) | `songSource: 'local'` renders the song with the on-device Music Designer engines instead (see [Local song source](#local-song-source)). | free (GPU time) |
| `analyze` | The usual offline beat / tempo / section analysis. | free |
| `produce` | **Footage** (any image/video tool picked): the existing server-owned production run (`/production-runs`) with a pool built from the picks, then the final render once it completes. **Code** (only `code:render`): a code-rendered video is authored after storyboard approval and goes straight to the final render. | per tool |

State lives on the project as `autonomousRun` — install-local like `productionRuns` (stripped from the peer wire, not carried into a clone). Each stage settles in one serialized project write, so a crash resumes at the stage that did not settle. After a server restart a run is shown **interrupted** and nothing advances until you resume it (no cold-bootstrap provider calls).

## Checkpoints

`checkpoints` names the stages that park the run in `awaiting-approval` until you approve:

- `lyrics` — review/edit the lyrics before anything else is spent.
- `style` — review the mood board and edit the Suno style line; the last stop before Suno credits are used.
- `song` — listen to the Suno song before the image/video quota is spent.
- `cast` — flips the existing Cast & Sets check-in to *review* (the production run owns it).

Approving can carry edits (`POST /api/music-video/:id/autonomous/resume` with `{ lyrics }`, `{ style }` or a `{ suno }` options patch).

**Retake song.** At the `song` checkpoint the run panel also offers **Retake song** (`{ retakeSong: true }` on resume, combinable with the lyrics, style and `suno` edits). It discards the song from the run — its track link, Suno song ids, source and any local render — resets the `song` stage, makes a new song (a new Suno generation spends credits again) and parks at the `song` checkpoint once more. The rejected track stays in the music library; only the project's link to it is cleared, which keeps the lyric cues' text and clears their timings until the new song re-seeds them. A retake anywhere else is refused with 409 `NOT_AT_SONG_CHECKPOINT`.

## Models per stage

By default every LLM step runs on the one **direction LLM** (`providerId`/`model`/`effort` on the start request, stored as the brief's `llm`). A start request may instead route each step to its own provider, model and effort with `llmStages`:

| Stage | Runs |
|---|---|
| `brief` | the creative brief |
| `lyrics` | the lyric draft |
| `lyricsReview` | the lyric review & revise pass |
| `castAndSets` | the Cast & Sets direction call (production) |
| `plan` | the shot plan's scene prompts (production) |
| `authoring` | code authoring of a code-rendered video |

For example, a cheap local model drafts the lyrics and a stronger one reviews them; one model plans the cast and scenes and a stronger one authors the animation code. Each step resolves its provider in a fixed order (`server/services/musicVideo/llmRoute.js`):

1. a pin on the request itself (an explicit pick in a hand-driven panel);
2. the stage's pin (`llmStages[stage]`) — the route records `source: 'stage'`;
3. for `authoring` only, the run's separate code-authoring pin (`authoring`);
4. the direction LLM (`llm`);
5. an eligible TUI provider, then the install's active provider.

A pin whose provider no longer exists gives way to the next one, and the route names it (`requestedProviderId`). `llmStages` is stored on the run's brief and copied into the project's automation brief, so the production stages started later (Cast & Sets, shot planning, code authoring) follow it too; each stage's last route is kept in the brief's `routes` (the autonomous text stages also keep theirs on the run output: `briefRoute`, `lyricsRoute`, `lyricsReviewRoute`). Code authoring is the exception: it runs inside production, whose creative basis includes the brief, so its route is not written back.

**Lyric review.** Set `lyricsReview: true` (or pin `llmStages.lyricsReview`, which turns it on by itself) and the `lyrics` stage runs two steps — `draft` then `review`, shown as `stages.lyrics.step` — on the stage list's single `lyrics` entry. The review keeps the title, the section tags and roughly the same length, improves scansion, punch and argument, and adds no new topics. The run keeps the first draft (`output.lyricsDraft`), the revision (`output.lyrics`, what the `lyrics` checkpoint shows and Suno receives) and the reviewer's short critique (`output.lyricsReviewNotes`). The draft is stored before the review runs, so a failed review retries only the review.

The start drawer and the scheduled task's settings show a collapsible **Models per stage** section with the lyric-review toggle; each stage offers *Default (use direction LLM)*. On an automation-first project, the autopilot brief (Project settings › Autopilot → Edit brief, and the create drawer) offers the same section for the stages a saved project runs — Cast & Sets direction, shot plan and code authoring — next to the direction LLM picker; a patch merges per stage, and a stage set back to Default is sent as `null` to clear its pin.

## Suno form options

A start request (and the scheduled task's settings) may carry an optional `suno` object for Suno's Advanced form, stored on the run's brief:

- `excludeStyles` — Suno's **Exclude styles** field (up to 500 characters). An explicit empty string clears whatever Suno kept from its previous draft; omitting it leaves the field as Suno has it.
- `vocalGender` — `male` or `female`; clicks Suno's matching button. Not sent for an instrumental.
- `model` — a model version such as `v6`; the driver opens the version menu only when the current version differs.

All three live under Suno's **More Options** section (expanded on demand) or its version menu. Each is a no-op when unset. When the page has no such control (an older Suno UI) or the version menu does not list the requested model, the driver logs a warning and continues with Suno's current setting rather than failing the song. The start drawer shows these fields when Suno is the song source; a resume may patch them key by key (`null` clears one).

## Production review

The **Production review** panel is shared by the manual and autopilot paths. Prepare or import an unapproved planning draft, attach an actual visual sheet, and edit cast, environment, visual and motion direction. The implementation field records scene layers, geometry, rig/pose limits, materials, typography, camera/transition mechanics and performance constraints for the selected renderer. Static concept references communicate intent; they are never animated proof.

Imported storyboard shots may remain unbound. Bind each to an existing Board scene or explicitly create its scene; an import never invents approval or verifies provisional timings. Vocal songs require bounded positive-duration word timings checked against the current master. An instrumental exception requires a rationale and cannot mask existing lyric cues.

Art, storyboard and proof decisions bind to exact content. Changes invalidate affected downstream approvals. Targeted comments and requests for changes retain the original reviewed draft and scene snapshot; unresolved requests block the affected stage. Accepting structure records organizational agreement only. Regeneration receives unresolved feedback; an authenticated reviewer must resolve it and approve the revised content.

After art and storyboard approval you may render a 10–45 second chorus proof, watch it with audio and approve that revision; the composition preview usually makes this unnecessary. A footage production run still pauses on its pilot proof before paid bulk generation. Queued provider work and final renders recheck the storyboard approval before dispatch.

Approval and feedback resolution use an existing authenticated PortOS session: browser cookies and agent bearer sessions have the same creative-review authority, without password re-entry. Missing, invalid, expired or revoked sessions cannot approve; auth-off and peer/Basic access do not confer creative-review authority. The server records the verified session ID and label, never the credential, along with revision-bound decision history. A shared agent session identifies the credential, not an individual agent or a human. Older clients may send a password, but it is discarded rather than used as approval authority.

The review panel shows the selected visual guide and its version, the saved storyboard shots and timing (including document manifests independently of Board scenes), or the exact registered proof before the decision. Reference contact sheets are labeled separately because they may predate the current document. Missing files and failed proof playback show a recovery action and block the corresponding UI approval. **Request changes** opens feedback for that review stage.

A proof approval is bound to its exact excerpt ID and filename; `energyComparison` and `timecodedNotes` are optional notes. Human playback uses `watchedWithAudio: true`. An authenticated agent can submit `method: 'machine'`, `watchedWithAudio: false`, and `machineEvidence` containing substantive `visualReview`, `audioReview`, and `limitations`, alongside the same excerpt ID and filename. The observations must come from actual motion and audio review against the saved plan; technical validation, isolated still frames or a completed render do not establish choreography quality. If the available tools cannot assess motion and audio, leave approval pending. The UI distinguishes machine review from playback. Persisted automatic waivers no longer count as approved proof; valid art and playback decisions remain valid.

**Automatic planning approvals.** An authenticated start or `POST /api/music-video/:id/autonomous/resume` can grant `autoApprove: ['art', 'storyboard']` (any subset). The run records `brief.autoApprove`, `brief.autoApproveAuthorizedAt`, and `brief.autoApproveAuthorizedBy`; automatic decisions also record the run ID. A resume list replaces the grant; explicit `[]` revokes it and also requires authentication. Omitting the list preserves the existing policy. In **Produce**, the run first waits for Cast & Sets to draft the art guide (`stages.produce.step: 'cast-and-sets'`; its settle event carries the run on, and a failed Cast & Sets fails the run with `CAST_SETS_FAILED`), so the art gate is never judged empty. A `storyboard` grant also makes the run do the lyric-timing chores a director would: after analysis it aligns the vocal to the lyric sheet and times lines alignment skipped, then before the storyboard gate it verifies the timing (reviewer `{ kind: 'autopilot', runId }`), marks an instrumental song as one, and anchors each shot to the lyric lines it overlaps. It verifies only timings it can trust: when alignment failed or the recognizer heard less than half of the words, the timings are mostly guesses, so it leaves them provisional and parks the run with that reason. Automatic planning approval still requires a clean readiness report; a line it cannot time, or any other open problem, still parks the run. Proof is never auto-approved; a legacy brief listing `proof` is ignored for it, since the final render no longer waits on a proof. Start drawer and run panel expose the planning choices without a password field, and the run panel shows existing grants so they can be revoked.

External draft preparation uses the existing authenticated session without password re-entry; agents may prepare drafts. PortOS never submits a final post: review and publish on the destination platform, then record the resulting link. Existing projects and assets remain intact, but an older project's final render now requires the same production review.

The local browser acceptance test (`server/routes/musicVideoProductionReview.browser.test.js`) exercises the real React controls, approval routes, native code renderer, ffmpeg output and video playback with synthetic data. It requires Chrome, ffmpeg and installed client dependencies; server-only CI skips this cross-workspace check. API and orchestration tests run independently of those visual-test prerequisites.

## Orchestrated mode

Choose **Who reviews each step → Orchestrator** in the start drawer to let a model act as the director at every review point, so a run finishes with no human stops. Pick the orchestrator's provider, model and effort (any provider PortOS has configured, local or cloud) and how many revisions it may ask for per step (`limits.maxReviewAttempts`). The request sends `orchestrator: { providerId, model?, effort? }`; the brief stores it with `orchestratorAuthorizedAt`/`orchestratorAuthorizedBy`. Because the orchestrator approves Production review stages, only an authenticated session may start one (401/403 otherwise), and the scheduled task never carries one. An orchestrated brief has no `checkpoints` and ignores `autoApprove`.

| Review point | When | What the orchestrator does |
|---|---|---|
| Lyrics | end of **Lyrics** | Approves, or returns rewritten lyrics and judges them again |
| Sound & look | start of **Mood board & style** | Approves, or sharpens the song style line, the visual style and the look prompt before the song and mood board are made from them |
| Song | end of **Analyze** | Aligns the vocal to the lyric sheet (and gives skipped lines evenly spaced word timings), then judges duration, sections and the share of lyric words the recognizer heard. A rejected local song is retaken; a Suno song is kept, since a retake spends credits |
| Art direction | **Produce** | Reads the cast, environments, visual and motion guides (and the guide sheet when it is an image and the model can see), approves or rewrites fields |
| Lyric timing | **Produce** | Verifies the aligned timings when every line carries bounded word timings, alignment ran without error and the recognizer heard at least half of the words; otherwise leaves them for a director |
| Storyboard | **Produce** | Anchors shots to the lyric lines they overlap, fills blank fields, approves or files change requests that re-plan the named shots, then resolves them |
| Final video | after the final render | Looks at 24 frames sampled across the film (when the model can see) and logs a verdict with timecoded issues; nothing is re-rendered |

Production's plate and draft reviews use the orchestrator too. Each decision lands in `run.orchestration.reviews` (`checkpoint`, `verdict` of `approve`/`revise`/`retake`/`noted`, `score`, `notes`, `changes`, `issues`, `route`), which the run panel shows as a decision log. When the revision limit is reached the latest version is accepted and the note says so. Each revision is stored with its log entry (`output.lyricsForReview`, `output.styleDraft`), so a Retry after a failed review judges the latest revision rather than the first draft. A storyboard re-plan that fails fails the stage (`ORCHESTRATOR_REVISION_FAILED`) instead of approving the unchanged shot; Retry asks the orchestrator again. A readiness problem the orchestrator cannot fix still parks the run for a human, with the problem named. The orchestrator never publishes.

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
- Resume after Stop waits for the prior stage attempt to settle before restarting. A Cancel while Resume waits remains canceled.
- A parked or failed delegated production run parks this run `needs-human`; Resume resumes the production run.

The Suno adapter fills the form through `placeholder` / role selectors and reads the new `/song/<id>` links. It opens the first take in the same signed-in PortOS Browser, selects only M4A, and presses Download (or Unlock & Download) once. It waits for the browser download to finish saving, checks the container and decodes the complete audio to reject damaged files, and imports the original M4A without conversion. The export has a ten-minute deadline; timeout, cancellation, or invalid audio removes staging files and never imports a partial/error response. Failures identify the export stage using bounded reason metadata. A retry reopens the existing song rather than pressing Create again.

## API

| Method | Path | |
|---|---|---|
| `POST` | `/api/music-video/autonomous` | Start (202 `{ project, run }`). Body: `prompt` plus optional `songSource` (`suno` default, or `local`), `localFallback`, `suno` (Suno form options), `tools`, `models` (per-tool model pin), `budgetUsd`, `limits`, `checkpoints`, `instrumental`, `guidance`, `providerId`/`model`/`effort` (the direction LLM), `llmStages` (per-stage LLM pins), `lyricsReview`, `authoring` (code-rendered video), `autoApprove` (authenticated planning grant, see Production review), `orchestrator` (authenticated; see Orchestrated mode). |
| `GET` | `/api/music-video/:id/autonomous` | The run. |
| `POST` | `/api/music-video/:id/autonomous/resume` | Approve the checkpoint, retry the stage that stopped, or resume an interrupted run. Optional `lyrics`, `style`, `suno` edits; `retakeSong: true` at the song checkpoint; `autoApprove` to grant or revoke automatic planning approvals using the authenticated session. |
| `POST` | `/api/music-video/:id/autonomous/stop` / `cancel` | Pause / cancel (also stops/cancels its production run). |

Progress is pushed over the `music-video:autonomous` socket event (`{ projectId, runId, run, project }`).

## Scheduled task: `music-video-autopilot`

A programmatic scheduled task (no agent). Each run picks the **oldest active Brain idea no earlier run used** (optionally only ideas carrying one of `ideaTags`), turns it into the prompt and starts an autonomous run with the task's saved settings (`taskMetadata.musicVideoAutopilot`: `songSource`, `localFallback`, `suno`, `tools`, `models`, `budgetUsd`, `limits`, `checkpoints`, `instrumental`, `guidance`, `llm`, `llmStages`, `lyricsReview`, `authoring`, `ideaTags`). Set a cadence on its Schedule card; Run Now fires it once.

- It declines while a previous scheduled run is still live, so videos never pile up behind a slow Suno login or a long production.
- An idea counts as used once its run is live or finished; a failed or canceled run leaves the idea available for the next fire.
- The shipped default is the free local tool set with no checkpoints and no budget cap — nothing metered is spent until you opt in.
- Like every scheduled automation it is gated on Config → Improve being enabled.

## Where it lives

`server/lib/musicVideoAutonomous.js` (vocabulary, brief normalizer, Suno limits, idea picker) · `server/services/musicVideo/autonomous{Service,Brief,Board,Suno,LocalSong}.js` · `server/services/musicGeneration.js` · `server/services/scheduledHandlers/musicVideoAutopilot.js` · `client/src/components/musicVideo/Autonomous{StartDrawer,RunPanel}.jsx`.
