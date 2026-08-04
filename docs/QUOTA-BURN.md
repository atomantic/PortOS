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

Each job module exports `countPending` (side-effect free — the page calls it on
every load) and `run` (the only thing that may spend quota). `countPending` may
return an opaque `context` that the runner hands straight to `run`, so a probe
that scanned every universe bible to produce its count doesn't make `run` repeat
the scan; `run` must still work without it, because the force path calls it with
no probe. A job that declines reports `dispatched: false` with a reason and is
**not** charged against the window's cap.

### Prompt presets

`agent-prompt` jobs can be seeded from `QUOTA_BURN_PROMPT_PRESETS`
(`server/lib/quotaBurnPresets.js`), served in the config catalog and applied from
either **Add a preset job** on a family card or **Start from a preset** on a job
row. Each preset is one narrow audit dimension — the single-focus form of
`/do:better --issues` — that reads real code, files decision-complete GitHub
issues, and changes nothing:

| Preset | Focus |
| --- | --- |
| UX issues | Interaction friction: unconfirmed destructive controls, invisible save state, unexplained disabled buttons, lost edits, dead ends |
| Accessibility issues | Keyboard paths, labels, focus management, live-region state, contrast |
| Mobile & responsive issues | Overflow, touch targets, hover-only information, drawer/modal behavior at small widths |
| Error & empty-state issues | Swallowed failures, doubled/missing toasts, absent-vs-empty conflation, stale UI, unsaved-work loss |
| Performance issues | Per-item I/O, repeated scans, unbounded growth, render storms, timers, leaks |
| Test coverage gaps | Untested guards on irreversible/expensive paths, fixes landed without regression tests, false-green mocking |
| Dead code & duplication | Unreferenced exports, re-implemented helpers, copy-paste drift (never cross-version compatibility code) |
| Data & upgrade-safety issues | Missing migrations/seeds, schema-parity drift, version gates, destructive defaults |
| Docs drift | Doc claims the code contradicts, stale commands, undocumented surfaces |
| Security issues | Real exposure under the documented threat model — findings that contradict it are noise |

Presets are **templates**: picking one COPIES its prompt into the job's own
`params.prompt`, and nothing on disk points back at the preset id. So editing the
text here never rewrites a configured job on any install (no migration needed) —
and an improved prompt reaches an existing job only when the user re-picks it.
### The "lands no code" postures

An `agent-prompt` job has two of them, and they are not the same thing:

| Param | Means | Use when |
| --- | --- | --- |
| `noCodeOutput` | The deliverable is what the agent **does during the run** — files an issue, calls an endpoint. It needs no branch and no isolation because it writes nothing, so it runs in the app's own checkout on whatever branch that is. | The audit presets |
| `discardWorktree` | The job **does** want a scratch checkout (it builds, runs tests, edits to reason) but nothing in it may land: the worktree is removed without merging. | A job that must run a build/test cycle |

Either one forces `openPR`/`simplify` off in the runner (both presuppose a diff
to ship, and an `openPR: true` that can never produce a PR makes the spawner
report `pr-missing` and **retry**, burning up to five agent runs per window) and
sets `worktreeChangesExpected: false`, so a run that correctly changed nothing
isn't failed by the idle-complete gate. Both default to `false`, so a job meant
to land code is unaffected.

The audit presets take the **first** posture: `useWorktree: false` +
`noCodeOutput: true` + `openPR: false` + `simplify: false`. Isolating a
read-only audit would be worse, not better — `useWorktree: true` with
`openPR: false` is the **auto-merge** posture (`agentWorktreeCleanup.js` merges
the agent branch onto the source workspace's default branch on success), so
"isolating for safety" hands the audit a way to land code. Writing nothing is
the stronger guarantee, and `noCodeOutput` strips every commit/push/PR
instruction from the prompt — including the Git Hygiene arm that would otherwise
tell a **no-worktree** task to `/do:push` to the branch it is standing on, which
for a task in the app's live checkout is its default branch. (That arm also
covered the Creative Director agents, which run in the same shape.)

The tradeoff: an audit runs in the user's working copy, so its prompt is
explicit that it must leave the tree and the branch exactly as it found them.
A job that genuinely needs to build or test should tick `discardWorktree`
instead.

Every numeric bound (windows, reserve, caps, entry limits) lives in
`QUOTA_BURN_BOUNDS` in `server/lib/quotaBurnConfig.js`, read by the normalizer
(which clamps an older on-disk plan), the Zod schemas (which reject a bad
request), and the catalog descriptors the client renders as `min`/`max`.

## Manual runs

- **Evaluate now** runs a full cycle immediately, ignoring the master switch but
  respecting every quota gate.
- **Burn now** on a family card scopes that cycle to one family.
- The ▶ on a job row **forces** that one job past the window/reserve/cap gates.
  It goes through the same selection, so the run still reports the family's real
  remaining percentage and reset time — it is only marked `charge: false`, so it
  never eats the family's automatic budget. It **arms on first click** and
  dispatches on the confirm: the page has no Save button, so a spend-now control
  sitting among the row's small icons was being hit as if it were one.

## Storage

Four files under `data/cos/`, all machine-local and intentionally **not federated**: the plan (`quota-burn.json`), the per-window dispatch ledger (`quota-burn-dispatches.json`), the run log (`quota-burn-runs.json`), and the in-flight set (`quota-burn-inflight.json` — entries a job enqueued whose renders have not landed yet, so the next cycle does not re-queue them; 6-hour TTL). They are not federated: quota belongs to a
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
| `server/lib/quotaBurnPresets.js` | Ready-made single-focus audit prompts for `agent-prompt` jobs |
| `server/services/quotaBurnStore.js` | `data/cos/quota-burn.json` + the run log |
| `server/services/quotaBurn.js` | `evaluateFamily` — the one gate ladder both selection and the page's skip reasons read — plus the dispatch ledger |
| `server/services/quotaBurnJobs/` | The job registry and its modules |
| `server/services/quotaBurnRunner.js` | The loop, the cycle, and the status feed |
| `server/routes/quotaBurn.js` | `/api/quota-burn` |
| `client/src/pages/QuotaBurn.jsx` | The config page |
