# Creative Director as General Creative Orchestrator

**Date:** 2026-07-04
**Status:** Approved design record; work tracked as GitHub issues (epic + phases)
**Related:** `docs/plans/2026-07-04-creative-writing-quality-engine.md` (the quality loop this orchestrator will drive), `docs/plans/2026-06-16-series-autopilot.md`, `docs/plans/2026-06-05-issue-842-writers-room-cd-bridge.md`

## Why

Today the Creative Director is a **video producer**: brief → treatment → scene renders → evaluate → stitch. The Series Autopilot is a **story producer**: arc → episodes → text stages → editorial → draft visuals. They are separate conductors over the same creative substrate (catalog ingredients, canon, media job queue, CoS agents, LLM stages), and neither can task the other. The goal: promote the Creative Director into the *general* creative orchestrator — give it a directive ("produce a 6-issue noir comic in universe X, with covers, a polished manuscript, and a teaser trailer") and let it plan and execute using **any** tool in the creative suite, including running the Series Autopilot as one step of a larger production.

## What the architecture audit found (2026-07-04)

1. **CD and Autopilot already share one architecture.** Both are "pure next-step resolver over canonical state + idempotent fire-and-forget coordinator + in-memory dedup + SSE/marker observability + boot recovery" (`creativeDirector/completionHook.js#advanceAfterSceneSettled`, `seriesAutopilot.js#resolveNextStep`). The generalization is an extension of this shape, not a new framework.
2. **The CD's cognitive steps already run as CoS agent tasks.** `agentBridge.js` enqueues `internal` CoS tasks (treatment, scene evaluation) via `addTask` + `cosEvents.emit('task:ready')`; completion routes back through `agentCompletionCleanup.js` → `handleCreativeDirectorCompletion`. Tasking the CD agent with a tool registry is the same mechanism with a richer prompt.
3. **Autopilot is programmatically invokable.** `startSeriesAutopilot(seriesId, options)` is a plain exported async function gated internally on the cos autonomy domain; observation is SSE (needs an HTTP `res`) or polling `isAutopilotActive` + the persisted `series.autopilot` marker. A small event-emitter extension is needed for in-process progress consumption.
4. **The tool-registry pattern exists.** `server/services/voice/tools.js` (`{name, description, parameters, execute}` + import-time integrity guards + `dispatchTool`) with `routes/palette.js` demonstrating multi-frontend reuse by hydrating from the same registry.
5. **The sanctioned cross-tool tasking pattern exists.** The Writers-Room → CD bridge (#842): compose a proposal, mint a **new** seeded record via the owning service's create + set functions, link back via manifest id, never clobber existing records, nothing auto-starts without an explicit start call.
6. **The governance gap.** Among creative-suite generators, only Series Autopilot checks an autonomy domain (cos) and only Writers-Room live mode checks a budget. Universe Builder, Story Builder, Writers Room passes, and pipeline stage generation all assume a direct user action. A general orchestrator running these autonomously MUST introduce a unified gate — none exists at those call sites today, and the AI Provider Usage Policy requires it.

## Design principles

- **Conductor, not re-implementation.** Every orchestrator step calls an existing service entry point (`createSeries`, `generateStep`, `startSeriesAutopilot`, `enqueueJob`, …). No parallel logic, no parallel data model — catalog refs, canon, and series records stay the single sources of truth.
- **One dispatch chokepoint = one governance point.** All orchestrator tool calls flow through a single `dispatchCreativeTool()` that enforces the autonomy mode, charges budget, and writes the action ledger. Tools themselves stay unguarded for direct user actions (unchanged behavior).
- **Resume is a pure function of state.** The production plan lives on the project record; "what happens next" is derived, never cursor-stored. Bounded retries; non-convergence pauses for human review with residuals (same contract as autopilot).
- **Back-compat is first-class.** Existing CD projects (treatment/scenes only, no plan) keep working verbatim; the record change ships with a migration + schema-version gate so older federation peers aren't corrupted.

## Phases

### Phase 1 — Creative Tool Registry + gated dispatch

New `server/services/creative/toolRegistry.js` following the voice-tools shape (`{name, description, parameters, execute}`, per-domain modules, import-time integrity guards, `getToolSpecs()` / `dispatchCreativeTool(name, args, ctx)`):

- **Tool inventory (wrapping existing entry points):** universe (`createUniverse`, `expandWorldTemplate`, `renderUniverseJobs`), story builder (`createStorySession`, `generateStep`, `generateIssuesFromArc`), writers room (`createWork`, `runAnalysis`, polish loop when CWQE Phase 9 lands), pipeline (`createSeries`, `generateSeriesConcept`, `generateStage`, `enqueueComicCover`, `startSeriesAutopilot`), media (`enqueueJob` image/video/audio with owner tagging), catalog (`suggestCastForBrief`, ingredient search). Where a voice tool already wraps the same action, hydrate description/parameters from it (palette pattern) rather than duplicating.
- **Tool metadata beyond the voice shape:** `costClass` (free/llm/render), `longRunning: true` for job-queue and autopilot tools (dispatch returns a handle; completion arrives via events), `destructive` flag (delete/overwrite tools excluded by default).
- **Gated dispatch:** `dispatchCreativeTool` checks a `creative` autonomy domain (`lib/domainAutonomy.js` — new domain, defaulting to mirror the cos mode so existing autopilot users get consistent behavior; decision to fold into `cos` vs keep separate is flagged for implementation review), charges the daily action budget per LLM/render call, and appends to the project's run ledger. Direct user actions through existing routes bypass the orchestrator gate exactly as today.
- Fail-fast import guards (every tool has schema + execute + cost class; duplicate names throw) and registry unit tests.

### Phase 2 — Production plans: directive → plan → generalized advance loop

Extend the CD project record (`projectsLogic.js#buildProjectRecord`) with:

- `directive` — the brief: goal text, requested deliverables, constraints (universe/series targets, formats, budget cap).
- `plan.steps[]` — `{ stepId, toolName, args, status: pending|running|blocked|done|failed|skipped, dependsOn[], result, retryCount }`.
- Legacy projects (`treatment`/`scenes`, no `plan`) behave exactly as today — the video flow becomes the built-in "video production" plan template. Migration in `scripts/migrations/` + `schemaVersions.js` gate for federation payloads.

New machinery, mirroring the existing pattern:

- **Planner** — a cognitive CoS-agent task (like `enqueueTreatmentTask`) with a new `cd-plan.md` prompt: receives the directive + `getToolSpecs()` + current state, returns a validated plan (Zod). Re-planning on step failure is bounded (`MAX_REPLAN_ROUNDS`), then pause with residuals.
- **`advanceAfterPlanStepSettled(projectId)`** — generalizes `advanceAfterSceneSettled`: pure next-step over the plan DAG (sequential execution with `dependsOn`; no parallel steps in v1), in-memory dedup sets, idempotent, driven by CoS completion + media-job events + boot recovery (`recovery.js` extended to reset stuck plan steps).
- Long-running steps (`startSeriesAutopilot`, media jobs) register completion listeners; the plan step stays `running` until the underlying run reaches a terminal/paused state, and an autopilot **pause** surfaces as a `blocked` plan step with the pause reason — the CD never silently retries around a human-review pause.

### Phase 3 — CD ⇄ Series Autopilot bridge (both directions)

- **CD → Autopilot:** registry tool `pipeline.runAutopilot` invokes `startSeriesAutopilot(seriesId, options)` in-process. Add a lightweight event-emitter beside the SSE broadcast in `seriesAutopilot.js` (`autopilotEvents.emit(seriesId, payload)`) so in-process consumers get progress/terminal/pause frames without an HTTP client; CD subscribes for the life of the step. Autopilot residual findings and `convergencePauseReason` propagate into the plan step result.
- **Autopilot/pipeline → CD:** a "produce teaser/trailer" deliverable — mint a fresh CD video project seeded from an issue/volume (the #842 pattern: `createProject` + `setTreatment` + link id; `sourceIssueId` already exists and feeds the music bed) and start it. Exposed both as a registry tool (`cd.produceVideoFromIssue`) and as an optional autopilot post-`visualDraft` step (config-gated, default off).
- **Shared cast/canon:** plans seeded from a series pull the series canon + cast into CD casting (`deriveBriefFromProject` + `suggestCastForBrief` already exist); ensure catalog ingredient refs (`ref_kind: 'creative-director'`) are written for cross-tool convergence.

### Phase 4 — Studio UI: directive composer + plan board

- CD detail page grows a **Plan** tab (deep-linked, `useValidTab` pattern): step list with statuses, live SSE progress, per-step results/links (a created series links to `/pipeline/series/:id`, a video to its timeline), blocked-step surfacing with the pause reason and resume/skip/re-plan actions.
- **Directive composer** on project create: goal text + deliverable checklist (story/series, manuscript polish, covers, video teaser, …) + target universe/series pickers + budget cap. Dry-run preview (plan only, no execution) mirroring autopilot's `dry-run` mode.
- Approval affordances: destructive or out-of-budget steps render as explicit approve buttons (toast/modal conventions, no window.confirm).
- Nav manifest: update the CD entry's aliases/keywords ("creative director", "producer", "studio"); every new sub-view is a route.

### Future (parked)

- **Parallel plan steps** (independent DAG branches executing concurrently) — v1 is sequential.
- **Scheduled directives** — recurring CD directives via the task scheduler (composes with #2174 scheduled autopilot; same consent-gated pattern).
- **CD-driven quality convergence** — once CWQE Phase 7 lands, a "polish to READY" deliverable that runs the iterate-to-quality loop as a plan step.

## Explicitly not doing

- No new agent framework — planner/evaluator remain CoS `internal` tasks through the existing spawner.
- No parallel content stores — the CD plan references series/universe/work ids; it never copies their content.
- No auto-start of minted records in other tools' domains (the #842 rule): bridged projects/series require their owning step to explicitly start them, and that start is itself a gated dispatch.
