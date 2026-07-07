# Layered Intelligence Loop — Design

> Status: approved design (2026-07-07). Tracking issue: _(filled in after filing)_.

A perpetual, per-managed-app self-improvement loop that runs via the Chief of
Staff. On a schedule it reads each app's goals + telemetry, asks a reasoning
model (default: local LLM) what single most-valuable improvement to make, and a
**deterministic handler** files that as a tracker issue (GitHub / GitLab / Jira)
for a coding agent to pick up later. The reasoning model never touches code — it
only returns structured JSON; every side effect is deterministic handler code.

The loop can also grow itself: when it lacks the data or access to reason well,
it files an issue to add that source/tool, and it can pause itself until a
blocking issue is resolved.

## Goals

- Keep every managed app continuously improving against its stated goals/KPIs
  without a human queuing the work.
- Produce **one high-value, de-duplicated issue per app per run** — signal, not
  noise.
- Let the loop extend its own capabilities (more telemetry, more tools, more
  context) by filing issues against itself — but only when running on the PortOS
  app.
- Run **deterministically outside the model invocation**: the model reasons and
  returns a decision; PortOS code executes it.

## Non-goals

- The reasoning model making direct code changes (that's the coding agents the
  issues feed — `plan-task` / `claim-issue`).
- A new KPI/telemetry subsystem. v1 reasons over sources that already exist and
  files issues to add what's missing.
- Multi-issue batch filing. One valuable item per run, on purpose.

## Architecture: Engine B (autonomous script job)

PortOS has two scheduling engines. **Engine A** (CoS self-improvement task types)
spawns a full CLI coding agent per app — powerful but code-write capable.
**Engine B** (autonomous *script jobs*, e.g. `goal-check-in`) runs an in-process
handler that calls the LLM for structured JSON and then acts deterministically.

This feature is **Engine B**, because the hard requirement — "the reasoning model
must not make direct code changes; it returns structured output to a programmatic
handler that runs deterministically outside the model invocation" — is Engine B's
contract by construction, not a prompt guard.

- Registered as a single global script job (`category: 'layered-intelligence'`,
  `type: 'script'`) in `data/cos/autonomous-jobs.json`, scheduled by
  `cosJobScheduler`. **Off by default.** It is a user-enabled scheduled
  automation, the sanctioned exception under the AI-provider "no cold-bootstrap
  LLM calls" policy.
- On each fire the handler **sweeps `getActiveApps()`** and processes each app
  whose `app.layeredIntelligence.enabled === true`, honoring a per-app
  `intervalMs`. This is how a single Engine-B job stays "per managed app."

Reference implementation to mirror: the `goal-check-in` script job
(`server/services/goalCheckIn.js` + `autonomousJobs/scriptHandlers.js`), which
already does gather → `callProviderAISimple` → `parseLLMJSON` → act.

## The four layers (pipeline stages), per app

```
Layer 1 — GATHER    Read enabled sources: GOALS.md, CoS metrics
                    (learning.json / productivity.json / insightsService /
                    HEALTH_REPORT.md), plus optional PLAN.md + open issues
                    (config toggles), plus app-declared custom file sources.
Layer 2 — REASON    callProviderAISimple(provider, model, JSON-only prompt).
                    Provider defaults to getActiveProvider() (local LLM);
                    per-app providerId/model override. Injects the app's
                    free-text "rules" guidance. Returns a ranked decision.
Layer 3 — DECIDE    Deterministic: dedup the top candidate against live tracker
                    state (label + slug); pick the single highest-value item.
Layer 4 — ACT       Deterministic: file exactly ONE issue via the app's tracker,
                    OR record a pause, OR file a meta/data-gap issue. Then update
                    per-app run bookkeeping (lastRunAt).
```

"Configure how many layers / what rules to use" maps to per-app config that
selects which **gather sources** feed the reasoner, supplies free-text
**rules/guidance** injected into the prompt, and gates which **proposal scopes**
are allowed.

## Memory = the live tracker (no tracked-issue file)

Dedup and pause both derive from tracker state, not a local memory file:

- **Dedup.** Every filed issue carries a `layered-intelligence` label and a
  stable reasoner-chosen `slug`, embedded in the body as
  `<!-- lil-slug: <slug> -->`. Layer 1 feeds current open issues into the
  reasoner (so it self-avoids duplicates), and Layer 3 additionally runs a
  deterministic guard:
  `gh issue list --label layered-intelligence --state all --search <slug>` —
  if a match exists (open, or closed within a recency window), the proposal is
  suppressed.
- **Pause.** The reasoner may return `pause: { blockOnIssue, reason }`. The
  handler applies a `layered-intelligence:blocking` label to that issue. **Before
  reasoning**, each run queries for open blocking-labeled issues for the app; if
  any exist, that app is **parked** and skipped, resuming automatically when the
  blocking issue closes. Fully tracker-derived — no local pause flag.
- The **only** local state is scheduler bookkeeping (`lastRunAt`, cached
  `parkedUntil`) on the app record via `updateApp` — run cadence, not issue
  memory, so it does not reintroduce a tracked-issue file.

## Proposal scopes (what the loop is allowed to file)

The reasoner returns one proposal with a `scope`; the handler enforces where it
lands:

| Scope | Where it files | Allowed when |
|---|---|---|
| `app-improvement` | the app's own tracker | always |
| `app-data-gap` (loop needs more telemetry from this app) | the app's own tracker | always |
| `loop-meta` (extend the loop: more tools/APIs/context) | **PortOS** tracker | only when `app.id === PORTOS_APP_ID` |
| `portos-self` (improve the PortOS self-improvement system) | **PortOS** tracker | only when `app.id === PORTOS_APP_ID` |

On non-PortOS apps the prompt states that meta/self scopes are unavailable, so a
data gap is framed as an `app-data-gap` against the app's own tracker. The
handler double-enforces the gate (a hand-edited config or a hallucinated scope
cannot file a `portos-self` issue from someone else's app).

## Tracker abstraction

A deterministic `fileIssue(tracker, { title, body, labels, slug })` dispatched by
`resolveAppWorkTracker(app)` (reuses `server/lib/workTracker.js`):

- **`gh`** (GitHub) — implemented in v1.
- **`glab`** (GitLab) — near-identical; included in v1.
- **jira** — via the existing jira integration (`jiraReports.js` et al.).

Dedup-query and pause-labeling have per-tracker equivalents (labels on GitHub/
GitLab; a component/label + JQL on Jira).

## Structured output contract (v1)

The reasoner is prompted "Respond with JSON only (no markdown fences)" and the
result is `parseLLMJSON`'d:

```jsonc
{
  "analysis": "brief reasoning summary (logged, not filed)",
  "proposal": {                    // null if nothing worth filing this run
    "scope": "app-improvement | app-data-gap | loop-meta | portos-self",
    "slug": "kebab-stable-id",     // dedup key
    "title": "…",
    "body": "…",                   // markdown; handler appends the slug marker
    "value": "why this is the single highest-value item now"
  },
  "pause": {                       // null if not pausing
    "blockOnIssue": "this | <existing #>",
    "reason": "…"
  }
}
```

Handler flow per app: park-check → (if not parked) gather → reason → validate
JSON → scope-gate → dedup → file ≤1 issue → apply pause label if requested →
update `lastRunAt`. Invalid/empty JSON is a no-op for that app (logged), never a
throw that aborts the sweep.

## Per-app config (`app.layeredIntelligence`, via `updateApp`)

```jsonc
{
  "enabled": false,
  "intervalMs": 86400000,          // per-app cadence within the sweep
  "providerId": null, "model": null,
  "sources": {                     // Layer-1 toggles
    "goals": true, "cosMetrics": true, "healthReport": true,
    "planMd": true, "openIssues": true,
    "custom": [ { "type": "file", "ref": "docs/METRICS.md" } ]
  },
  "rules": "free-text guidance injected into the reasoner prompt",
  "allowedScopes": ["app-improvement", "app-data-gap"]
}
```

PortOS ships a baseline config: all default sources on; `allowedScopes` includes
`loop-meta` and `portos-self`.

## Files touched

- `server/services/layeredIntelligence.js` — **new.** Source-gathering, prompt
  building, tracker filer, dedup/pause helpers (keeps the handler thin; one
  concern per file). Re-exported from `server/services` per the barrel rule if it
  exposes reusable helpers.
- `server/services/autonomousJobs/scriptHandlers.js` — new `runLayeredIntelligence`
  handler wired into the `category → handler` map (the sweep + 4 layers).
- `server/services/apps.js` — `getAppLayeredIntelligenceConfig` /
  `updateAppLayeredIntelligence` accessors + defaults.
- `data.reference/cos/autonomous-jobs.json` — seed the new job entry (off).
- `data.reference/` — baseline PortOS `layeredIntelligence` config seed.
- `scripts/migrations/NNN-add-layered-intelligence-job.js` — add the job entry +
  PortOS baseline config to existing installs (per-install applied-list).
- Client — per-app config surface (a `Drawer` tab on the app config, reusing the
  shared tabbed `Drawer` convention; deep-linkable tab via `useDrawerTab`). Add a
  `NAV_COMMANDS` entry only if it gets its own route.
- Tests — handler dedup / pause / scope-gating (pure-logic copies per the repo's
  inline-copy test convention), config accessors, tracker-filer dispatch.

## Constraints honored

- **AI-provider policy.** Off by default; only runs as a user-enabled scheduled
  automation. No cold-bootstrap calls.
- **Distribution model.** Job entry + baseline config ship via `data.reference/`
  and a migration, so existing installs and forks pick it up.
- **Single-user trust model.** No auth/rate-limit/concurrency additions; a simple
  per-app in-flight guard within the sweep is sufficient.
- **No try/catch** except at the scheduler/async boundary (the sweep runs outside
  the request lifecycle — a per-app failure is caught, logged emoji-style, and
  the sweep continues).

## Deferred / follow-ups (YAGNI trim for v1)

- Custom `http` and `cmd` telemetry sources (shell-exec allowlist + HTTP surface).
  v1 ships `file` custom sources + the built-ins only.
- Optional Engine-A hand-off: for a rare trivial+safe fix, enqueue a coding agent
  instead of only filing an issue.
- Semantic (vector-Memory) dedup on top of the slug/label deterministic dedup, to
  catch near-duplicate proposals worded differently.
- A dedicated route/page + `⌘K` entry if the per-app drawer proves insufficient.
```
