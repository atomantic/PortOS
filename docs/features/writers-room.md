# Writers Room

## Intent

Writers Room is the PortOS workspace for creating, organizing, editing, analyzing,
and adapting literary works. It starts as a focused writing environment with
manual AI review actions, then grows into the story-to-media pipeline: prose to
script, script to character sheets and scene plans, scene plans to reference
images and video renders, and a synchronized review surface that keeps prose,
script, and media aligned.

The first version should support three jobs:

1. Manage writing projects: folders, works, drafts, versions, notes, and status.
2. Help the writer produce words: a "write for 10" exercise with timer, live
   word count, and progress tracking.
3. Run explicit AI passes over the current draft: summaries, character and scene
   extraction, expansion recommendations, prose-to-script adaptation, and media
   planning.

Realtime Creative Director feedback and background live analysis are intentionally
future work. In the first implementation, every AI evaluation and render action is
started by a user click.

## Baseline

`main` now contains both FLUX.2-klein image generation and the full Creative
Director / media-job-queue surface — `feat/creative-director` was squash-merged
as PR #191 (`9b36b900`). Phase 0 of this plan is therefore complete; Writers
Room implementation starts directly on `main`.

Reuse — do not rebuild — the existing image/video gen systems:

- `server/services/imageGen/` and `scripts/flux2_macos.py` for image renders.
- `server/services/videoGen/` for LTX/MLX video renders.
- `server/services/mediaJobQueue/` for serializing local image/video jobs.
- `server/services/creativeDirector/` for treatment/scene/run orchestration.
- `server/lib/mediaModels.js` as the source of truth for image/video models
  (including FLUX.2-klein image variants).

## Product Shape

### Navigation

Routes:

- `/writers-room` — Writers Room landing (library + editor)
- `/writers-room/works/:id` — Active work editor

Sidebar placement: a new top-level **Create** group that contains both
**Media Gen** (default landing for the group) and **Writers Room**. Creative
Director continues to live under `/media/creative-director` and is reachable from
Writers Room via the render-plan handoff. Configuration surfaces (Prompts,
Providers) stay under the existing **AI** group.

Add navigation entries in both places PortOS currently needs them:

- `client/src/components/Layout.jsx`
- `server/lib/navManifest.js`

### Primary Layout

The main Writers Room page should be a three-pane workspace:

- Left: library tree with folders, works, tags, status filters, recent drafts,
  and exercise sessions.
- Center: editor for the active draft, with title, metadata, save/version state,
  word count, and selected prose range.
- Right: action sidebar with manual AI tools grouped as Analyze, Adapt, Render,
  and Review.

The first editor can be a high-quality plain text or Markdown editor. Avoid a
rich-text dependency until formatting requirements justify it. The core needs are
stable text ranges, reliable word count, keyboard-friendly writing, and low risk
of corrupting large prose drafts.

### Writing Exercise

The "write for 10" section can live as a tab in Writers Room and as a quick action
from any work.

MVP behavior:

- 10-minute timer with start, pause, resume, finish, and discard.
- Live word count, words added since session start, and optional target progress.
- Session can start from a blank prompt, a selected work, or a selected prose
  segment.
- On finish, save as an exercise session and optionally append/promote it into a
  work draft.
- Track session history: date, duration, starting words, ending words, words
  added, linked work, and prompt.

Do not blend this into POST yet. POST has creative writing drills, but Writers
Room needs an authoring-grade exercise log tied to works and drafts.

## Data Model

Use local, human-readable storage under `data/writers-room/`. Avoid one giant
JSON file for all prose. Store metadata as JSON and draft bodies as Markdown/text
files so long works remain manageable.

Recommended layout:

```text
data/writers-room/
  folders.json
  exercises.json
  works/
    <workId>/
      manifest.json
      drafts/
        <draftVersionId>.md
      analysis/
        <analysisId>.json
      render-plans/
        <renderPlanId>.json
```

### Folder

```json
{
  "id": "wr-folder-...",
  "parentId": null,
  "name": "Novel Drafts",
  "sortOrder": 0,
  "createdAt": "iso",
  "updatedAt": "iso"
}
```

### Work Manifest

The shape that ships in **Phase 1** (matches the on-disk file written by
`server/services/writersRoom/local.js`):

```json
{
  "id": "wr-work-...",
  "folderId": "wr-folder-..." or null,
  "title": "Working Title",
  "kind": "novel|short-story|screenplay|essay|treatment|other",
  "status": "idea|drafting|revision|adaptation|rendering|complete|archived",
  "activeDraftVersionId": "wr-draft-...",
  "drafts": [ /* see Draft Version */ ],
  "createdAt": "iso",
  "updatedAt": "iso"
}
```

**Phase 2+ planned (NOT yet persisted)** — added when the phase that uses
each field ships. Listed here so the data-model story stays continuous, but
the writer/validator drops them as YAGNI today:

```json
{
  "tags": [],
  "collectionId": "media-collection-id",
  "creativeDirectorProjectIds": [],
  "settings": {
    "defaultAnalysisProviderId": null,
    "defaultAnalysisModel": null,
    "defaultImageModelId": null,
    "defaultVideoModelId": null,
    "renderAspectRatio": "16:9",
    "renderQuality": "draft"
  }
}
```

### Draft Version

Draft metadata should be stored in `manifest.json`, with body text in
`drafts/<draftVersionId>.md`.

```json
{
  "id": "wr-draft-...",
  "label": "Draft 3",
  "contentFile": "drafts/wr-draft-....md",
  "contentHash": "sha256",
  "wordCount": 12842,
  "segmentIndex": [
    {
      "id": "seg-001",
      "kind": "chapter|scene|paragraph",
      "heading": "Chapter 1",
      "start": 0,
      "end": 1842,
      "wordCount": 312
    }
  ],
  "createdAt": "iso",
  "createdFromVersionId": null
}
```

The segment index is the foundation for stale-analysis detection and synced
prose/script/media review. AI outputs should attach to a draft version and to
specific segment IDs or character offsets.

### Analysis Snapshot

AI evaluations are immutable snapshots tied to a draft version. If the draft
changes later, show them as stale rather than mutating them silently.

```json
{
  "id": "wr-analysis-...",
  "workId": "wr-work-...",
  "draftVersionId": "wr-draft-...",
  "kind": "summary|characters|scenes|suggestions|expansion|script|media-plan",
  "sourceRange": { "start": 0, "end": 1842, "segmentIds": ["seg-001"] },
  "providerId": "openai",
  "model": "selected-model",
  "status": "queued|running|succeeded|failed",
  "result": {},
  "error": null,
  "createdAt": "iso",
  "completedAt": "iso"
}
```

Expected result schemas:

- Characters: `characters[]` with name, aliases, role, goals, traits,
  relationships, visual spec, first-seen segment, and evidence snippets.
- Scenes: `scenes[]` with summary, location, time, characters, plot beats,
  emotional turn, adaptation notes, and suggested visual prompt.
- Summary: logline, short summary, detailed synopsis, themes, open questions.
- Suggestions: issue/recommendation list with target segment, rationale,
  severity, and optional replacement/continuation text.
- Expansion: continuation options, missing-scene opportunities, character
  deepening notes, pacing recommendations.
- Script: screenplay-style script segments mapped back to prose segment IDs.
- Media plan: character reference prompts, scene reference prompts, shot list,
  video prompts, and Creative Director handoff metadata.

## Backend Plan

### Services

Add `server/services/writersRoom/local.js` for file-backed CRUD and draft I/O.
Keep it the only writer for `data/writers-room/`, matching the pattern used by
Creative Director and Video Timeline.

Responsibilities:

- create/update/delete folders
- create/update/archive works
- read/write draft body files
- create draft versions and compute word count/content hash
- build/update segment indexes
- save immutable analysis snapshots
- save exercise sessions
- create media collections for works when needed
- link works to Creative Director projects, media collections, and timeline
  projects

Add validation in `server/lib/validation.js` or a dedicated
`server/lib/writersRoomValidation.js` if the schemas get large. Keep Zod schemas
strict at the route boundary.

### Routes

Add `server/routes/writersRoom.js`.

Suggested endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/writers-room/folders` | List folders |
| POST | `/api/writers-room/folders` | Create folder |
| PATCH | `/api/writers-room/folders/:id` | Rename/move folder |
| DELETE | `/api/writers-room/folders/:id` | Delete empty folder |
| GET | `/api/writers-room/works` | List work summaries |
| POST | `/api/writers-room/works` | Create work |
| GET | `/api/writers-room/works/:id` | Get manifest, latest draft metadata, latest analysis summaries |
| PATCH | `/api/writers-room/works/:id` | Update work metadata/status/settings |
| DELETE | `/api/writers-room/works/:id` | Archive or delete work |
| GET | `/api/writers-room/works/:id/draft` | Get active draft body |
| PUT | `/api/writers-room/works/:id/draft` | Save active draft body and update segment index |
| POST | `/api/writers-room/works/:id/versions` | Snapshot current draft as a new version |
| GET | `/api/writers-room/works/:id/analysis` | List analysis snapshots |
| POST | `/api/writers-room/works/:id/analysis` | Manually run an AI evaluation |
| GET | `/api/writers-room/analysis/:analysisId` | Get full analysis result |
| POST | `/api/writers-room/exercises` | Start or save exercise session |
| PATCH | `/api/writers-room/exercises/:id` | Finish/discard/update session |
| POST | `/api/writers-room/works/:id/render-plans` | Create media plan from script/scenes |
| POST | `/api/writers-room/render-plans/:id/creative-director` | Create/link Creative Director project |

Analysis can be synchronous for small drafts in v1, but the API should already
carry `status` so it can move to queued/background execution without changing the
UI contract.

### AI Evaluation Service

Add `server/services/writersRoom/evaluator.js`.

Use existing provider and prompt infrastructure instead of hardcoding prompts in
the route. Recommended prompt stages under `data.sample/prompts/stages/`:

- `writers-room-summary.md`
- `writers-room-characters.md`
- `writers-room-scenes.md`
- `writers-room-suggestions.md`
- `writers-room-expansion.md`
- `writers-room-script.md`
- `writers-room-media-plan.md`

Prompt outputs should be JSON-first and schema-validated before persistence. If
validation fails, save the failed analysis snapshot with the raw error and do not
modify the work.

Manual trigger rule:

- No automatic eval on every keystroke.
- No background eval on draft save.
- Buttons in the sidebar trigger exactly one analysis kind for the selected
  range or the active draft.

## Creative Director And Media Integration

### What To Reuse

From `feat/creative-director`:

- `server/services/creativeDirector/local.js` for project state.
- `server/services/creativeDirector/orchestrator.js` for next-task decisions.
- `server/services/creativeDirector/agentBridge.js` and
  `completionHook.js` for CoS task chaining.
- `server/services/mediaJobQueue/index.js` for serializing local image/video
  jobs and avoiding GPU/Metal contention.
- `server/routes/creativeDirector.js` and `server/routes/mediaJobs.js`.
- Creative Director detail UI concepts: treatment, segments, runs.

From latest `main`:

- `server/lib/mediaModels.js` as the source of truth for image/video models,
  including FLUX.2-klein image models.
- `scripts/flux2_macos.py` and `scripts/flux2_quantized.py`.
- `/api/image-gen/models`, `/api/video-gen/models`, media collections, media
  history, and video timeline routes.

### Merge Requirements

When merging Creative Director onto latest main:

- Preserve FLUX.2 model registry fields: `runner`, `quantization`, `repo`,
  `tokenizerRepo`, `basePipelineRepo`, and `isFlux2`.
- Preserve the FLUX.2 setup/status route and HF token/license messaging.
- Keep mediaJobQueue's `providedJobId` behavior for image/video generators so
  queued job IDs match SSE event IDs.
- Re-run and update tests around `imageGen`, `videoGen`, `mediaModels`, and
  `mediaJobQueue`.

### Writers Room Bridge

Writers Room should not duplicate Creative Director. It should create inputs for
Creative Director and link back to its outputs.

Bridge behavior:

1. User runs `media-plan` or `script` analysis on a work or selected range.
2. Writers Room stores a render plan mapped to draft segment IDs.
3. User clicks "Create Creative Director project".
4. Server creates a Creative Director project with:
   - work title as project name
   - selected prose/script as `userStory`
   - work/render style as `styleSpec`
   - selected video model/aspect/quality
   - a media collection shared with the work
5. Creative Director plans and renders only after the user starts it.
6. Writers Room stores the returned `creativeDirectorProjectId` and displays
   Creative Director treatment/scenes/runs inline or through deep links.

For character and scene reference images, use image generation directly through
the existing image-gen route and media job queue. FLUX.2-klein is an image model,
so it is best suited for character sheets, scene references, and mood frames.
Scene videos still go through the configured video model pipeline.

## Synchronized Review Surface

Add this after core analysis and Creative Director handoff are stable.

Goal: let the user see how a story maps across forms.

View modes:

- Prose only
- Script only
- Media only
- Prose + script
- Script + media
- Prose + script + media

Mapping model:

```json
{
  "proseSegmentId": "seg-001",
  "scriptSegmentIds": ["script-001"],
  "mediaSegmentIds": ["media-001"],
  "creativeDirectorSceneIds": ["scene-1"],
  "mediaRefs": [
    { "kind": "image", "ref": "character-ref.png" },
    { "kind": "video", "ref": "video-history-id" }
  ]
}
```

Behavior:

- Selecting prose highlights the mapped script and media.
- Selecting script scrolls prose and media to the mapped segments.
- Media cards show provenance: source prose segment, script segment, prompt,
  model, render job, and Creative Director scene/run when applicable.
- If the draft content hash differs from the analysis/render plan version, show
  stale badges and require a deliberate refresh.

## Frontend Plan

Add:

- `client/src/pages/WritersRoom.jsx`
- `client/src/services/apiWritersRoom.js`
- `client/src/components/writers-room/LibraryPane.jsx`
- `client/src/components/writers-room/WorkEditor.jsx`
- `client/src/components/writers-room/ExercisePanel.jsx`
- `client/src/components/writers-room/AiSidebar.jsx`
- `client/src/components/writers-room/AnalysisPanel.jsx`
- `client/src/components/writers-room/RenderPlanPanel.jsx`
- `client/src/components/writers-room/SyncedReview.jsx`

MVP UI states:

- Empty library
- Create folder/work
- Save draft pending/saved/error
- Unsaved changes
- Exercise running/paused/complete
- Analysis idle/running/succeeded/failed/stale
- Render plan not created/ready/linked/rendering/complete
- Creative Director linked project status

Keep the UI dense and tool-like. This is an authoring workspace, not a marketing
page. Use icons for manual actions, tabs for work surfaces, and fixed panes so
the editor does not jump when analysis cards update.

## Phased Implementation

### Phase 0 - Merge Foundation [DONE]

Completed by squash-merge of `feat/creative-director` (PR #191, commit
`9b36b900`) and the FLUX.2 work that landed alongside it. Image/video routes,
mediaJobQueue, FLUX.2 model registry, Creative Director routes/UI, and SSE
progress all ship on `main` today.

### Phase 1 - Writers Room Core

Goal: works can be created, organized, edited, saved, versioned, and exercised.

- Add storage service, validation, routes, and API client.
- Add `/writers-room` route and nav entries.
- Build library pane and editor.
- Add autosave or explicit save with visible dirty/saved state. Prefer explicit
  save for the first version unless the editor proves stable.
- Add "write for 10" exercise session flow.
- Add word count, selected-range count, and draft version snapshots.

Exit criteria:

- User can create a folder, create a work, write prose, save it, snapshot a
  version, and complete a 10-minute exercise.

### Phase 2 - Manual AI Analysis

Goal: the writer can trigger useful, reviewable AI passes against a draft or
selected segment.

- Add prompt stages and evaluator service.
- Add analysis sidebar buttons for summary, characters, scenes, suggestions,
  expansion, and script.
- Store immutable analysis snapshots tied to draft version/content hash.
- Render structured analysis panels with evidence and stale badges.
- Add "accept into notes" or "copy into draft" only as explicit actions.

Exit criteria:

- No AI pass runs without a click.
- A changed draft marks old analysis as stale.
- Character/scene/script outputs retain source segment mappings.

### Phase 3 - Media Planning And Creative Director Handoff

Goal: a work can become a media plan, reference images, and a Creative Director
project.

- Add media-plan analysis kind.
- Add render plan storage and UI.
- Generate character reference prompts and scene reference prompts.
- Queue selected image previews using configured image model, including FLUX.2
  where available.
- Create/link Creative Director projects from render plans.
- Show Creative Director treatment/scenes/runs inside Writers Room as linked
  project state.

Exit criteria:

- User can select a scene or range, create a media plan, generate reference
  images, create a Creative Director project, and start rendering from a manual
  action.

### Phase 4 - Synchronized Prose, Script, Media Review

Goal: the user can inspect the adaptation chain and see what maps to what.

- Build `SyncedReview` with prose/script/media panes.
- Add segment mapping storage and stale-state detection.
- Support scroll/selection sync between panes.
- Link media items to collection, history, Creative Director scene, and source
  prose/script.

Exit criteria:

- User can open one work and review prose, script, and generated media with
  visible mappings and provenance.

### Phase 5 - Realtime Creative Director Feedback

Goal: evolve from manual passes to controlled live assistance.

- Optional live story continuation suggestions while writing.
- Optional render previews on selected scenes.
- Creative Director can propose next beats, alternate scenes, and visual
  treatments from the active cursor context.
- Add throttling, debouncing, budget controls, and explicit opt-in per work.

This phase should wait until manual analysis quality, mapping, and render costs
are proven.

## Test Plan

Backend:

- Writers Room storage CRUD and atomic writes.
- Draft save/version/content-hash behavior.
- Segment index generation for headings, blank-line scenes, and paragraphs.
- Analysis snapshot validation and stale detection.
- Exercise session lifecycle.
- Creative Director project linking.
- Media job queue integration with image and video job owners.
- Route validation and error shapes.

Frontend:

- Library create/select/delete flows.
- Editor dirty/saved/error state.
- Exercise timer and word-count deltas.
- Analysis sidebar loading, success, failure, stale states.
- Render plan and Creative Director linked-project states.
- Mobile layout for the three-pane workspace.

Regression:

- `/media/image`, `/media/video`, `/media/creative-director`, `/media/timeline`,
  and `/media/collections` still work.
- `server/lib/navManifest.test.js` still passes after adding Writers Room nav.
- FLUX.2 setup/status remains visible and its unsupported LoRA constraints are
  still enforced.

## Non-Goals For MVP

- Realtime background evaluation while typing.
- Multi-user collaboration.
- Rich screenplay pagination/export.
- Automatic rewrite of user prose.
- Fully autonomous story-to-movie generation without manual gates.
- Database migration for writing content.
- Public sharing or publishing workflows.

## Resolved Review Questions

1. **Sidebar placement** — A new top-level `Create` group containing Media Gen
   (default landing) and Writers Room. Prompts and Providers stay under `AI`.
2. **Editor** — Plain Markdown for v1. Revisit when screenplay formatting needs
   pagination.
3. **"Write for 10" sessions** — Can start standalone or attached to a work.
   Default the new-session form to "attach to active work" when one is open.
4. **First media milestone** — Character/scene reference images first, then
   video previews via Creative Director handoff.
5. **Creative Director auto-continue** — Inherit Creative Director's existing
   behavior; do not add a Writers-Room-specific gate. The user already controls
   per-scene start/cancel from the CD detail page.
