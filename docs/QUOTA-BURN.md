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
3. Selects families whose **target window** (see below) is inside
   `resetWithinHours`, that no provider refusal is currently blocking, that still
   have headroom above `reservePercent` in *every* window on the card, and that have
   not spent `maxDispatchesPerWindow` for that window (`-1`, the default, means
   no cap — see below). Ties break on `priority` (lower wins).
4. Runs the **first enabled, available, unspent step in that family's ordered
   plan that reports pending work** — at most one dispatch per cycle. The step
   is dispatched through the referenced task's own invocation path, so the run
   is indistinguishable from the same task started by hand.
5. Accounts for it **when the work is accepted, not when it is asked for**, and
   appends the outcome (including skips, with reasons) to
   `data/cos/quota-burn-runs.json`. The two synchronous lanes — a programmatic
   handler, which runs inline, and a custom app job, which `addTask` queues in
   the same call — are accepted on return and charge
   `data/cos/quota-burn-dispatches.json` immediately. A built-in task goes out as
   an on-demand REQUEST an engine may still refuse, so it takes a reservation in
   `data/cos/quota-burn-pending.json` instead: the reservation counts against
   `maxDispatchesPerWindow` and blocks a second burn of the same step, and the
   next cycle joins the request to the task it produced (by the
   `quotaBurnRequestId` stamped on that task) to charge it exactly once — or
   releases it uncharged if nothing was generated. See "Charging exactly once"
   below.

Everything fails closed: an unknown reset time, an unsupported provider, a
quota-read error, a card that declares itself unburnable (`burnable: false`, e.g.
the Image Gen card), a family with no enabled steps, or a step whose referenced
task is gone or switched off all mean "do not dispatch".

## Which window a family burns against

Every subscription family publishes **two** windows on the same card — a short
rolling one (claude/codex `session` ≈ 5h, antigravity `5-hour`) and a long one
(`week`, `month`). They answer different questions, and quota-burn reads both:

| | Which window | What it is used for |
| --- | --- | --- |
| **Target** | The **broadest** window on the card (usually weekly) | The allowance that expires unused. Its reset is the deadline `resetWithinHours` measures, its percentage and countdown are what the family card shows, and its reset epoch is the key `maxDispatchesPerWindow` counts against — so the cap means "per weekly window". |
| **Limiting** | The **narrowest** window on the card (usually 5-hour) | What actually refuses a run. It is the horizon a denial backs off to, and it is named in the burn prompt so the agent understands a mid-run refusal. |
| **Tightest** | Whichever window on the card has the least headroom | What `reservePercent` guards, so a full session window can't be used to justify draining a nearly-empty weekly one. |

Selecting the *soonest-resetting* window instead conflated target with limiting:
the 5-hour window is nearly always the soonest, so the page reported "resets in
3h" for a plan written against a weekly allowance, `resetWithinHours` re-opened
every five hours (so "only spend as the window is about to expire" bounded
nothing), and the dispatch cap meant "N burns every 5 hours".

Periods are classified in `server/lib/quotaWindows.js` from the `scope`/`label`
words the adapters emit, or from an exact `periodHours` when a provider states
one (codex's telemetry carries `window_minutes`). A family whose windows can't be
classified at all falls back to soonest-reset ordering.

## The dispatch cap is opt-in

`maxDispatchesPerWindow` defaults to **-1 (unlimited)**: the tally is not
consulted at all, and the window's spend is bounded by the gates that read live
numbers — `resetWithinHours`, `reservePercent`, and the provider's own refusal
(below). A count-based ceiling stacked on top of those read like a safety
property but mostly stopped a plan mid-window with quota still on the table,
which is the outcome quota-burn exists to prevent.

Set 1–50 for a hard ceiling per target window. **0 is not a value** — "never
burn" is what switching the family off means. The window is charged in
`quota-burn-dispatches.json` either way, so the family card still shows how many
burns the current window has spent (without a denominator when uncapped).

Migration 226 lifts an existing plan that still carries the old default of 5;
any other stored value is a number the user chose and is left alone.

## Stop condition: an observed refusal

Reported numbers are stale by design (scraped every few minutes, rounded to whole
percent) and they describe the *target* window. What actually stops a burn is the
short window emptying underneath it: a plan spending a weekly allowance runs task
after task until the 5-hour window is gone, at which point every further dispatch
fails instantly, wastes an agent spawn, and leaves a red card in the CoS queue —
while the weekly card still reads "60% left, resets in 2 days".

So a refusal is recorded as a fact. When an agent a burn dispatched dies with a
usage-limit failure, `server/services/quotaBurnDenials.js` blocks that family in
`data/cos/quota-burn-denials.json` and `evaluateFamily` reports it as the gate:

- **Recorded inside the completion continuation, before it dispatches.** The
  runner's `onBurnAgentCompleted` awaits `recordBurnAgentCompletion` and only
  then re-evaluates the family. That ordering is load-bearing: the continuation
  sends the next job out the moment a burn agent finishes, so a block recorded
  after it — or from a second `agent:completed` subscriber, whose ordering
  against the continuation is not guaranteed — arrives one wasted agent too late,
  every time. A ledger failure degrades to a logged warning; telemetry never
  stalls the plan.
- **Until when** — the reset the provider stated in its own refusal, else the
  reset of the family's limiting (short) window, else a 5-hour TTL so a
  reset-less block can't hold forever.
- **Cleared** the moment a burn run for that family *succeeds* — the provider
  serving is more current evidence than any stated reset.
- **Only burn-dispatched agents count.** The family and the limiting window's
  reset ride on the task as `metadata.quotaBurnFamily` /
  `metadata.quotaBurnLimitingResetAt` (the same provenance the cooldown exemption
  and the continuation already read); an unrelated task that happens to hit a
  usage limit says nothing about the burn plan.
- **Narrower than a generic rate limit.** A transient `429` is a retry, not a
  spent window — blocking a family for hours over one would be worse than missing
  a burn. An analyzer `usage-limit` verdict is trusted only when it came from a
  structured provider marker, not a loose keyword sweep over the agent's own
  narration.
- **Bypassable by a forced run** (the ▶ on a step row), which is how a user
  retries a block they believe is stale.

## Burn steps

A family's plan is an **ordered list of steps**, and that ordering is the
configuration ("do the missing bible images first, then fall through to agent
work"). A step does not *contain* work. It **references** a scheduled task the
user already owns, and layers per-invocation overrides on it:

```jsonc
{
  "id": "job-abc",
  "enabled": true,
  "label": "Nightly UX sweep",          // optional; defaults to the task's own name
  "taskRef": { "kind": "builtin", "taskType": "ux", "appId": "example-app" },
  "overrides": { "providerId": null, "model": "opus", "effort": null,
                 "params": { "fileIssues": true } },
  "runOnce": false
}
```

Two reference kinds, discriminated on `kind` (`server/lib/quotaBurnTaskRef.js`):

| `kind` | Points at | Target |
| --- | --- | --- |
| `builtin` | A PortOS scheduled task TYPE (`ux`, `security`, `repo-sync`, `universe-bible-images`, …) as configured in **CoS → Schedule** | `appId` names the managed app, when the type acts on one |
| `custom` | An app **custom scheduled job** (**CoS → System Tasks**), by id | None — the job record owns its own app scope, so a second copy here could disagree with it |

There is no burn-only automation catalog and no burn-only prompt editor. This is
the point of the model: work is defined **once**, in Scheduled Tasks, and Quota
Burn decides *when* a family's expiring quota gets spent on it.

### Adding a burn action

1. Create (or find) the work in **CoS → Schedule** (a built-in task type) or
   **CoS → System Tasks** (a custom job). New burn-only work should be an
   **on-demand** scheduled task — no interval, so it costs nothing until
   something asks for it. The page links straight there ("Create an on-demand
   scheduled task").
2. On **Dev Tools → Quota Burn**, expand a family and pick it from **Add a step**.
   The picker is searchable and grouped into *PortOS scheduled tasks* and
   *App custom tasks*; it matches on the task name, its description, and the apps
   it can target.
3. Pick a target app if the task acts on one, then set any per-invocation
   overrides. The row states the **effective** settings and audit mode before you
   save or run.

Nothing here writes back to the task, and **removing a step never deletes the
scheduled task it referenced** — only the step's own order, name, overrides and
run-once state go away.

### Inheritance and overrides

`overrides` is layered over the referenced task's SAVED settings by
`effectiveSettings` (`server/services/quotaBurnInvoke.js`), mirrored on the
client by `effectiveQuotaBurnSettings` (`client/src/lib/quotaBurnTasks.js`):

| Field | Unset (`null`) | Set |
| --- | --- | --- |
| `providerId` | Inherits the task's pin, else the family's own resolution | Pins the binary — rejected at save time if it belongs to another quota family |
| `model` / `effort` | Inherits the task's saved pin | Pins for this burn only |
| `params` | Inherits the task's whole `taskMetadata` | **Merged key by key** over it, so overriding one run parameter does not blank the rest |

The join is on **presence, not truthiness**: an override the user clears
normalizes to `null` and goes back to inheriting. That is also why the editor
sends the `overrides` bag and omits the top-level `model`/`providerId`/`effort`/
`params` compat mirrors the GET still returns — `normalizeQuotaBurnJob` resolves
them by presence, so echoing a stale mirror back would silently restore a pin the
user had just cleared (`quotaBurnStepPayload`).

For an **audit** task type the overrides include the **audit mode** —
`params.fileIssues`, the same `file issues only` ⇄ `do the work` switch the
Schedule page shows. The row names the effective mode (and which half it came
from) before anything runs, because that is the difference between a window spent
filing issues and a window spent landing code. A **programmatic** task's run
parameters are per-type and live on the task itself; the row renders them
read-only with a link to edit them where they belong.

### Eligibility — what a step may point at

The picker only offers, and the runner only dispatches, work a burn can actually
invoke. `getQuotaBurnTaskCatalog` builds the verdict server-side; the client
mirrors the same rules so a dead end never appears as a choice:

| Rule | Why |
| --- | --- |
| A built-in type whose `invocation.userInvokable` is false is **excluded** | It is not something a user (or a burn) starts |
| A custom job of type `shell` or `script` is **excluded** (`isBurnEligibleCustomJob`) | It runs a command or a built-in handler and spends no provider quota, which is the only thing a burn is for |
| A custom job below the `yolo` autonomy level is **refused at dispatch** | It needs an approval an unattended burn cannot give |
| A **disabled** task or job is offered, with the reason | It is one click from fixed on the page the row links to |
| A type that requires a managed app is targeted from the apps that **enabled** it | The availability resolver reports `wrong-scope` for any other app |
| An install-wide or programmatic type takes **no** app | The schema rejects a request from either that names one |

A step that stops being invocable is **retained, never deleted** — its label,
order, overrides and run-once state are the user's, and a task that comes back
should find its step exactly as it left it. `resolveQuotaBurnStepAvailability`
stamps `{ code, reason }` onto the config the page reads (derived per read, never
persisted — it goes stale the moment a task is re-enabled), and the row renders
that reason **with no run affordance at all**: offering a ▶ whose only outcome is
a decline is worse than offering nothing. The codes are `legacy-unmigrated`,
`unknown-task`, `dangling-job`, `disabled`, `missing-app`, `wrong-scope`, and
`incompatible`.

### The programmatic bible tasks

`universe-bible-describe` and `universe-bible-images` are ordinary **on-demand
scheduled tasks** that PortOS executes itself (`server/services/scheduledHandlers/`)
— no agent, no CoS task, no spawn slot. They appear in CoS → Schedule with their
own settings and a Run Now button, and a burn step and a manual run go through
the same handler. They are never clock-due: a fresh install spends nothing on
them until someone presses Run or adds one to a burn plan. Passing the burning
`family` is what pins the provider / render backend to the subscription being
drained; a manual run has no family and resolves the way any other scheduled task
does.

### Describe before you render

`universe-bible-describe` is the step that belongs **before** `universe-bible-images`
in a plan. An image rendered from a character row holding only a name is a
generic figure that has to be thrown away — and it has already spent the image
quota. Ordering the two describe→images in the family's rotation walks the
backlog into shape first, then renders from something worth rendering.

The task's `depth` parameter picks what "described" means, per
`server/lib/universeBibleCompleteness.js`:

- **`core`** — the entry is unusable without these: a character's
  `physicalDescription` / `personality` / `background` / `motivations` /
  `visualNotes`; a place's or object's `description`.
- **`full`** (default) — the whole sheet. For a character that is every field the
  character-sheet expand prompt fills: the visual set (silhouette, posture,
  palette, props, expressions, hand gestures, wardrobes), the novelist set
  (likes, mannerisms, relationships, skills), and the Ghost → Wound → Lie → Want
  → Need framework with its arc type, sliders, and the optional psychology
  profile (theory of control + survival / connection / status drives). `full` is the default because
  the job exists for the sheet — a cast member with a one-line description still
  renders inconsistently from panel to panel.

Cast is the point but not the whole scope: places and objects run through
`universe-canon-entry-expand` (description, palette/era/weather/recurring details
for a place; description + significance for an object). Category variations and
composite sheets are **out of scope** — their sanitizer already requires a
prompt, so one cannot exist undescribed.

Locked entries are never picked, and every attempted entry is stamped into the
shared in-flight ledger for its 6-hour TTL. Why picks are ranked by blank
*fraction* rather than raw gap count, and why the stamp covers entries the model
declined to fill, are argued at the code site
(`server/services/scheduledHandlers/universeBibleDescribe.js`).

The image task's opt-in `requireDescribed` is the other half of the pairing: with
it on, canon entries with no `core` description are held out of the render
backlog until the describe job has been through them. It defaults **off**, so an
existing plan keeps rendering exactly the backlog it rendered yesterday.

### Repeating vs one-shot work (`runOnce`)

A plan is a **rotation**: the walk resumes after the family's last dispatch
(`rotatePlanAfter`), so an N-step plan cycles through all N and then starts the
next lap, spending the window until a gate closes. That is right for standing
work — an audit dimension is worth re-running as the code moves — and wrong for
work that only needs doing once, which was simply re-done every lap.

Each step therefore carries a **`runOnce`** flag (default `false`, so every plan
written before it keeps repeating):

| `runOnce` | Behavior |
| --- | --- |
| `false` | Standing work. Repeats every lap while the window still has quota. |
| `true` | One-shot. Records its dispatch and drops out of the rotation until re-armed. |

A whole plan of `runOnce` steps is how "run this series once" is expressed: the
completion continuation walks it one agent at a time and it stops of its own
accord instead of looping.

- **The ledger is `data/cos/quota-burn-completions.json`**, `<familyId>:<jobId>`
  → the ISO instant it ran, capped (newest kept) at **twice** the keys a
  maxed-out plan can hold — derived from `QUOTA_BURN_FAMILIES` and
  `jobsPerFamily.max`, so pruning can only evict a step already deleted from the
  plan, never a live one. It is a
  separate file rather than a flag on the job because a config PUT **replaces**
  a family's `jobs` array — that is how every reorder and edit saves — so a flag
  on the job would be reset by an unrelated edit, and by the client's optimistic
  copy of the plan, which never sees the runner's write. The run log can't answer
  it either: it is a capped UI feed, so a step that ran last month has aged out.
- **Recorded only on a real dispatch.** A step that declines (`dispatched: false`)
  is not spent — a misconfigured step must stay retryable.
- **A forced ▶ run bypasses the gate AND still records.** `charge: false` is about
  the *window's automatic budget*; `runOnce` is a statement about the *work*, and
  the work just happened however it was triggered.
- **An unreadable ledger fails CLOSED** — `getQuotaBurnCompletions` returns
  `null` (not `{}`) for a failed read, so the cycle reports `run-once ledger
  unreadable` rather than treating "nothing has run" as fact and re-dispatching
  every one-shot step. `writeLedger` refuses to write over an unread ledger for
  the same reason: an empty write erases the completions that survived. Same
  posture, and the same `readJSONFileStrict` shape, as `quotaBurnDenials.js`.
- **A finished plan stops costing a quota scrape.** `familyHasRunnableJobs(family,
  completions)` returns false once every enabled job is a spent one-shot, so the
  cycle returns before the multi-second per-family TUI scrape. The page reports
  it as `every enabled job has already run once` (`PLAN_COMPLETE_SKIP_REASON`,
  shared with the runner's pre-scrape early return so one condition can't be
  worded two ways), kept distinct from `no enabled jobs configured` — a finished
  plan wants Re-arm, an unset one wants a job added. It is a **second named
  predicate** rather than an optional argument on `familyIsConfigured`: array
  callbacks pass the index as the second argument, so an overloaded arity turns
  `some(familyIsConfigured)` silently wrong.
- **Re-arm** puts steps back in the rotation: the ↺ on a step row for one step,
  **Re-arm all** on the plan header for the family. `POST /api/quota-burn/rearm`
  with `{ familyId, jobId? }`; a `familyId` is required, since a bare "clear
  everything" would silently re-queue every one-shot job on the install. It
  dispatches nothing — the next cycle still faces every gate.

### Adding a NEW kind of burn action (code)

There is no `QUOTA_BURN_JOB_TYPE` to extend any more — `QUOTA_BURN_JOB_CATALOG`
and `quotaBurnPresets.js` are frozen compatibility inputs, and nothing new
belongs in them. A new burn action ships as a **scheduled task**, and Quota Burn
picks it up for free:

- **Agent work** — add the task type (or let the user create a custom job in
  System Tasks). If it should be configurable to *file issues* vs *do the work*,
  add it to `AUDIT_DEFINITIONS` in `server/lib/auditCatalog.js`. See
  `docs/ARCHITECTURE.md` → "Adding CoS Task Types".
- **Work PortOS performs itself** — register the module in
  `SCHEDULED_HANDLER_MODULES`, add its task type to
  `PROGRAMMATIC_SCHEDULED_TASK_TYPES` + `DEFAULT_TASK_INTERVALS` in
  `server/services/taskScheduleRegistry.js` (enabled, `ON_DEMAND`, no interval),
  and allow-list its params in `sanitizeTaskMetadata`. The task's saved
  `taskMetadata` is the params bag; a burn step passes its own overrides plus
  the burning `family`, which is what pins the provider/render backend to that
  subscription.

No client change is needed either way: the picker reads the same catalogs the
Schedule and System Tasks pages do.

A programmatic handler exports `countPending` (side-effect free — the page calls
it on every load, so listing or probing must spend nothing) and `run` (the only
thing that may spend quota). `countPending` may return an opaque `context` that
the runner hands straight to `run`, so a probe that scanned every universe bible
to produce its count doesn't make `run` repeat the scan; `run` must still work
without it, because the force path calls it with no probe. A step that declines
reports `dispatched: false` with a reason and is **not** charged against the
window's cap.

### Audits — where the wording lives now

The audit dimensions a burn window is usually spent on (UX, accessibility,
mobile/responsive, error & empty states, performance, test coverage, dead code,
data & upgrade safety, docs drift, security, API & route contracts, React
lifecycle, logging, copy clarity) are **scheduled task types**, defined once in
`AUDIT_DEFINITIONS` (`server/lib/auditCatalog.js`) with their prompts in
`DEFAULT_TASK_PROMPTS`. A burn step references one and picks its **audit mode**
per invocation; the wording is edited in CoS → Schedule, where every other
consumer of that task reads it.

`QUOTA_BURN_PROMPT_PRESETS` (`server/lib/quotaBurnPresets.js`) is what that
replaced: a burn-only table of prompt templates whose text was **copied** into a
step's `params.prompt`, with nothing on disk pointing back at the preset id. It
is retained as a **compatibility input only** — a plan written before the
reference model still loads, and it is the source the migration reads. Nothing
new belongs in it, and the config page no longer serves or renders it.

Each audit prompt spends **roughly the first two thirds of the window on
research**: trace each candidate end to end, read the tests and `git log` around
it, name the path that actually reaches the failure, and decide the fix (files,
tests, and the rejected alternative) before filing. The cap stays at 5 issues
with two or three as the target — depth over volume.

Filing carries a **required** label contract: exactly one `model:` and exactly
one `effort:` label on every issue, chosen as independent axes from the code the
agent just read (`MANDATORY_DISPATCH_HINT_GUIDANCE` in `server/lib/dispatchLabels.js`).
Contributor labels (`good first issue`, `help wanted`) stay optional, missing
labels are created lazily, category labels (`plan`, `ux`, `bug`, `tests`,
`area:*`, …) are preserved, and the agent reads each new issue's labels back to
repair any that did not stick.

### The "lands no code" postures

An agent task has two of them, and they are not the same thing. Both are saved
`taskMetadata` on the scheduled task; a burn step can override them per
invocation like any other run parameter:

| Param | Means | Use when |
| --- | --- | --- |
| `noCodeOutput` | The deliverable is what the agent **does during the run** — files an issue, calls an endpoint. It needs no branch and no isolation because it writes nothing, so it runs in the app's own checkout on whatever branch that is. | The audit task types |
| `discardWorktree` | The job **does** want a scratch checkout (it builds, runs tests, edits to reason) but nothing in it may land: the worktree is removed without merging. | A job that must run a build/test cycle |

Either one forces `openPR`/`simplify` off in the runner (both presuppose a diff
to ship, and an `openPR: true` that can never produce a PR makes the spawner
report `pr-missing` and **retry**, burning up to five agent runs per window) and
sets `worktreeChangesExpected: false`, so a run that correctly changed nothing
isn't failed by the idle-complete gate. Both default to `false`, so a job meant
to land code is unaffected.

The audit task types take the **first** posture: `useWorktree: false` +
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
A task that genuinely needs to build or test should tick `discardWorktree`
instead.

Every numeric bound (windows, reserve, caps, field lengths) lives in
`QUOTA_BURN_BOUNDS` in `server/lib/quotaBurnConfig.js`, read by the normalizer
(which clamps an older on-disk plan) and by the Zod schemas (which reject a bad
request), so raising a cap in one place cannot 400 a plan the other would accept.

## Charging exactly once

A burn's accounting hangs off **acceptance**, never off "we asked". The
distinction only exists because one of the three invocation lanes is
asynchronous:

| Lane | Accepted when | Accounting |
| --- | --- | --- |
| Programmatic handler | it returns — PortOS did the work inline | charged immediately |
| Custom app job | `addTask` returns a persisted, non-duplicate task | charged immediately |
| Built-in scheduled task | an on-demand engine generates the task, later | **reserved**, then settled |

A built-in step goes out as an on-demand request. One of the two engines
(`cos.js#spawnDequeuePriority0OnDemand`, `cosTaskGenerator.js#spawnPriority0OnDemand`)
drains it on a later cycle and may refuse it outright — improvement switched off,
the task type disabled since queuing, a managed app that has gone away, a
generator that produced nothing, an identical twin already queued. Charging at
the request would spend the window (and retire a `runOnce` step) for work that
never started: the same undercount #3179 fixed one hop further down.

So the runner takes a **reservation** in `data/cos/quota-burn-pending.json`
instead, keyed `<familyId>::<stepId>`, carrying the terms the dispatch was made
under (which window to charge, whether it charges at all, whether the step is
`runOnce`) and the request id. While it is held:

- it counts against `maxDispatchesPerWindow` exactly as a charge would, so the
  cap is honest for the whole in-flight window and the page's `N/M used` does not
  under-report;
- the step is skipped by any later cycle, so a duplicate scheduled or burn
  invocation cannot queue the same work twice.

Every cycle then settles what the last one asked for (`quotaBurnAcceptance.js`),
before deciding what to ask for next. A reservation whose request is still on the
schedule is left alone. One whose request has drained is **joined to the task the
engine produced**, by the `quotaBurnRequestId` that request stamped onto it
(`lib/quotaBurnOrigin.js`):

- **a task exists** → charge the window once, mark a `runOnce` step spent, patch
  the run-log row in place with the accepted task id, release the reservation;
- **no task exists** → release the reservation, charge nothing, and say so on the
  run-log row.

Because the join runs off persisted state — the reservation, the request and the
task are all on disk — a restart mid-flight reaches the same verdict a reconcile
a second later would have. The charge is claimed on the reservation *before* the
ledger write it authorizes, so a process killed between the two cannot charge
twice on the next pass. And an ordinary clock-driven run of the very same
scheduled task changes nothing here: it carries no burn provenance, so no
reservation ever names it, and neither the cap nor the step's one-shot state
moves.

Reads fail closed. An unreadable reservation file skips the cycle (reading it as
"nothing pending" would re-queue a step already in flight and re-open its cap
slot), and an unreadable schedule or task queue defers every reservation rather
than calling a running burn refused. The status page reads reservations but never
settles one — a probe read performs no ledger write.

## Manual runs

- **Evaluate now** runs a full cycle immediately, ignoring the master switch but
  respecting every quota gate.
- **Burn now** on a family card scopes that cycle to one family.
- The ▶ on a step row **forces** that one step past the window/reserve/cap gates.
  It goes through the same selection, so the run still reports the family's real
  remaining percentage and reset time — it is only marked `charge: false`, so it
  never eats the family's automatic budget. It **arms on first click** and
  dispatches on the confirm: the page has no Save button, so a spend-now control
  sitting among the row's small icons was being hit as if it were one. It is
  **absent entirely** on an unavailable step (the server would decline the
  dispatch, so a button whose only outcome is a toast is worse than the reason the
  row already states), and disabled while an edit is unsaved — every run control
  reads server-side config, so a run fired between the keystroke and the PUT would
  burn with the previous settings.

## Storage

Seven files under `data/cos/`, all machine-local and intentionally **not federated**: the plan (`quota-burn.json` — ordered steps, each a scheduled-task reference plus its overrides; the referenced tasks themselves live in `data/cos/task-schedule.json` and the app job store, and a burn never writes to either), the per-window dispatch ledger (`quota-burn-dispatches.json`), the run log (`quota-burn-runs.json`), the in-flight set (`quota-burn-inflight.json` — entries a job enqueued whose renders have not landed yet, so the next cycle does not re-queue them; 6-hour TTL), the denial ledger (`quota-burn-denials.json` — per-family blocks from an observed provider refusal, cleared by the next successful burn or a 5-hour TTL), the `run once` completion ledger (`quota-burn-completions.json` — which one-shot steps have had their dispatch, cleared by Re-arm), and the pending-acceptance reservations (`quota-burn-pending.json` — `<familyId>::<stepId>` → the request a burn is waiting on, released when it is accepted or refused; 6-hour TTL). None of them ships a `data.reference/` seed, because an absent file already means "nothing recorded". They are not federated: quota belongs to a
particular machine and provider account, and the "which managed app" targets
differ per machine.

## Migration

**From the per-app task type.** Before the install-level loop, quota-burn was a
`quota-burn` entry in each managed app's `taskTypeOverrides`, which meant two
enabled apps ran two independent loops racing for the same window budget.
Migration `221-quota-burn-global-config.js` folds those overrides into the single
plan and removes the dead task type from `data/apps.json`. Do not re-add
`quota-burn` to `TASK_TYPES`.

**From copied prompts to task references.** A plan written before the reference
model stores a `jobType` and a free-form `params` bag instead of a `taskRef`.
Those steps still **load** — an install upgrading across the reference model must
not lose its plan — and `normalizeQuotaBurnJob` marks each one
`legacy-unmigrated` rather than guessing which scheduled task its copied prompt
meant. Guessing at normalization time would either strand the user's edits or
silently duplicate an automation, which is why the conversion is a migration
rather than a read-time inference.

Migration `359-quota-burn-task-references.js` performs it, over the one decision
in `lib/quotaBurnLegacyConversion.js`:

- A prompt that is still a **recognized, unmodified shipped preset** becomes a
  reference to the scheduled audit it was cloned from (`auditCatalog.js`), with
  `fileIssues: true` pinned **explicitly** — every burn preset was an issues-only
  audit, and a scheduled default that says otherwise (or changes later) must not
  turn it into code-writing work.
- The two **programmatic** types become references to the scheduled handlers that
  already implement them, run params intact.
- Anything **customized, unrecognized, or without a target app** becomes an
  on-demand **custom scheduled task** holding the user's exact prompt and
  workflow settings, which the step then references. Recognition is
  `matchStoredAuditPreset` — migration 305's mission-half rule — never a label
  and never a partial match: when in doubt the conversion keeps the text, because
  a preserved prompt is recoverable and a discarded one is not.

Step ids, order, labels, disabled state and `runOnce` survive untouched, so the
completion ledger, the dispatch ledger and the reservation keys all still resolve.
A converted built-in reference only becomes **runnable** once its target app has
that scheduled task enabled — the shared availability ladder decides that, and the
migration deliberately does not enable a task type on the user's behalf. The
pre-conversion plan is parked at `data/cos/quota-burn.pre-359.json`.

Until a plan is converted, its steps keep their place, order and name while
rendering `legacy-unmigrated` and no run affordance — picking a task from the
row's own picker converts one by hand at any time.

Conversion is idempotent and interrupt-safe: a step that already carries a
`taskRef` is skipped, and a custom conversion addresses its task by a
deterministic `job-burn-<family>-<step>` id, so a re-run or a resumed run reuses
the task it created rather than minting a duplicate automation. The same service
runs on the PUT path, so a body from an older client is converted before it
reaches disk instead of being persisted as a step the runner can only refuse.

## Code map

| File | Role |
| --- | --- |
| `server/lib/quotaBurnTaskRef.js` | The step→scheduled-task reference model, its overrides bag, and the availability resolver |
| `server/lib/quotaBurnConfig.js` | Plan shape, bounds, total normalization (plus the FROZEN legacy job-type catalog) |
| `server/lib/quotaBurnValidation.js` | The strict PUT schemas — reference shape, target scope, and out-of-family provider pins |
| `server/lib/quotaBurnOrigin.js` | Burn provenance on an on-demand request, and the metadata both on-demand engines stamp from it |
| `server/lib/taskTargetScope.js` | Which task types act on one app, install-wide, or are programmatic — read by the resolver and the schema |
| `server/lib/auditCatalog.js` | The audit task types and their file-issues-vs-do-the-work contract |
| `server/lib/quotaBurnPresets.js` | FROZEN legacy prompt presets — a compatibility input, plus `matchStoredAuditPreset`, the recognition rule migration 359 converts on |
| `server/lib/quotaBurnLegacyConversion.js` | The ONE legacy-step → reference decision, shared by migration 359 and the PUT compat path |
| `server/lib/universeBibleCompleteness.js` | What "described" means per kind + depth — the field vocabulary the describe task scans with |
| `server/lib/quotaWindows.js` | Classifies a window by period — target (broadest) vs limiting (narrowest) |
| `server/services/quotaBurnInvoke.js` | The shared invocation path: builds the task catalog, resolves a step, layers its overrides, enforces the schedule's own gates, and dispatches |
| `server/services/quotaBurnAcceptance.js` | Reservations for an asynchronous acceptance, and the settlement that charges each accepted burn exactly once |
| `server/services/quotaBurnStore.js` | `data/cos/quota-burn.json`, the run log, and the pending-acceptance reservations |
| `server/services/quotaBurn.js` | `evaluateFamily` — the one gate ladder both selection and the page's skip reasons read — plus the dispatch ledger |
| `server/services/quotaBurnCompletions.js` | The `run once` completion ledger and its re-arm |
| `server/services/quotaBurnDenials.js` | The observed-refusal ledger and its `agent:completed` subscriber |
| `server/services/quotaBurnRunner.js` | The loop, the cycle, and the status feed (which stamps availability onto the config the page reads) |
| `server/services/scheduledHandlers/` | The programmatic handlers (universe bible descriptions/images) — shared by Scheduled Tasks and Quota Burn |
| `server/services/quotaBurnConversion.js` | The runtime adapter for that decision: creates the custom task and rewrites the step on a legacy PUT |
| `server/routes/quotaBurn.js` | `/api/quota-burn` — plan, status, apps/providers catalog, manual runs, re-arm |
| `client/src/lib/quotaBurnTasks.js` | The client's view of the shared task catalog: grouping, search, reference keys, effective settings, and the PUT payload |
| `client/src/lib/quotaBurnPatch.js` | The optimistic config merge (mirrors `saveQuotaBurnConfig`) and the dispatch-cap sentinel |
| `client/src/pages/QuotaBurn.jsx` | The config page |
| `client/src/components/quotaBurn/TaskRefPicker.jsx` | The searchable, grouped scheduled-task picker |
| `client/src/components/quotaBurn/StepSettings.jsx` | Per-invocation overrides + the effective settings and audit mode |
