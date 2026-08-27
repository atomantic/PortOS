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
4. Runs the **first enabled, unspent job in that family's ordered plan that
   reports pending work** — at most one dispatch per cycle.
5. Charges the window in `data/cos/quota-burn-dispatches.json` and appends the
   outcome (including skips, with reasons) to `data/cos/quota-burn-runs.json`.

Everything fails closed: an unknown reset time, an unsupported provider, a
quota-read error, a card that declares itself unburnable (`burnable: false`, e.g.
the Image Gen card), or a family with no enabled jobs all mean "do not dispatch".

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
- **Bypassable by a forced run** (the ▶ on a job row), which is how a user
  retries a block they believe is stale.

## Burn jobs

A family's plan is an **ordered list** — that ordering is the configuration ("do
the missing bible images first, then fall through to agent work"). Each job has
its own type, optional model/provider pin, and type-specific params.

| Job type | What it does |
| --- | --- |
| `agent-prompt` | Queues a CoS agent in a named managed app with a custom prompt. Visible in the CoS queue and Active Agents like any other task. |
| `universe-bible-describe` | **Programmatic** — no agent. Sends one headless expand prompt per under-described bible entry, pinned to the burning family's own CLI/TUI provider. |
| `universe-bible-images` | **Programmatic** — no agent. Enqueues renders for universe bible entries whose `imageRefs[]` is empty. Render backend defaults to the burning family's own image mode, so a codex burn spends codex's image quota. |

### Describe before you render

`universe-bible-describe` is the step that belongs **before** `universe-bible-images`
in a plan. An image rendered from a character row holding only a name is a
generic figure that has to be thrown away — and it has already spent the image
quota. Ordering the two describe→images in the family's rotation walks the
backlog into shape first, then renders from something worth rendering.

The job's `depth` param picks what "described" means, per
`server/lib/universeBibleCompleteness.js`:

- **`core`** — the entry is unusable without these: a character's
  `physicalDescription` / `personality` / `background` / `motivations` /
  `visualNotes`; a place's or object's `description`.
- **`full`** (default) — the whole sheet. For a character that is every field the
  character-sheet expand prompt fills: the visual set (silhouette, posture,
  palette, props, expressions, hand gestures, wardrobes), the novelist set
  (likes, mannerisms, relationships, skills), and the Ghost → Wound → Lie → Want
  → Need framework with its arc type and sliders. `full` is the default because
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
(`server/services/quotaBurnJobs/universeBibleDescribe.js`).

The image job's opt-in `requireDescribed` is the other half of the pairing: with
it on, canon entries with no `core` description are held out of the render
backlog until the describe job has been through them. It defaults **off**, so an
existing plan keeps rendering exactly the backlog it rendered yesterday.

### Repeating vs one-shot work (`runOnce`)

A plan is a **rotation**: the walk resumes after the family's last dispatch
(`rotatePlanAfter`), so an N-job plan cycles through all N and then starts the
next lap, spending the window until a gate closes. That is right for standing
work — an audit dimension is worth re-running as the code moves — and wrong for
work that only needs doing once, which was simply re-done every lap.

Each job therefore carries a **`runOnce`** flag (default `false`, so every plan
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
  `jobsPerFamily.max`, so pruning can only evict a job already deleted from the
  plan, never a live one. It is a
  separate file rather than a flag on the job because a config PUT **replaces**
  a family's `jobs` array — that is how every reorder and edit saves — so a flag
  on the job would be reset by an unrelated edit, and by the client's optimistic
  copy of the plan, which never sees the runner's write. The run log can't answer
  it either: it is a capped UI feed, so a job that ran last month has aged out.
- **Recorded only on a real dispatch.** A job that declines (`dispatched: false`)
  is not spent — a misconfigured step must stay retryable.
- **A forced ▶ run bypasses the gate AND still records.** `charge: false` is about
  the *window's automatic budget*; `runOnce` is a statement about the *work*, and
  the work just happened however it was triggered.
- **An unreadable ledger fails CLOSED** — `getQuotaBurnCompletions` returns
  `null` (not `{}`) for a failed read, so the cycle reports `run-once ledger
  unreadable` rather than treating "nothing has run" as fact and re-dispatching
  every one-shot job. `writeLedger` refuses to write over an unread ledger for
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
- **Re-arm** puts steps back in the rotation: the ↺ on a job row for one step,
  **Re-arm all** on the plan header for the family. `POST /api/quota-burn/rearm`
  with `{ familyId, jobId? }`; a `familyId` is required, since a bare "clear
  everything" would silently re-queue every one-shot job on the install. It
  dispatches nothing — the next cycle still faces every gate.

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
`params.prompt`, and nothing on disk points back at the preset id. So a contract
revision reaches configured jobs only through a migration — and the shape of
that migration matters. Every rendered prompt is two halves split by the
`## How to run this audit` line: the **mission** above it (what to audit, one
per preset, essentially stable) and the **contract** below it (how to audit,
shared, and the half that keeps being revised). `upgradeStoredAuditPrompt`
matches on the mission and replaces the contract, so a job seeded several
revisions ago still upgrades; it refuses when the stored contract has lost the
sentences every shipped render carried, which is how a user's own procedure is
recognized and left alone. Copy migration 305 for the next contract edit —
**not** migration 294, whose byte-for-byte rule matched nothing older than one
revision and silently stranded every real job on a prompt that predated the
dispatch-label guidance entirely.

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

Six files under `data/cos/`, all machine-local and intentionally **not federated**: the plan (`quota-burn.json`), the per-window dispatch ledger (`quota-burn-dispatches.json`), the run log (`quota-burn-runs.json`), the in-flight set (`quota-burn-inflight.json` — entries a job enqueued whose renders have not landed yet, so the next cycle does not re-queue them; 6-hour TTL), the denial ledger (`quota-burn-denials.json` — per-family blocks from an observed provider refusal, cleared by the next successful burn or a 5-hour TTL), and the `run once` completion ledger (`quota-burn-completions.json` — which one-shot steps have had their dispatch, cleared by Re-arm). They are not federated: quota belongs to a
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
| `server/lib/universeBibleCompleteness.js` | What "described" means per kind + depth — the field vocabulary the describe job scans with |
| `server/lib/quotaBurnPresets.js` | Ready-made single-focus audit prompts for `agent-prompt` jobs |
| `server/lib/quotaWindows.js` | Classifies a window by period — target (broadest) vs limiting (narrowest) |
| `server/services/quotaBurnStore.js` | `data/cos/quota-burn.json` + the run log |
| `server/services/quotaBurn.js` | `evaluateFamily` — the one gate ladder both selection and the page's skip reasons read — plus the dispatch ledger |
| `server/services/quotaBurnCompletions.js` | The `run once` completion ledger and its re-arm |
| `server/services/quotaBurnDenials.js` | The observed-refusal ledger and its `agent:completed` subscriber |
| `server/services/quotaBurnJobs/` | The job registry and its modules |
| `server/services/quotaBurnRunner.js` | The loop, the cycle, and the status feed |
| `server/routes/quotaBurn.js` | `/api/quota-burn` |
| `client/src/pages/QuotaBurn.jsx` | The config page |
