# Writers Room

Writers Room is the PortOS workspace for creating, organizing, editing, analyzing, and adapting literary works: a focused writing environment with manual AI passes, a story bible, storyboarding, and bridges into the Creative Director and comic-pipeline media systems.

Every AI evaluation and render action is user-initiated or explicitly opted into — nothing runs on keystrokes or draft saves without the per-work Live Director opt-in described below.

## Navigation & Layout

Routes (registered in `App.jsx` and `server/lib/navManifest.js` — `nav.writers-room`, `nav.writers-room.guide`):

- `/writers-room` — landing (library + editor)
- `/writers-room/works/:workId` — active work editor
- `/writers-room/guide` — writing guide (length targets, craft reference)

The page lives in the sidebar's **Create** group. The main workspace is `client/src/pages/WritersRoom.jsx` with a library pane (`LibraryPane.jsx`), the Markdown work editor (`WorkEditor.jsx`), and tool panels. The editor is plain Markdown — stable text ranges, reliable word count, low corruption risk for long prose.

## Writing Exercise ("write for 10")

`ExercisePanel.jsx` runs timed free-write sprints (default 10 minutes, clamped 1–60): start, finish, or discard, with live word count. Sessions can start standalone or attached to a work, and history records date, duration, word deltas, linked work, and prompt. Finished sprint text is stored as `appendedText` on the exercise record.

Not built (deliberately deferred): pause/resume mid-session, and a "promote to draft" action that merges `appendedText` into the work — the session record carries everything needed to add it later.

## Storage

Metadata (folders, work manifests, decomposed draft versions, exercises) persists through the storage dispatcher `server/services/writersRoom/store.js`: **PostgreSQL on a normal install** (#1017), with the legacy on-disk JSON layout under `data/writers-room/` remaining only as a dev/test escape hatch. Draft **prose bodies always stay on disk** as Markdown files (`works/<workId>/drafts/<draftVersionId>.md`) regardless of backend — long works never live inside a database row or a giant JSON blob. `store.js` decomposes `drafts[]` into rows on PG and reassembles on read, so the manifest shape is backend-independent.

`server/services/writersRoom/local.js` is the single owner of work/folder/draft/exercise storage; `db.js` is the PG backend.

### Work manifest

Persisted fields: `id`, `folderId`, `title`, `kind` (novel/short-story/screenplay/essay/treatment/other), `status` (idea/drafting/revision/adaptation/rendering/complete/archived), `activeDraftVersionId`, `drafts[]`, `createdAt`, `updatedAt`. Users can edit `title`, `folderId`, `kind`, `status`, `imageStyle`, and the partial-merged `liveMode` config. Server-owned link fields are stamped by their own flows, never by user PATCH: `mediaCollectionId` (auto-created media collection), `cdProjectId` (Creative Director link), `pipelineSeriesId`/`pipelineIssueId` (comic-pipeline promotion).

### Draft versions

Each draft version records `id`, `label`, `contentFile`, `contentHash`, `wordCount`, `segmentIndex`, `createdAt`, `createdFromVersionId`. The **segment index** (chapter/scene/paragraph ranges with character offsets) is the foundation for stale-analysis detection and the synced review surface — AI outputs attach to a draft version and to specific segment IDs.

## Analysis (manual AI passes)

`server/services/writersRoom/evaluator.js` runs user-clicked passes against the active draft, pinning the source draft's `contentHash` so the UI can flag stale results when the prose changes. Analysis kinds map to prompt stages in `data.reference/prompts/stages/`:

| Kind | Stage | Output |
|------|-------|--------|
| `evaluate` | `writers-room-evaluate.md` | Editorial evaluation of the draft |
| `format` | `writers-room-format.md` | Formatting/structure pass |
| `script` | `writers-room-script.md` | Screenplay-style scenes mapped back to prose segment IDs |
| `characters` | `writers-room-characters.md` | Character extraction into the story bible |
| `places` | `writers-room-places.md` | Place extraction |
| `objects` | `writers-room-objects.md` | Object extraction |

(Two more stages back the live features: `writers-room-continue.md` and `writers-room-cd-bridge.md`.) Outputs are JSON-first and schema-validated before persistence. Client: `AnalysisHistory.jsx`. Scene images can be attached to script-analysis scenes (`POST .../analysis/:analysisId/scene-image`) and persist into the work's media collection.

## Story Bible

Characters, places, and objects extracted by analysis (or entered by hand) live as per-work bible entities with full CRUD (`characters.js` / `places.js` / `objects.js`; client `CharactersBible.jsx`, `PlacesBible.jsx`, `ObjectsBible.jsx`, `StoryboardBibleTab.jsx`). Extraction merges into existing entries rather than duplicating.

## Storyboard & Media

The storyboard suite (`StoryboardPanel.jsx`, `StoryboardScenesTab.jsx`, `StoryboardBoardsTab.jsx`, `StoryboardConfigTab.jsx`, `SceneCard.jsx`) turns script-analysis scenes into rendered boards through the existing image-gen pipeline and media job queue. Scene images ride the shared media-collection infrastructure — a work auto-creates its collection on first render.

There is no persisted "render plan" store (the originally planned `render-plans` endpoints were never built); scene→media mapping is derived on read (see Synchronized Review below) and Creative Director handoff goes through the CD bridge.

## Creative Director Bridge

The live-mode sidebar can turn the prose around the cursor into a short Creative Director **treatment** — logline, synopsis, overall visual treatment, and 2–6 filmable scenes (beat + visual prompt + duration). The writer reviews the proposal in the CD Bridge panel (`CdBridgePanel.jsx`) and sends it into a **new** Creative Director project seeded with that treatment (`POST .../cd-bridge/suggest` + `.../cd-bridge/send`, backed by the `writers-room-cd-bridge` stage). The bridge is non-destructive — it always creates a fresh project — and the work links to it via `cdProjectId` with an "Open in Creative Director" jump.

## Pipeline Promotion

`POST /works/:id/promote-to-pipeline` (`promoteToPipeline.js`) promotes a work into the comic pipeline, creating a series and first issue and stamping `pipelineSeriesId`/`pipelineIssueId` on the manifest.

## Live Director (opt-in realtime assistance)

`server/services/writersRoom/liveDirector.js` powers the editor's per-work, off-by-default "Live Director" mode:

- **Live continuation** — while the writer pauses, asks for 2–4 short continuation options (beats, insertable prose snippets, dialogue lines) from the prose around the cursor, surfaced in `LiveContinuationPanel.jsx`; `prose`/`dialogue` options insert at the caret. Backed by the `writers-room-continue` stage (quick tier).
- **Live render previews** — on-demand scene render reservations (`LiveRenderPanel.jsx`), with a separate daily render budget.

Controls are enforced server-side, not just in the UI: per-work opt-in toggle (requests 409 when off), a client debounce after typing stops (`liveMode.debounceMs`, default 2.5s), and daily budgets (`liveMode.dailyCallBudget`, default 100, `0` = unlimited; plus `dailyRenderBudget`) that roll over at UTC midnight and 429 when spent. Usage counters are server-owned and stripped from user updates.

## Synchronized Review Surface

`GET /works/:id/synced-review` (`server/services/writersRoom/syncedReview.js`, client `SyncedReview.jsx`) lets the user see how a story maps across forms — prose, script, and media side by side, with selection sync between panes.

The mapping model is a **relational read-model derived on request** rather than a persisted mapping store:

- Prose segments come from the active draft's `segmentIndex`.
- Script scenes come from the latest `script` analysis, whose scenes carry `sourceSegmentIds` back-references.
- Media comes from the analysis snapshot's scene-image map.

Selecting prose highlights the mapped script and media; media cards show provenance (source segments, prompt, model, render job). Staleness falls out of the pinned analysis `sourceContentHash` — when the draft's hash differs, the UI shows stale badges and requires a deliberate re-run. Media attached to scenes that no longer exist after re-extraction is surfaced explicitly as orphaned rather than silently dropped.

## Federation

Writers Room content syncs across peers: record kinds `writersRoomWorks`, `writersRoomFolders`, and `writersRoomExercises` are registered in `server/lib/schemaVersions.js` with per-record peer-sync push (#1565/#1645). `local.js` emits record events through `sharing/recordEvents.js`; draft `.md` bodies and scene-image assets ride the peer-sync body/asset lanes, and conflict-restore handlers cover exercises and bodyless records.

## API Surface

All under `/api/writers-room` (`server/routes/writersRoom.js`, client wrapper `client/src/services/apiWritersRoom.js`):

- **Folders** — `GET/POST /folders`, `DELETE /folders/:id`
- **Works** — `GET/POST /works`, `GET/PATCH/DELETE /works/:id`, `POST /works/:id/promote-to-pipeline`
- **Drafts/versions** — `PUT /works/:id/draft`, `POST /works/:id/versions`, `GET/PATCH /works/:id/versions/:draftId` (PATCH sets active)
- **Exercises** — `GET/POST /exercises`, `POST /exercises/:id/finish`, `POST /exercises/:id/discard`
- **Analysis** — `GET/POST /works/:id/analysis`, `GET /works/:id/analysis/:analysisId`, `POST .../scene-image`
- **Live director** — `POST /works/:id/live-suggest`, `POST /works/:id/live-render-preview`, `POST /works/:id/cd-bridge/{suggest,send}`
- **Synced review** — `GET /works/:id/synced-review`
- **Story bible** — `GET/POST /works/:id/{characters,places,objects}`, `PATCH/DELETE /works/:id/{characters,places,objects}/:entityId`

Route inputs are Zod-validated at the boundary (`server/lib/validation.js`).

## Tests

Most services carry sibling `.test.js` suites (storage CRUD, draft save/version/content-hash behavior, segment indexing, analysis stale detection, exercise lifecycle, live-director gating/budgets, synced-review derivation, sync logic). `server/lib/navManifest.test.js` covers the nav entries; route validation is covered in the routes suite.

## Related Features

- Creative Director (`server/services/creativeDirector/`, `/media/creative-director`) — treatment/scene/run orchestration the CD bridge feeds into
- Comic pipeline — the promote-to-pipeline target
- Media collections, image-gen, and the media job queue — shared render infrastructure
