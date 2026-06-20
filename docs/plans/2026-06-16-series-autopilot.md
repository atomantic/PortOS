# Series Pipeline — Full Autonomous Mode ("Series Autopilot")

## Context

The Series Pipeline today is a sequence of manually-triggered LLM/render steps: generate arc → generate
issues → verify/resolve arc → per-issue text stages (idea → prose → comicScript/teleplay) → editorial review
→ comic cover + pages. Every step is its own button/endpoint. Driving a whole graphic novel to completion
means a human babysitting dozens of clicks across many issues.

The ask: a single **"Run Autonomously to Completion"** control that takes a series and drives it from
*wherever it currently is* to a terminal **story-ready + draft visuals** state, going through every missing
step automatically. Per the user's steer — *"most of the pipeline itself can be a script that just triggers
each of the APIs"* — the orchestrator is a **conductor that composes the existing service functions**, not a
re-implementation of generation logic.

Two hard constraints from the user:
1. **Never undo in-progress work.** The real test series
   `https://null.taile8179.ts.net:5555/pipeline/series/ser-b74601a3-221d-4491-b037-bad51df8460a` already has a
   partially-generated arc and a partially-built first issue. Autopilot must inspect current state and resume
   from the first *missing* step, never regenerate what exists.
2. **Arc verification may never fully converge** — re-running verify surfaces *new* findings even after
   fixing all prior ones. The resolve loop must be bounded and must **pause for human review** when it can't
   reach clean, rather than spinning or silently proceeding.

Decisions from the user:
- **Scope:** one run targets the **entire series** — walk every season/volume in order.
- **Visuals:** render **cover + back cover + all interior pages** in draft mode.
- **Non-convergence:** **pause for human review** after the bounded rounds.

## Design principle: resume is a pure function of current state

The heart of the orchestrator is a **pure next-step resolver** — `resolveNextStep(series, issues, runState)`
— that returns the first unmet step given the series' canonical records. Because "what to do next" is derived
from state (not a stored cursor), the design is naturally **resumable and non-destructive**: it skips any
stage that's already `ready`/`edited` (`isStageReady`), runs every generation with `force:false`, and on a
crash/restart simply resumes at the first still-missing step. This is exactly what satisfies constraint #1 on
the live test series.

## Verified building blocks (reuse — do not reinvent)

Service layer (`server/services/pipeline/`):
- `arcPlanner` barrel → `generateArcOverview`, `commitSeasonsWithRemap`, `generateSeasonEpisodes`,
  `commitEpisodesToIssues`, `verifyArc(seriesId,opts)` (arcCore.js:231), `verifyVolume` (arcCore.js:292),
  `resolveVerifyIssues(seriesId,{findings,...})` (arcCore.js:322). verify* return
  `{ issues:[{severity,location,problem,suggestion}], runId, ... }`.
- `volumeBeatsRunner.startVolumeBeatsRun(seriesId,seasonId,{mode,providerId,model})` — **serial** per-issue
  idea/beat generation (neighbor context), SSE keyed by seasonId, `isVolumeBeatsRunActive`,
  `cancelVolumeBeatsRun`, `VOLUME_BEATS_MODES`.
- `autoRunner.startAutoRunTextStages(issueId,{force,includeVideo})` — idea→prose→(comicScript+teleplay), SSE
  keyed by issueId, `isAutoRunActive`, `cancelAutoRun`, `recoverStuckAutoRuns()` (autoRunner.js:201).
- `textStages.generateStage`; `issues.isStageReady` (issues.js:117), `STAGE_IDS`/`TEXT_STAGE_IDS`/
  `VISUAL_STAGE_IDS` (101-108), `ISSUE_STATUSES` (123), `queueSeriesIssuesWrite` (57),
  `getIssue/listIssues/updateIssue/updateStage`.
- Editorial: `editorialAnalysis.analyzeIssue` (179); `manuscriptReview.seedReviewFromFindings` (175);
  `manuscriptFix.generateManuscriptFix` (461) / `acceptManuscriptFix` (559).
- Visual/draft terminal: `visualStages.enqueueComicCover` (504), `enqueueComicBackCover` (517),
  `enqueueVisualComicPage` (752); page/cover extraction service behind route
  `POST /issues/:id/stages/comicPages/extract-pages` (requires comicScript output; parses pages + cover
  concepts), cover render routes in `covers.js` (187/204/217).
- Series shape: `TARGET_FORMATS` ['comic','tv','comic+tv'] (series.js:72), `series.arc`, `series.seasons[]`,
  `series.locked`, `series.primaryManuscriptType`.

Infra: `sseUtils` (`broadcastSse`,`attachSseClient`,`closeJobAfterDelay`,`SSE_CLEANUP_DELAY_MS`);
`cosTaskStore.addTask(data, taskType, {raw})` (already dedups pending/in_progress by description+app,
cosTaskStore.js:130); `domainAutonomy.getDomainMode(config,'cos')`;
`domainUsage.getDomainBudgetStatus('cos')` / `recordDomainUsage('cos',{actions})` (gating precedent
cosJobScheduler.js:207-238); `useSseProgress` hook (client).

**Pattern to mirror exactly:** `editorialAnalysisRunner.js` — most complete runner lifecycle (`finished`
flag, `cleanupTimer`, restart-replace, single permitted try/catch boundary in the fire-and-forget IIFE,
cancel flag between steps, `export const __testing = { runs }`).

## "Script verification" is a known gap (called out, not silently solved)

There is **no dedicated comic-script verify endpoint** today. For MVP, define "script ready" as:
1. **Structural gate (pure, no LLM):** comicScript `isStageReady` AND the extract-pages parser yields ≥1
   page with ≥1 panel + a cover concept (reuse the parser the extract-pages route already imports).
2. **Editorial gate:** run `analyzeIssue`; treat **high-severity** findings as blocking and auto-resolve via
   `seedReviewFromFindings` → `generateManuscriptFix` → `acceptManuscriptFix`, bounded.

A real LLM `pipeline-script-verify` prompt + migration is an explicit **Phase 3 follow-up**, documented in
code comments so the gap isn't assumed solved.

## 1. Orchestrator — `server/services/pipeline/seriesAutopilot.js` (NEW)

In-memory `runs` Map keyed by **seriesId** (one autopilot per series; a second start while active resolves to
the existing runId). Fire-and-forget IIFE with the single permitted try/catch boundary; cancel flag checked
between every step. Mirror `editorialAnalysisRunner.js` structure.

### 1a. Pure resolver — `resolveNextStep(series, issues, runState)` (highest-value unit)

No I/O; caller passes fresh `series` + `issues[]` + accumulated `runState` (verify flags). Returns a
discriminated step `{ kind, seasonId?, issueId?, reason }` or `{ kind:'done' }`. First unmet wins, **whole
series**:

```
STEP 1  no arc            -> !series.arc?.logline && !series.arc?.summary   => generateArc
STEP 2  season w/ 0 issues (in season order)                                => generateEpisodes(seasonId)
STEP 3  arc not verified-clean this run (runState.arcVerified !== true)     => verifyArc
STEP 4  per issue, ordered by season then arcPosition/number, first where:
          a) idea not ready                        => beatSheet(seasonId)   (serial volume run)
          b) prose / comicScript / teleplay not ready (per primaryManuscriptType) => textStages(issueId)
          c) script not structurally+editorially ready => scriptVerify(issueId)
          d) comicPages empty (cover+back+pages)   => visualDraft(issueId)
STEP 5  nothing unmet                                                       => done
```

Readiness reuses `isStageReady`. Re-run after every completed step against freshly re-read records →
resumable, non-destructive.

### 1b. Run loop (conductor)

`startSeriesAutopilot(seriesId, options)` → `{ runId, alreadyRunning, mode, sseUrl }`. Inside the IIFE:
`while (!cancel)` re-read series+issues → `resolveNextStep` → dispatch:

- **generateArc:** `generateArcOverview` → `commitSeasonsWithRemap`.
- **generateEpisodes(seasonId):** `generateSeasonEpisodes` → `commitEpisodesToIssues`.
- **verifyArc:** bounded loop `MAX_ARC_VERIFY_ROUNDS` (default 3): `verifyArc` → if high/medium findings →
  `resolveVerifyIssues({findings})` → re-verify. Clean → set `runState.arcVerified=true`. **Rounds
  exhausted with residual findings → set `series.autopilot.status='paused'`, emit `paused` frame listing the
  residual findings, stop the run.** (Per user: pause for human review on non-convergence.)
- **beatSheet(seasonId):** delegate to `volumeBeatsRunner.startVolumeBeatsRun` and await completion via a thin
  `await` on `isVolumeBeatsRunActive(seasonId)` poll-to-false. Serial by design — never parallelize volumes.
- **textStages(issueId):** `startAutoRunTextStages(issueId,{force:false})`, await via `isAutoRunActive`
  poll-to-false. **Issues processed serially** (bounds LLM/GPU spend; avoids issueId-keyed runner
  collisions). A `concurrency` option (default 1) can lift this later.
- **scriptVerify(issueId):** structural parse gate + `analyzeIssue`; bounded editorial-fix loop
  `MAX_EDITORIAL_ROUNDS` (default 2): seed high-severity findings → per-comment generate+accept fix →
  re-analyze. Unresolved high-severity after rounds → **pause for review** (consistent with arc-verify
  choice); medium/low → warn and continue.
- **visualDraft(issueId):** call the extract-pages service to seed pages + cover concepts, then
  `enqueueComicCover` + `enqueueComicBackCover` + per-page `enqueueVisualComicPage` for **all pages** in
  **draft** quality. These are async media jobs — fire kickoffs, record jobIds, broadcast, and do **not**
  block autopilot on pixel completion (mirrors autoRunner's episodeVideo fire-and-forget, autoRunner.js:123).
  Budget gate (below) caps how many render jobs fire before pausing.
- **done:** broadcast `complete`; set `series.autopilot.status='done'`.

### 1c. CoS gap-filling (Phase 3)

Triggers: (a) a step throws the same error ≥2 consecutive times (missing tool/capability); (b) a required
ability is absent (e.g. teleplay requested but no prompt); (c) script-verify gap when `fileGaps` opted in.
Payload via `addTask({ description:'Autopilot: <gap> for <series title>', context:'<id, step, error,
runId>', app:'pipeline', priority:'medium', metadata:{taskType:'pipeline-autopilot-gap', seriesId, step} },
'user')`. Dedup via stable description prefix per (seriesId, gapKind) — `addTask` already dedups
pending/in_progress by description+app. Gated behind `getDomainMode('cos') !== 'off'` + CoS budget.

## 2. Execution & persistence — in-memory runner + derive-resume + thin marker

A whole-series run is long and **will** span restarts. The pure resolver means **no persisted step cursor is
needed** — resume is "click Run again; it picks up at the first missing step." Persist only a thin marker:

- New optional field on the **series** record: `series.autopilot = { status:'idle'|'running'|'paused'|'done'
  |'error', runId, currentStep, residualFindings?, lastError, updatedAt }`, written through the series write
  queue, throttled to step transitions only (~250ms debounce, not per SSE frame). Survives restart, powers
  "resume available" UI and the pause states.
- **Boot recovery:** `recoverStuckAutopilots()` (mirror `recoverStuckAutoRuns`, autoRunner.js:201) demotes
  any `series.autopilot.status==='running'` to `'paused'` on boot (the in-memory run is gone). Wire in
  `server/index.js` next to the existing `recoverStuckAutoRuns()` call (~:569). The existing
  `recoverStuckAutoRuns` also unsticks child issues left in `status:'running'`.

Drive as a **dedicated pipeline runner, not a CoS job** — it composes internal service fns and needs SSE like
its sibling runners; the CoS-job path is for scheduled shell/agent spawns. It *cooperates* with CoS (consults
autonomy+budget, files gap tasks) without being one.

## 3. Autonomy + budget gating (cos domain)

- At start: `mode = getDomainMode(config,'cos')`.
  - `off` → reject start **409** ("autonomous spend disabled").
  - `dry-run` → resolver-only walk: emit a `plan` frame listing every step it *would* take (counts of beat
    sheets / text runs / verifies / render jobs) with **no** side effects. This is preview/plan mode.
  - `execute` → full run.
- Before each *billable* step: check `getDomainBudgetStatus('cos')`; if exhausted → `status='paused'`, emit
  `paused` ("daily CoS budget reached"), stop. After each billable step: `recordDomainUsage('cos',{actions:1})`.
  Mirrors cosJobScheduler.js:207-238.
- Cancel: `cancelSeriesAutopilot(seriesId)` sets the flag (checked between steps) and also calls the active
  child cancel (`cancelVolumeBeatsRun` / `cancelAutoRun`) so cancel is responsive mid-delegation.

## 4. Routes — `server/routes/pipeline/autopilot.js` (NEW, mounted in pipeline/index.js after arcRoutes)

All under `/api/pipeline`. Zod via `validateRequest`; errors bubble to middleware (no try/catch in routes).

```
POST /series/:id/autopilot/start
  body: z.object({ ...providerOverrideShape,
    includeVisual: z.boolean().default(true),     // cover+back+all pages draft (user choice)
    target: z.enum(['auto','text','visual']).default('auto'),
    fileGaps: z.boolean().default(false),
    maxArcVerifyRounds: z.number().int().min(0).max(5).optional(),
    maxEditorialRounds: z.number().int().min(0).max(5).optional() })
  -> { runId, alreadyRunning, mode, sseUrl }   (404 if series missing; 409 if mode==='off')
GET  /series/:id/autopilot/progress -> SSE (attachClient(seriesId,res); 404 if no active run)
POST /series/:id/autopilot/cancel   -> { canceled }
GET  /series/:id/autopilot/status   -> { autopilot }   (reads series.autopilot marker; resume/pause UI)
```

SSE frames (mirror volumeBeatsRunner's documented header): `start{runId,target,mode,plan?}`,
`step:start{kind,seasonId?,issueId?,ordinal}`, `step:complete{kind,...}`, `step:skip{kind,reason}`,
`verify:round{scope,round,findings}`, `gap:filed{taskId,gapKind}`, `paused{reason,residualFindings?}`,
`canceled{runId}`, `complete{runId,summary}`, `error{runId,error}`. Add the route list to the index.js header.

## 5. Client

- **Launcher:** "Run Autonomously to Completion" button on `PipelineSeries.jsx` (series-scoped) — placed in
  `ArcCanvas.jsx` alongside the existing arc-gen/verify controls, with a small popover for
  target/includeVisual/fileGaps. Add a visible **resume / paused banner** that reads `series.autopilot` so a
  paused run (non-convergent verify, budget, boot recovery) is obvious and re-runnable.
- **API wrappers** in `client/src/services/apiPipeline.js`: `startAutopilot`, `cancelAutopilot`,
  `getAutopilotStatus`, + the progress SSE URL.
- **Progress UI:** reuse `useSseProgress` (same hook the beats/editorial runners use). Render a step timeline
  (arc → episodes → verify → per-issue beats/prose/script/visual) with the current step highlighted; render
  the dry-run `plan` when `mode==='dry-run'`; surface residual findings on `paused`.
- A modal/drawer is enough for MVP → **no new page**, so no `NAV_COMMANDS`/`PALETTE_ACTIONS` churn. (If a
  dedicated page is wanted later, add the navManifest + palette entries then.)

## 6. Migrations / prompts

- **MVP: no new prompt** (script-verify reuses analyzeIssue + structural parse).
- `series.autopilot` is an optional additive field — `sanitizeSeries` gains a `sanitizeAutopilot` arm
  (null/idle default), back-compat with existing rows (mirrors how `targetFormat`/`locked` default in
  series.js). No data migration needed. Series stays PostgreSQL-primary per docs/STORAGE.md.
- **Phase 3 only:** real LLM script verification → `data.reference/prompts/stages/pipeline-script-verify.md`
  + `scripts/migrations/NNN-*.js` seeding it via setup-data.js. Out of MVP.

## 7. Tests

- **Highest value — `resolveNextStep` (pure):** table-driven over synthetic (series, issues): empty arc;
  arc-but-no-issues; season-with-empty-issues; idea-only; prose-ready/script-missing;
  script-ready/editorial-blocking; comic target with empty comicPages; fully done. No DB, no LLM.
- **Bounded loops:** mock verify to always return one high finding → assert arc loop stops at
  `MAX_ARC_VERIFY_ROUNDS` and **pauses** (status=paused, residual findings emitted); same for editorial loop.
- **Autonomy gating:** off→reject (409); dry-run→plan-only (assert mocked generators **not** invoked);
  execute→runs.
- **Runner lifecycle (mirror editorialAnalysisRunner tests):** start returns runId; second start while active
  → `alreadyRunning`; cancel sets flag; `recoverStuckAutopilots` demotes running→paused.
- **DB-test pitfalls:** mock the service modules (`generateArcOverview`, `startVolumeBeatsRun`,
  `startAutoRunTextStages`, etc.) so tests never touch PostgreSQL; resolver tests use plain objects. Use
  `export const __testing = { runs }` for white-box assertions. (Do not run `*.db.test.js` against real
  `portos`.)

## 8. Phasing (MVP first)

- **Phase 1 (MVP — backend conductor + API):** `resolveNextStep` + `seriesAutopilot.js` composing
  generateArc / episodes / verifyArc(bounded, pause-on-non-convergence) / volume-beats / text-stages /
  script-verify(structural+editorial). **Text-ready terminal** (no visuals yet). Autonomy+budget gating
  (off/dry-run/execute). Routes start/progress/cancel/status. `series.autopilot` marker + boot recovery.
  Unit tests for resolver + bounded loops + gating. Delivers "drive a whole series to story-ready."
- **Phase 2 (client + visual draft):** ArcCanvas launcher + SSE progress + resume/paused banner + apiPipeline
  wrappers. Add `includeVisual` path: extract-pages → draft cover+back+all-pages enqueue (fire-and-forget).
- **Phase 3 (CoS gap-filling + real script verify):** `addTask` gap creation w/ dedup + budget gate; optional
  `pipeline-script-verify` prompt + migration replacing the editorial-only script gate.

## Verification (end-to-end)

1. **Unit:** `cd server && npm test` — resolver table tests, bounded-loop pause tests, gating tests,
   runner-lifecycle tests all green without touching Postgres.
2. **Dry-run on the live test series:** start autopilot with cos domain in `dry-run` against
   `ser-b74601a3-221d-4491-b037-bad51df8460a`; confirm the `plan` frame lists only the *missing* steps
   (arc-completion, remaining first-issue stages, untouched later issues) and that **no** existing
   ready stages appear as work — proving non-destructive resume.
3. **Execute (text terminal, Phase 1):** flip cos to `execute`, start; watch SSE drive the series to
   story-ready; intentionally leave an unresolvable arc finding (or set `maxArcVerifyRounds:1`) and confirm it
   **pauses** with residual findings rather than looping.
4. **Restart mid-run:** kill/restart the server during a run; confirm boot recovery demotes it to `paused`
   and that clicking Run again resumes from the next missing step (no regeneration of completed stages).
5. **Phase 2 visual:** with `includeVisual:true`, confirm cover/back/all-page draft render jobs enqueue and
   the run completes without blocking on pixel completion; verify the budget gate pauses when the daily CoS
   action budget is hit.

## Critical files

- `server/services/pipeline/seriesAutopilot.js` (NEW — conductor + `resolveNextStep`)
- `server/routes/pipeline/autopilot.js` (NEW — routes) + mount in `server/routes/pipeline/index.js`
- `server/services/pipeline/editorialAnalysisRunner.js` (runner pattern to mirror)
- `server/services/pipeline/issues.js` (`isStageReady`, stage model, `queueSeriesIssuesWrite`)
- `server/services/pipeline/arcPlanner/arcCore.js` (verify/resolve signatures)
- `server/services/pipeline/series.js` (`sanitizeSeries` → add `sanitizeAutopilot`, `TARGET_FORMATS`)
- `server/lib/domainAutonomy.js` / `server/services/domainUsage.js` (gating)
- `server/index.js` (wire `recoverStuckAutopilots()` ~:569)
- `client/src/components/pipeline/ArcCanvas.jsx`, `client/src/services/apiPipeline.js`,
  `client/src/hooks/useSseProgress.js` (Phase 2)
