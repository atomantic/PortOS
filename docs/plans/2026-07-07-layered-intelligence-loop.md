# Layered Intelligence Loop — Design

> Status: approved design (2026-07-07). Tracking issue:
> [#2262](https://github.com/atomantic/PortOS/issues/2262).

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

- Registered as a single global script job in the code-level `DEFAULT_JOBS`
  catalog (`server/services/autonomousJobs/defaults.js`) with `type: 'script'`,
  `category: 'layered-intelligence'`, and `scriptHandler: 'layered-intelligence'`
  — the `scriptHandler` field is what `isScriptJob` gates on and what
  `SCRIPT_HANDLERS` is keyed by (dispatch is by `scriptHandler`, not `category`;
  the existing `goal-check-in` job carries both). The catalog is materialized into
  each install's `data/cos/autonomous-jobs.json` on boot and scheduled by
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
  if a match exists (open, or closed within the last 30 days), the proposal is
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
- **jira** — via `createTicket()` in `server/services/jira.js` (`POST
  /rest/api/2/issue`); dedup by a slug marker in the description, pause via a
  label + JQL. (`jiraReports.js` is read/report-only — not the filer.)
- **`plan`** — `resolveWorkTracker` returns `resolved: 'plan'` (the `source:
  'fallback'` default) for any managed app whose origin is not a recognized
  forge. These apps have no label/issue substrate, so the loop **appends the
  proposal to the app's `PLAN.md`** as a slug-tagged `[lil-<slug>]` checklist
  item (reusing the `reference-watch` append pattern), dedups by scanning
  `PLAN.md` for the slug, and **does not support pause** (there is no issue to
  block on — the app is simply re-evaluated next run). The handler branches on
  `resolved` up front so a `plan` app never hits the forge-only `fileIssue`/
  label paths.

**Label bootstrapping.** `gh issue create --label <label>` (and the GitLab
equivalent) fails if the label doesn't exist yet, so the forge filer ensures the
`layered-intelligence` and `layered-intelligence:blocking` labels exist once
before first use (`gh label create --force …` / `glab label create`). Dedup-query
and pause-labeling then have per-tracker equivalents (labels on GitHub/GitLab; a
description slug marker + JQL on Jira; a PLAN.md slug scan on `plan`).

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

`proposal` and `pause` are independent and **may both be present in one
response** — the loop can file the single issue and immediately park the app on
it. `blockOnIssue: "this"` resolves to the number of the issue just filed from
`proposal` (so filing must happen before the pause label is applied); an integer
targets a pre-existing open issue. A `pause` with `blockOnIssue: "this"` but a
`null` proposal is invalid (nothing to block on) and is treated as no pause.

Handler flow per app: park-check → (if not parked) gather → reason → validate
JSON → scope-gate → dedup → file ≤1 issue → (if `pause`) resolve `blockOnIssue`
and apply the blocking label → update `lastRunAt`. Invalid/empty JSON is a no-op
for that app (logged), never a throw that aborts the sweep.

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
  handler registered in the `SCRIPT_HANDLERS` map under the key
  `'layered-intelligence'` (the sweep + 4 layers).
- `server/services/apps.js` — `getAppLayeredIntelligenceConfig` /
  `updateAppLayeredIntelligence` accessors. The accessor returns the default
  config (all sources on; PortOS gets `loop-meta`/`portos-self` scopes) when the
  app record has no `layeredIntelligence` key, so no per-app seed write is needed
  — an install picks up the baseline the first time the loop reads it.
- `server/services/autonomousJobs/defaults.js` — add the `layered-intelligence`
  entry to the `DEFAULT_JOBS` catalog (enabled: false). `applyAdditiveFields` /
  `mergeWithDefaults` add it to existing installs' `data/cos/autonomous-jobs.json`
  on boot — no separate seed file or migration for the job entry itself.
- `scripts/migrations/NNN-…js` — **only if** enabling the baseline on existing
  PortOS installs by default is wanted; the accessor-default above makes a
  migration optional, not required.
- Client — per-app config surface (a `Drawer` tab on the app config, reusing the
  shared tabbed `Drawer` convention; deep-linkable tab via `useDrawerTab`). Add a
  `NAV_COMMANDS` entry only if it gets its own route.
- Tests — handler dedup / pause / scope-gating (pure-logic copies per the repo's
  inline-copy test convention), config accessors, tracker-filer dispatch.

## Constraints honored

- **AI-provider policy.** Off by default; only runs as a user-enabled scheduled
  automation. No cold-bootstrap calls.
- **Distribution model.** The job ships in the `DEFAULT_JOBS` catalog and is
  merged into existing installs' job store on boot (`applyAdditiveFields`); the
  per-app baseline comes from the config accessor's default — so existing installs
  and forks pick it up without a hand-written seed file.
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
