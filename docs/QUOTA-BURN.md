# Quota-burn automation

Quota-burn spends subscription-backed CLI quota that would otherwise expire
unused. It is **one install-level loop inside PortOS** — not a per-managed-app
scheduled task — configured at **Dev Tools → Quota Burn** (`/devtools/quota-burn`).

It is disabled by default. Enabling it is explicit consent to spend those
subscriptions on a schedule.

## How a cycle works

Every `checkIntervalMinutes` (default 30, bounded 5–720) the runner:

1. Reads the plan from `data/cos/quota-burn.json`. If the master switch is off it
   stops here — **no provider is contacted**.
2. Takes a zero-token quota reading for every enabled provider family.
3. Selects families whose soonest window is inside `resetWithinHours`, still has
   headroom above `reservePercent`, and has not spent `maxDispatchesPerWindow`
   for that window. Ties break on `priority` (lower wins).
4. Runs the **first enabled job in that family's ordered plan that reports
   pending work** — at most one dispatch per cycle.
5. Charges the window in `data/cos/quota-burn-dispatches.json` and appends the
   outcome (including skips, with reasons) to `data/cos/quota-burn-runs.json`.

Everything fails closed: an unknown reset time, an unsupported provider, a
quota-read error, a card that declares itself unburnable (`burnable: false`, e.g.
the Image Gen card), or a family with no enabled jobs all mean "do not dispatch".

## Burn jobs

A family's plan is an **ordered list** — that ordering is the configuration ("do
the missing bible images first, then fall through to agent work"). Each job has
its own type, optional model/provider pin, and type-specific params.

| Job type | What it does |
| --- | --- |
| `agent-prompt` | Queues a CoS agent in a named managed app with a custom prompt. Visible in the CoS queue and Active Agents like any other task. |
| `universe-bible-images` | **Programmatic** — no agent. Enqueues renders for universe bible entries whose `imageRefs[]` is empty. Render backend defaults to the burning family's own image mode, so a codex burn spends codex's image quota. |

Adding a job type is three edits: a `QUOTA_BURN_JOB_TYPE` entry + catalog row in
`server/lib/quotaBurnConfig.js`, a module in `server/services/quotaBurnJobs/`, and
one line in that directory's `JOB_MODULES`. The config page builds its form from
the catalog, so no client change is needed unless the job introduces a param kind
the form doesn't render yet.

Each job module exports `countPending` (cheap, side-effect free — the page calls
it on every load) and `run` (the only thing that may spend quota). A job that
declines reports `dispatched: false` with a reason and is **not** charged against
the window's cap.

## Manual runs

- **Evaluate now** runs a full cycle immediately, ignoring the master switch but
  respecting every quota gate.
- **Burn now** on a family card scopes that cycle to one family.
- The ▶ on a job row **forces** that one job past the window/reserve/cap gates.
  A forced run carries no window key and is deliberately not charged against the
  family's automatic budget.

## Storage

The plan, the dispatch ledger, and the run log all live machine-locally under
`data/cos/` and are intentionally **not federated**: quota belongs to a
particular machine and provider account, and the "which managed app" targets
differ per machine.

## Migration from the per-app task type

Before this, quota-burn was a `quota-burn` entry in each managed app's
`taskTypeOverrides`, which meant two enabled apps ran two independent loops
racing for the same window budget. Migration `221-quota-burn-global-config.js`
folds those overrides into the single plan (each app's family prompt becomes an
`agent-prompt` job pointing back at that app) and removes the dead task type from
`data/apps.json`. Do not re-add `quota-burn` to `TASK_TYPES`.

## Code map

| File | Role |
| --- | --- |
| `server/lib/quotaBurnConfig.js` | Plan shape, job-type catalog, total normalization |
| `server/services/quotaBurnStore.js` | `data/cos/quota-burn.json` + the run log |
| `server/services/quotaBurn.js` | Candidate selection + the dispatch ledger |
| `server/services/quotaBurnJobs/` | The job registry and its modules |
| `server/services/quotaBurnRunner.js` | The loop, the cycle, and the status feed |
| `server/routes/quotaBurn.js` | `/api/quota-burn` |
| `client/src/pages/QuotaBurn.jsx` | The config page |
