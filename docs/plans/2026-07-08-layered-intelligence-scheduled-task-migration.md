# Layered Intelligence → per-app scheduled task (migration design)

**Status:** proposed (design record; not yet implemented) — tracked in [#2322](https://github.com/atomantic/PortOS/issues/2322)
**Date:** 2026-07-08
**Supersedes the execution model in:** `docs/plans/2026-07-07-layered-intelligence-loop.md`

## Why

The Layered Intelligence (LI) loop shipped as a **single global autonomous job**
(`job-layered-intelligence`) that sweeps *all* enabled apps on one daily fire,
with a global on/off under CoS → System Tasks and per-app config under Edit App →
Intelligence. This produced two concrete problems the user hit:

1. **Confusing global/per-app split.** A per-app card shows "Enabled · Due now,"
   but nothing runs, because the *global* sweep already fired earlier that day (or
   is off). Per-app "due" is decoupled from the one global schedule.
2. **It doesn't behave like the other self-improvement work.** Every other
   per-app automation is a *scheduled task* (CoS → Schedule) with its own per-app
   interval, provider, and manual "run now." LI is a bespoke third surface.

**Decision (user):** migrate LI to run **per-app, one app's context at a time,
like the other scheduled tasks.** Drop the cross-app sweep entirely.

## Key finding — the scheduled-task system can't run a deterministic handler

The `taskSchedule.js` / `SELF_IMPROVEMENT_TASK_TYPES` system is **hardwired to
spawn one coding agent per fire.** `generateManagedAppImprovementTaskForType`
(`cosTaskGenerator.js:1540`) always terminates by emitting an agent prompt
(`taskType:'internal'`); deterministic per-type work (e.g. `branch-reconcile`,
`reference-watch`) exists only as *pre-steps that prepare the agent prompt*, never
as the task's terminal deliverable. There is **no `type:'script'`/handler concept**
in the task system.

LI is the opposite: the reasoning model returns JSON only (never code) and all
side effects (dedup, scope-gate, park, file-one-issue) are deterministic. That
deterministic-handler capability exists today **only** in the autonomous-jobs
system (`executeScriptJob` → `SCRIPT_HANDLERS`).

**So the migration's core work is adding a per-app deterministic *handler-backed*
task type to the scheduled-task system** — a genuinely new execution primitive in
core CoS autonomous-spawn infrastructure. This is why it's bigger than a config
move, and why it warrants review before landing.

Helpfully, the per-app logic already exists and is engine-agnostic:
`processApp(app, deps)` (`layeredIntelligenceHandler.js:67`) processes exactly one
app with injected deps. Only the thin `runLayeredIntelligence()` sweep wrapper
loops apps — that is what we delete.

## Proposed architecture

### Execution primitive (the new, review-critical part)
- Add a `HANDLER_BACKED_TASK_TYPES` set + a lazy handler registry to the
  scheduled-task layer. A handler-backed type maps to an async `(app) => outcome`.
- In `queueEligibleImprovementTasks` (`cosTaskGenerator.js:1094`), after
  `getNextTaskType` selects a due type for an app: if the type is handler-backed,
  **run the handler fire-and-forget guarded by a per-app in-flight `Set`** (so the
  next scheduler tick can't double-run it), record execution via
  `recordExecution('task:layered-intelligence', app.id)` on completion, and
  `continue` — **never** touch the agent-spawn path. A bug here can only fail to
  run LI; it can never spawn a runaway agent.
- Mirror the on-demand path (`triggerOnDemandTask` drain) so per-app "Run now"
  invokes the handler instead of generating an agent task.
- `processApp` becomes gate-free per-app work (drop its own `enabled`/`isAppDue`
  checks and `recordRun` — the scheduler now owns gating + cadence bookkeeping).

### Config home — recommend **A** (required by the Schedule-UI goal)
Two options were considered:
- **A. Move scheduling into the task override (recommended).** `enabled`/interval/
  `providerId`/`model` live in the per-app `taskTypeOverrides['layered-intelligence']`;
  behavior (sources/scopes/rules) stays in `app.layeredIntelligence`, edited via the
  Intelligence tab (reachable from the Schedule card). Requires a per-app data
  migration, but it's what makes LI actually configurable *in the Schedule UI like
  the other tasks* — the whole point.
- **B. Keep all config in `app.layeredIntelligence`.** Rejected: the Schedule UI's
  config drawer writes to `taskTypeOverrides`, so a handler that read scheduling from
  `layeredIntelligence` instead would leave the Schedule card's enabled/interval/
  provider controls inert — not "like other tasks." B only avoids a migration by
  giving up the goal.

**Migration (option A):** for each app with a `layeredIntelligence` config, set
`taskTypeOverrides['layered-intelligence'] = { enabled: (globalJobEnabled &&
li.enabled), type: intervalTypeFromMs(li.intervalMs), intervalMs, providerId,
model }`; leave sources/scopes/rules in `layeredIntelligence`. Idempotent; safe when
absent. This subsumes the job-tombstone migration below into one step.

### Retire the global job (needs a migration)
- Remove the `LI_JOB_ID` entry from `autonomousJobs/defaults.js` + its
  `SCRIPT_HANDLERS` registration; delete `runLayeredIntelligence`.
- **Migration** (`scripts/migrations/NNN-…`): in `data/cos/autonomous-jobs.json`,
  find `job-layered-intelligence`; capture its `enabled`; **tombstone/remove** the
  record. Faithful effective-state preservation: an app's LI stays enabled only if
  `(globalJobEnabled && app.layeredIntelligence.enabled)` — because a per-app
  enable did nothing while the global job was off. Idempotent; safe when absent.
- No `schemaVersions.js` / peer-sync gating touches LI (confirmed), so no
  cross-install payload changes are required.

### Routes
- `/layered-intelligence/overview`: re-point `jobEnabled`/`jobExists` off the
  global job (gone) to the per-app task schedule; drop the "global job is off"
  banner. Keep `/proposals` and `/:id/layered-intelligence` (behavior config).

### Client
- Surface LI in **CoS → Schedule** like other tasks (enabled/interval/provider/
  run-now). Keep the Intelligence drawer tab as the behavior-config home
  (sources/scopes/rules). Decide whether to **remove the dedicated
  `/layered-intelligence` page + sidebar link + `NAV_COMMANDS` entry** (the "whole
  other section" the user questioned) or keep it as a read-only status view — the
  navManifest test couples nav path ↔ route, so both move together.

## Touchpoint inventory (from research)
- **Job:** `layeredIntelligence.js:61` (`LI_JOB_ID`), `autonomousJobs/defaults.js:259`,
  `autonomousJobs/scriptHandlers.js:144`, `layeredIntelligenceHandler.js` (whole).
  Persisted: `data/cos/autonomous-jobs.json` job record.
- **Per-app config:** `apps.js:331/442/459`, `validation.js:118`
  (`layeredIntelligenceConfigSchema`). Persisted: `data/apps.json` `layeredIntelligence`.
- **Routes:** `routes/apps.js:24/597/748/782/804`; client wrappers `apiApps.js`.
- **Client:** `pages/LayeredIntelligence.jsx`, `App.jsx:41/208`, `Layout.jsx:190`,
  `navManifest.js:89`, `LayeredIntelligenceTab.jsx`, `EditAppDrawer.jsx` (tab wiring),
  `AppDetailView.jsx:65` (`?edit=1&appTab=intelligence` deep-link).
- **Tests:** `layeredIntelligenceHandler.test.js`, `layeredIntelligence.test.js`,
  `apps.layeredIntelligence.test.js`, `routes/apps.test.js`,
  `pages/LayeredIntelligence.test.jsx`, `LayeredIntelligenceTab.test.jsx`,
  `EditAppDrawer.test.jsx`, `navManifest.test.js`.
- **Cross-cutting gate reminder:** cover `queueEligibleImprovementTasks` +
  the on-demand drain (`cos.js`) + `dequeueNextTask` when adding the handler path.

## Open questions for review
1. **Remove the dedicated `/layered-intelligence` page** (the "whole other section"),
   or keep it as a read-only status view? Removal is cleaner per the consolidation
   goal but moves nav + route + `NAV_COMMANDS` + page tests together.
2. Behavior config (sources/scopes/rules) stays in the Intelligence tab under
   option A — confirm that's the right home, reachable via a "Configure behavior"
   link on the Schedule card, rather than folding those fields into the Schedule
   drawer too.

(Resolved: config home = **A**, so provider/interval/enabled live in the task
override and are edited by the standard Schedule task controls — one provider home,
no duplication.)
