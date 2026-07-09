# Programmatic-I/O scheduled tasks (Layered Intelligence as a first-class agent)

**Date:** 2026-07-09
**Status:** Approved (design)

## Problem

Layered Intelligence (LI) is invisible in the CoS queue and the Active Agents page,
and can't be run in an interactive TUI the user can talk to. The cause is that LI was
built as a **handler-backed** task (`HANDLER_BACKED_TASK_TYPES` in
`server/services/taskSchedule.js:188`): its scheduled fire short-circuits the entire
agent path (`cosTaskGenerator.js:1219` and the on-demand twin at `:601`) and instead
runs a deterministic in-process function (`layeredIntelligenceHandler.runLayeredIntelligenceForApp`)
that makes ONE inline `runPromptThroughProvider` call and files a tracker issue. It
never calls `addTask` (no queue entry) and never `registerAgent` (no agent record),
so the UI — which reads `state.agents` via `getAgents()` — has nothing to show.

## Reframe

LI is **not** special enough to warrant a parallel execution path. Every scheduled
task is already `input → agent reasons → output`:

| | Input (pre-agent) | Agent | Output handling (post-agent) |
|---|---|---|---|
| normal coding task | prompt template | codes a fix | wait for `.agent-done` sentinel, mark complete |
| Layered Intelligence | gather goals + telemetry + open issues, build augmented prompt | reasons about the single best improvement | parse answer → dedup/scope-gate → file issue → pause/hand-off |

LI differs only in the two **programmatic slots** around the agent — not in whether an
agent runs. So: make LI a normal agent-backed task (visible, TUI-capable), and give
any task type two optional programmatic hooks. LI is the first consumer; the mechanism
is reusable for future task types that need pre-agent data collection and/or
post-agent output processing.

## Design

### Two optional hooks per task type

A task-type registry gains two optional async hooks (co-located with the task type's
other config; resolved by id at dispatch/completion time):

- **`buildTaskInput(app, config)` → `{ promptAugmentation?, context?, skip?: { reason } }`**
  Runs before spawn, inside `generateManagedAppImprovementTaskForType`
  (`cosTaskGenerator.js:1665`) after metadata assembly and alongside the existing
  perpetual work-detector gate (`:1744`, which is already the precedent for a
  programmatic "should we even spawn?" check). For LI: the park-check + `gatherSources`
  + `listForgeIssues`/`listJiraIssues`/PLAN-slug read + `buildPrompt`
  (`layeredIntelligenceHandler.js:129–173`). A returned `skip` short-circuits with no
  agent spawned (e.g. app parked, jira-not-configured, blocking-read-failed).

- **`processTaskOutput(app, config, agentResult)` → `outcome`**
  Runs on completion from the single finalize chokepoint `finalizeAgent`
  (`agentLifecycle.js:748`) — dispatched via `processAgentCompletion`
  (`agentCompletion.js:19`) so it fires identically for TUI/runner/direct agents.
  `agentResult` carries the parsed sentinel payload (below), `success`, and the
  workspace path. For LI: `validateReasonerResponse` → scope-gate → exact + semantic
  dedup → `fileProposal` → pause → optional hand-off → `recordRun`
  (`layeredIntelligenceHandler.js:183–265`).

`layeredIntelligence.js` keeps ALL its pure helpers unchanged; they are simply called
from the two hooks instead of one monolithic handler.

### Structured output via the done-sentinel

The agent's reasoning answer reaches `processTaskOutput` through the existing
`.agent-done` sentinel mechanism (`agentTuiSpawning.js:534` `ingestDoneSentinel`),
extended to carry a structured payload alongside the human summary:

```
.agent-done  ->  { summary: "...", payload: { ...reasoner JSON... } }
```

`ingestDoneSentinel` already reads and caps the file; we parse `payload` (via the
existing `safeParse`/`safeJSONParse` + `stripCodeFences`) and thread it into
`agentResult`. Robust to TUI repaint noise because we read the file the agent wrote,
not the scraped PTY stream. Back-compat: a plain-text sentinel (no JSON payload) still
works for every existing task type — `payload` is absent and those types have no
`processTaskOutput` hook.

### No-code-writes guarantee via throwaway worktree

The original safety property ("the reasoner never touches code, only files an issue")
is preserved not by hiding the reasoner but by **isolation**: the LI agent spawns in a
git worktree (`useWorktree: true`) that is **discarded without committing, pushing, or
merging**. Its only durable channel to the outside world is its sentinel payload →
`processTaskOutput`. This mirrors how coding tasks already work (worktree + open a PR);
LI uses worktree + *discard*. LI's `taskMetadata`:

```
{ useWorktree: true, openPR: false, skipMerge: true, discardWorktree: true }
```

`cleanupAgentWorktree` (`agentWorktreeCleanup.js:43`) already supports `openPR` and
`skipMerge`; its default `openPR:false` path currently auto-merges, so LI needs an
explicit **discard** posture (remove worktree + delete branch, merge/commit nothing).
Add/route a `discardWorktree` flag so no LI reasoning run can ever land code even if
the agent tries. The LI prompt instructs the agent to reason and write JSON to
`.agent-done` and NOT to run `/do:pr` or touch code; the discard is the backstop.

### TUI is free and provider-driven

Because LI is now a normal agent, the TUI runtime option falls out of the existing
provider-type selection (`agentLifecycle.js:335` `isTui`, `:502` `spawnTuiAgent`). A
`tui`-type provider/model → interactive terminal the user attaches to and messages via
`POST /agents/:id/btw` (`cosAgentRoutes.js:138` → `cosAgents.js:653`); an `api`/`cli`
provider → non-interactive but still a visible agent card. This is exactly the user's
"optional based on model selection."

## Changes

1. **Remove the short-circuit.** Delete `'layered-intelligence'` from
   `HANDLER_BACKED_TASK_TYPES` (`taskSchedule.js:188`) and the two dispatch seams that
   branch on it (`cosTaskGenerator.js:1219`, `:601`). Retire
   `runHandlerBackedTaskForApp`/`dispatchHandlerBackedTask` once nothing references
   them. Keep the migration/`LI_JOB_ID` tombstone code (distribution model — other
   installs).
2. **Hook interface + registry.** Add optional `buildTaskInput`/`processTaskOutput`
   resolution keyed by task type. Wire `buildTaskInput` into
   `generateManagedAppImprovementTaskForType`; wire `processTaskOutput` into
   `finalizeAgent`/`processAgentCompletion`.
3. **Sentinel payload.** Extend `ingestDoneSentinel` to parse an optional JSON
   `payload`; thread it into `agentResult`. Back-compat preserved.
4. **Worktree discard.** Add the `discardWorktree` posture to `cleanupAgentWorktree`
   and LI's `taskMetadata`.
5. **LI hooks.** Implement `buildTaskInput`/`processTaskOutput` for LI as thin adapters
   over the existing `layeredIntelligence.js` pure helpers + the gather/file I/O
   currently in `layeredIntelligenceHandler.js`. Replace the LI schedule entry's
   handler semantics with a normal agent entry (provider/model still from
   `taskTypeOverrides['layered-intelligence']`; prompt still built by the input hook,
   so no `DEFAULT_TASK_PROMPTS` entry needed).
6. **Tests.** Port `layeredIntelligence.test.js` / `apps.layeredIntelligence.test.js`
   expectations onto the hook boundary; add a hook-registry test and a
   sentinel-payload round-trip test. Assert LI now produces an agent record (visible in
   `getAgents`) and that a discarded worktree lands no commit.

## Open risks

- **Output reliability.** A reasoning agent that never writes a valid `payload` (empty
  sentinel, non-JSON) must degrade to a recorded no-op (`unparseable-response`), same as
  today's inline path — `processTaskOutput` reuses `validateReasonerResponse`'s
  tolerance.
- **No-cold-bootstrap policy.** Unchanged — LI still only runs on its user-configured
  schedule (or explicit "Run now"); it just runs as a visible agent now.
- **On-demand "Run now"** must route through the same agent path so the manual run is
  also visible/interactive.
