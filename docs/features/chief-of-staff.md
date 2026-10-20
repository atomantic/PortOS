# Chief of Staff

Autonomous agent manager that watches task files, spawns sub-agents, and maintains system health.

## Architecture

- **Task Parser** (`server/lib/taskParser.js`): Parses TASKS.md and COS-TASKS.md formats
- **CoS Service** (`server/services/cos.js`): State management, health monitoring, task evaluation
- **Task Watcher** (`server/services/taskWatcher.js`): File watching with chokidar
- **Sub-Agent Spawner** (`server/services/subAgentSpawner.js`): Claude CLI execution with MCP
- **CoS Routes** (`server/routes/cos.js`): REST API endpoints
- **CoS UI** (`client/src/pages/ChiefOfStaff.jsx`): Tasks, Agents, Health, Config tabs

## Features

1. **Dual Task Lists**: User tasks (TASKS.md) and system tasks (COS-TASKS.md)
2. **Autonomous Execution**: Auto-approved tasks run without user intervention
3. **Approval Workflow**: Tasks marked APPROVAL require user confirmation
4. **System Health Monitoring**: PM2 process checks, memory usage, error detection
5. **Sub-Agent Spawning**: Claude CLI with --dangerously-skip-permissions and MCP servers
6. **Self-Improvement**: Can analyze performance and suggest prompt/config improvements
7. **Script Generation**: Creates automation scripts for repetitive tasks
8. **Report Generation**: Daily summaries of completed work
9. **Durable Agent Feedback**: Completion notifications accept quick ratings, while the Agents tab keeps a filterable queue of loaded runs that still need feedback after a notification expires. Recent unrated completed runs are also surfaced as a CoS insight that links directly to the URL-backed review filter. Feedback details can be attached to helpful, unhelpful, or neutral ratings so learning has actionable context. The Learning tab aggregates ratings from both live state and date-bucketed agent archives, de-duplicating runs that are still present in both stores so historical feedback remains visible for the archive retention window.
10. **Learning-Aligned ETAs**: Pending tasks and active agents resolve their estimates from the same metadata-first task-learning bucket that records outcomes, including archived scheduled-agent metadata, instead of inferring a potentially different category from task text.

## Repository merge admission

Every CoS run that lands its own pull request, plus the deterministic
pending-merge sweep, shares one repository-scoped merge-instant lease
(`server/services/cosMergeAdmission.js`). The host-control-gated
`POST /api/cos/merge-admission` accepts the registered parent agent ID and
`acquire`, `check`, or `release`; check/release require the returned token, and
release records one of `merged`, `leave-open` or `resync` in the parent's
`lastMergeAdmission`. Repository identity comes from that parent's registered
source checkout and normalized origin host/repository, not its child worktree
path, and never from the request.

Acquire and check admit only a live (`running`) registered agent that is one of
these participants; anything else is refused with `claim-owner-unverified`:

- **Claim parent** — its registered claim binding (`claimBranch` or
  `claimPicksOwnBranch`; see [Claim branch ownership](#claim-branch-ownership)).
- **Review-loop coordinator** — an internal review/merge follow-up whose
  registered `reviewLoopMergeTarget` still matches its live task's PR URL,
  number and branch, and whose worktree is on that branch of this repository.
- **Generic PR delivery** (#11435) — an operator-configured task whose prompt
  told it to open and merge its own PR from the worktree PortOS provisioned
  (`/do:pr` plus the CI merge gate, or the inline `git`/forge lifecycle). The
  spawner stamps `prDeliveryTarget` — that worktree path and head branch — from
  the same decision that put the admission section in the prompt. Admission
  then requires the agent record to still name that worktree and branch with
  agent-owned PR delivery, the live task to still be unfinished with `openPR`
  on and a completion policy that merges (not leave-open, a JIRA handoff, a
  review follow-up or a fork head), and the worktree's origin and checked-out
  branch to match. The PR target is the one whose head is that registered
  branch in this repository. A generic run never gains claim authority, and its
  `/do:pr` runs with `--no-merge` so no saved slashdo default merges outside
  the lease.

Release needs only the owned token, so a lease cannot strand after the merge
deletes or switches the checkout.

The lease spans only the final verify-and-merge (#10803). Base sync, pregate,
push and the required-CI wait run concurrently across participating runs and
across every PR in a swarm, without admission. Once required CI is green on the
exact pushed head, the parent acquires, re-reads the PR, and:

- merges pinned to that CI-verified head (`gh pr merge --match-head-commit`,
  GitLab `glab mr merge --sha`) when the forge reports it mergeable (`CLEAN`),
  then releases with `merged`;
- releases with `resync` when the head changed or the PR is no longer mergeable
  (`DIRTY`, `BEHIND` under an up-to-date-branch rule, `BLOCKED`), then syncs,
  reruns pregate and waits for CI again outside the lease before re-acquiring.

A base that moved while the PR stays `CLEAN` does not force a resync or a fresh
CI run: the forge's merge check is authoritative, as it is for manual merges.
The remaining exposure is a semantic conflict between two individually green
PRs, which post-merge default-branch CI catches — the same exposure manual and
cross-install merges already carry. A refused acquire retries every 5 seconds
and reports progress every minute; after 10 minutes the reviewed PR (and any
claim) is left open — a refusal is never permission to merge without admission. Sweep deferrals preserve their retry budget; the sweep already
holds the lease only around its own read → assess → pinned merge.

### Post-merge gate audit (#12549)

Admission and "merge on green" are prompt rules; an agent with `gh` access can
still merge around them. When a claim run finishes, `mergeGateAudit.js` (hung
off the post-cleanup audit in `agentWorktreeCleanup.js`) lists the PRs merged
from the run's bound claim branches and flags each one that either held no
admission lease at `mergedAt` (within the 5-minute hold) or had a check run or
commit status on the merged head that was not completed-green before it (runs
created after the merge are ignored). The lease evidence is `mergeAdmissionHistory` on the
run (each release records its `acquiredAt`/`releasedAt`) plus a lease it still
holds. A head the pending-merge coordinator merged itself is never flagged: the
coordinator marks the run's `mergeHandoffReceipts` entry (`coordinatorMergedAt`)
when its own merge call succeeds, so a run that handed a head off and then merged
around the queue is still caught. An audit whose forge reads fail is kept as an
`audit` entry in `mergeGateWatches` and retried by the sweep.

A violation is written to the run (`mergeGateViolations`), the run-events ledger
(`run.merge-gate-violation`) and a notification. If the flagged head's checks
fail, ONE recovery task for the default branch is queued; its description names
the merged SHA, so concurrent runs and repeat audits deduplicate on the task
queue. Heads whose checks were still running are watched on the app
(`mergeGateWatches`) and resolved by a bounded fast poll and the 30-minute
pending-merge sweep. Detection only: nothing merges, reverts or changes branch
protection.

### Completion recovery and merged cleanup

Successful worktree and claim-swarm runs persist a pending completion audit
before publishing completion. The existing 30-minute merge sweep resumes up to
ten oldest pending audits from live and archived agent records. Every recorded
claim branch has its own recovery backlink; interruption after task creation can
repair the exact existing backlink rather than minting another merge authority.
Missing tasks, unreadable state, active owners and explicit leave-open policy
never grant recovery permission. GitHub auto-merge enabled alone is unfinished.

The Git page's merged badge is a display hint. Delete merged branches and
completion cleanup use the same retirement path: resolve the current checkout,
re-read ownership and policy, verify the exact commit's merge evidence, archive
and verify ignored content and private Git evidence, then compare-and-delete
the unchanged local ref. Remote deletion uses an exact-head lease after a fresh
remote read. Recovery refs retain original commit objects even for a squash
merge without a checkout. Cleanup reports locked, dirty, active, unmanaged,
unverified manual claim, changed-head and archive-failure holds explicitly.
An absent live registry entry alone cannot waive a manual claim hold; a
completed recorded owner is required. Initialized submodules currently retain
the checkout because their complete content is not supported by the archive.
A held merged receipt names a recovery task when policy and source ownership
permit it; intentional human handoffs stay with their existing owner.

### Pending-merge handoff (#12247)

Runs default to owning delivery through CI, confirmed merge and safe cleanup.
Early finish is opt-in through the managed-app API setting
`mergeHandoffMinQueuedRuns` (positive integer; absent or null disables it).
Operators choose this threshold from their CI runner capacity; PortOS does not
invent a waiting-time or queue-size default. The server reads GitHub Actions'
current queued workflow-run count and requires that count to meet the configured
threshold, plus queued work on this exact PR head, no failed/unknown checks,
mergeability and satisfied reviews. Unknown backlog, an unavailable/paused
coordinator or failed persistence keeps responsibility with the original run.
This signal measures queued runs, not estimated completion time; repositories
using other CI providers keep in-session ownership until a supported signal exists.

An eligible participant may hand the CI wait to the server:
`POST /api/cos/merge-handoff` (host-control gated) takes the registered agent
ID, the PR URL, the full head SHA and — for a claim run, which cuts its own
checkout — the worktree path. The server binds everything else itself: the
repository from the run's registration, the PR branch it must own (a bound
claim branch, `reviewLoopMergeTarget` or `prDeliveryTarget`), a same-repository
open non-draft PR whose live head equals the SHA, a checkout of this repository
on that branch at that SHA, a merging completion policy (not leave-open, a JIRA
handoff or read-only), and the worktree's `portos-review-status`:
`REVIEW_STATUS=clean` with `REVIEW_HEAD=<sha>` naming that same head for a
review-then-merge run; merge-on-green accepts no file or a clean one. Fork
targets are refused. The binding is persisted on the app's `pendingMergePrs`
entry, an unbound duplicate queue write never replaces it, and the response
carries a receipt.

The pr-watcher pending-merge sweep then merges only the recorded head, under
its own admission lease, once the PR is `CLEAN` with every reported check
green; GitHub auto-merge is never enabled. A head that moved invalidates the
binding and dispatches recovery with the recorded review roster; a failed
check or conflict does the same. Once a review task exists, recovery resumes
that same task, retaining its lifetime spawn budget and target instead of
creating nested `[Review Loop]` descendants. A live owner keeps its receipt
until it releases the branch. Unreadable ownership defers; a changed target,
manual hold or exhausted retry budget remains blocked even if CI later turns
green. A new verified handoff is needed to replace that binding. An unreadable binding never merges and is
retained with an explicit blocked reason and an operator notification. A
verified receipt that exceeds its polling budget or cannot read the forge
remains durable and is retried by the scheduled sweep; notification never
discards custody. A closed, unmerged PR is retained for explicit disposition,
even when its old checks failed. Failure recovery waits for an active source
task to finish before transferring ownership to a persisted recovery task.

Immediately before merging under admission, the coordinator re-reads its owning
task. A new manual hold or changed completion policy blocks the old receipt;
an unreadable owner or queued recovery defers without consuming a worker slot.

The merge-admission prompt section describes this optional handoff before the
normal in-session CI wait. When a local review round returns clean, the run records
`REVIEW_HEAD=$(git rev-parse HEAD)` beside `REVIEW_STATUS` (one line, replacing
any earlier one); a later commit means that head was not reviewed. On
`queued: true` with a receipt for its head, the run stops: it does not wait for
CI, merge, enable auto-merge, close the issue or remove its branch or worktree,
and it reports the PR as handed off and not yet merged. Any other answer keeps
the run on the in-session CI wait and admission-gated merge.

A receipt is a pending end state. `probePrForBranch` reports
`mergeHandoffQueued` only when the queue holds a binding for that PR, branch and
the published local head, so the merge-gate check finalizes without a nudge
(`merge-handoff-queued`), worktree cleanup keeps the branch, and the repo-state
audit treats the queued entry as the branch's owner. The receipt starts one
immediate, daemon-gated sweep of the app, which merges a head whose CI settled after acceptance
without waiting for the 30-minute timer and spends no tick budget. Overlapping
sweeps of one app (timer, task generator, receipt) join a single pass; a receipt
that lands during a pass which already read the queue gets one follow-up pass
after it settles.

When that immediate pass leaves the receipt's entry queued (CI still running,
admission deferred, the forge briefly unreadable), the receipt arms a bounded
follow-up poll for the app so a head whose CI turns green a minute later does
not wait out the rest of the 30-minute timer. It re-runs the receipt sweep
every 60 seconds for the first five polls, then every 120 seconds
(`HANDOFF_FOLLOW_UP_*` in `server/services/prWatcher.js`), and stops once
every receipt it tracks has merged, escalated, reached its polling cap or
left the queue. An app has at most one poller: a receipt that lands while one
is active joins it with its own 45-minute cap, after which the 30-minute timer
sweep owns the entry exactly as before. Polls spend no tick budget, so
`MAX_PENDING_MERGE_TICKS` still measures wall-clock hours on the timer. Each
poll passes the timer's own gate — daemon running, not paused, CoS auto-run set
to `execute` — and is skipped otherwise; stopping the daemon cancels every
poller, and a receipt accepted while the daemon is stopped arms none.

New managed-app PR tasks default to **PortOS auto-merge after review**. The app's
PR completion setting can select automatic merge after checks, leave-open or
draft instead; an explicit per-run choice wins. This does not enable GitHub's
native auto-merge, which cannot acquire PortOS's local merge admission. Existing
explicit app and task policies remain unchanged.

New receipts also retain the verified checkout path. After a confirmed merge,
and after releasing merge admission, the coordinator archives unique contents
and Git metadata before retiring that exact checkout and local branch. A
cleanup refusal remains on the receipt as `cleanup.status`, `reason` and any
`archiveDir`; transient failures retry every 30 minutes, at most 12 times.
Locks, initialized submodules, changed checkout identity and supersession need
explicit recovery and remain held. No worker waits for this cleanup, no lock is
silently released, and no initialized submodule is discarded. Older receipts
without a checkout binding retain the existing branch-reconciliation fallback.

Leases extend the existing machine-local CoS runtime ownership in
`data/cos/state.json`, under its existing write queue; there is no new store,
seed, migration, or federation payload. Admission waits at most 15 seconds to
start its state-queue callback; an expired waiter returns `admitted: false`,
`reason: state-queue-timeout`, and `retryAfterMs: 5000`. Its fenced callback
cannot later grant or release a lease. A refused check grants no merge authority;
retry and require a fresh successful check. Once a transaction starts, it retains
the queue until its actual result settles, including persistence failures.
The deadline then logs the pending phase rather than reporting an incomplete
write as a refusal or successful release. Diagnostics contain fixed operation
and phase names plus numeric timings for queue wait, trusted-state read, cached
state load, origin lookup, owner recovery, and persistence; no owner, token,
repository, or path is logged. Missing lease fields are compatible
with older state. Unreadable, mismatched or stale ownership refuses admission.
An agent lease is recoverable from a matching finalized parent record
(including its archive), or by any participant once its 5-minute hold deadline
(`AGENT_LEASE_MAX_HOLD_MS`, measured from `acquiredAt`) has passed even while
its owner is still running. An expired holder's `check` is refused with
`lease-expired`, and because every merge is pinned to the CI-verified head, a
reclaimed holder cannot land an unverified head — the worst case is one
redundant resync. The lease is not a forge-side fence: a holder whose merge
request was already in flight when its deadline passed can still complete it
while the next holder merges. Both merges are pinned and forge-checked, so this
is the same semantic-conflict exposure as two consecutive `CLEAN` merges. Completed children and absent cwd processes never release a
lease early. A crashed deterministic sweep is recoverable only after its server
process is proven absent. Failed reads and ambiguous/reused process identities
hold admission conservatively.

This coordinates participating runs on **one install**. Manual merges, older
prompts and other installs can still move the base; the forge's merge state
reflects that at the merge instant. Admission does not grant permission to
adopt another owner's branch or checkout, does not replace reviews/CI, and
does not make queued auto-merge a completed merge.

## Claim branch ownership

A claim run cuts its own `claim/…` checkout, so its registered workspace stays
the source repository and no worktree basename names it. Ownership is the
registry's branch/repository binding (`server/lib/claimContinuation.js`):
a pinned run registers its target branch and is treated as possibly owning
every claim checkout in its repository until it binds the branch it actually
works on (a tracking epic ships a child, an oversized issue ships a slice); a
picker or swarm parent is a possible owner until it binds its first branch.
The claim prompt binds each branch through the host-control-gated
`POST /api/cos/claim-ownership` (`action: "bind"`, registered agent ID, branch)
BEFORE creating that worktree, and `release` hands a branch off mid-run. The
run's completion releases everything; quiet diffs, cwd, or a missing basename
never do. Bindings live on the run record in `data/cos/state.json` — no new
store or migration; records without them keep their previous behavior.

branch-reconcile applies the same owners twice: its scan holds a branch with a
live, possible or unreadable claim owner (never dispatched as `ABANDONED_WIP`,
never retired by cleanup), and each dispatched branch carries a `check` command
the worker runs right before its first mutation, because a run can take the
branch after the scan. A refusal, an unreadable registry, or a moved checkout
leaves the branch untouched; a completed or released owner admits recovery.

### Ownership response investigation (#11348)

The 2026-10-13 reconciliation observation `{"admitted":true}}` could not be
reproduced at the generated-command/HTTP boundary. The original capture had
neither HTTP status nor headers, so it does not identify whether the extra
byte came from the server, transport, or the tool that displayed the output.
No production producer fix is claimed.

`server/routes/cosAgentRoutes.ownershipResponse.test.js` runs the actual
generated recheck command through a shell and curl against a loopback Express
server with the real ownership service. All agents, repository paths, state
and authorization are synthetic; it never reserves an existing install's
branch. Status and headers are captured with the exact body bytes. Successful
admission returns HTTP 200, JSON content type, Content-Length 17, and body hex
`7b2261646d6974746564223a747275657d` (`{"admitted":true}`). Strict parsing of
the complete body succeeds, and a subsequent competing claim bind is refused.
Live-owner, unreadable-registry and unknown-coordinator refusals each return
one complete JSON document with their service reason and leave state unchanged.
The synthetic authentication gate's HTTP 401 remains a separate error envelope.

If this recurs, capture the **first** authorized recheck using curl's
`--dump-header <private-header-file>`, `--output <private-body-file>` and
`--write-out '%{http_code}'` options, retaining its exit code separately.
Use a private scratch directory outside the repository; do not enable verbose
request logging or store the bearer token. Parse the whole body file without
trimming or extracting a JSON substring. Compare its byte count and hex with
the tool-displayed output before attributing the fault; headers and bodies
remain private until redacted. A failed HTTP request, refusal, or malformed
body leaves the branch untouched. A second request cannot retroactively
authorize an unreadable first result.

## Task File Format

```markdown
# Tasks
## Pending
- [ ] #task-001 | HIGH | Task description
  - Context: Additional context
  - App: app-name

## In Progress
- [~] #task-002 | MEDIUM | Another task
  - Agent: agent-id
  - Started: 2024-01-15T10:30:00Z

## Completed
- [x] #task-003 | LOW | Done task
  - Completed: 2024-01-14T15:45:00Z
```

## System Task Format

```markdown
- [ ] #sys-001 | HIGH | AUTO | Auto-approved task
- [ ] #sys-002 | MEDIUM | APPROVAL | Needs user approval
```

## Data Storage

```
./data/cos/
├── state.json           # Daemon state and config
├── agents/{agentId}/    # Agent prompts and outputs
├── reports/{date}.json  # Daily reports
└── scripts/             # Generated automation scripts
```

## Model Selection Rules

`selectModelForTask` runs a task on exactly what it was configured with:

1. **An explicit model or tier** — the task's `metadata.model` (or an orchestration role's `model`). A tier (`light`/`medium`/`heavy`/`ultra`) resolves on the provider that actually runs the task, including a fallback provider.
2. **Otherwise the provider's Default Model.**

Nothing picks a tier automatically — not the description, priority, context size, or learning history (#8149). The Learning tab reports each task type's per-tier success rate and any tier its history suggests; pin that tier on the task or schedule to act on it. See [MODEL_TIERS.md](../MODEL_TIERS.md).

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| healthCheckIntervalMs | 900000 | Health check interval (15 minutes) |
| maxConcurrentAgents | 3 | Max parallel agents (global) |
| maxConcurrentAgentsPerProject | 2 | Max parallel agents per project |
| maxProcessMemoryMb | 2048 | Memory alert threshold |
| maxTotalProcesses | 50 | Process-count alert threshold |
| alwaysOn | false | Start on server boot (`autoStart` is a legacy compatibility alias). Off by default so a never-configured install does not begin autonomous LLM-backed work on its own |
| improvementEnabled | true | Allow improvement work for PortOS and managed apps |
| idleReviewEnabled | true | Review managed apps while user work is idle |
| autonomousJobsEnabled | true | Enable the global scheduled-agent-job runner |
| domainAutonomy | execute per domain | Off, dry-run, or execute policy for each automatic-work domain |
| domainBudgets | unlimited | Optional daily action and runtime caps per domain |
| persistentMindProfile.enabled | false | Configure a persistent-mind profile without starting it |
| persistentMindThinkingPresets.presets | [] | Saved named alternates (exact provider/model/effort) one message may borrow for a single turn. Empty by default; storing one changes nothing about the route the mind wakes on |
| avatarStyle | svg | Default CoS UI avatar style (`svg`, `ascii`, `core`, the 3D styles, or a `rigged-<modelId>` record) |

### Temporary thinking sessions in the Mind UI

Saved alternates are managed in **Mind → Models** (`/cos/mind?panel=models`). Adding, editing, previewing, or removing a preset writes only `persistentMindThinkingPresets` through `PUT /api/cos/config` — it never starts a turn, never resumes a paused mind, never infers, and never downloads a model. Sending the list replaces the whole array (PUT merges top-level keys only), because a merge cannot express "remove this one entry" and would resurrect a deleted preset.

The composer's **Send with another model** picker arms one preset for the **next single message**, and nothing else:

- The armed preset lives in the URL (`?preset=<id>`), so it is shareable and reload-safe. Previewing shows the exact provider/model/effort plus whether the route is machine-local, account-backed, or unclassifiable — an unclassifiable route is treated as billable.
- **Pressing send is the authorization.** It covers that one message, including its bounded tool rounds and its summary. The selection clears on acceptance, so the next message and every scheduled wake use the unchanged home profile.
- The route is frozen with the draft: a duplicate click or a transport retry re-submits the same id **and** the same route, because the server's retry fingerprint covers both. Changing the armed preset mints a new id instead.
- A preset that disappears is refused, never substituted — the composer blocks the send rather than answering on the default profile the user was stepping away from.
- Attached images are validated against the borrowed route, not the default one, so a text-only alternate refuses the message instead of dropping the image.
- A paused mind stays paused: the message queues on the selected route and runs only when the user resumes it.

**Mind → Thinking route** (the sidebar card) shows the default profile beside the route the current turn is *actually* taking, warns when a preset was edited after its message was accepted, and offers **Return to default**. **Cancel this session** goes through the existing pause lifecycle, which retires a temporary session rather than requeueing it — a cancelled temporary turn never replays itself.

**Mind → Models** also lists the per-session receipts (`?turn=<turnId>`): preset, actual route, elapsed time, run and turn ids, outcome, and usage/cost. Telemetry a provider never reported renders as *unknown*, never as zero — "free" and "not measured" are different claims.

Temporary thinking messages retain the exact accepted provider, model, and effort. Changing or revoking a preset refuses the pending session; a label-only rename preserves its route. Revoked selections and interruptions after inference may have begun require a fresh message to run again. Temporary provider outages before inference leave the accepted message queued. Matching transport retries keep the original selection even after revocation. Older queued temporary messages without a recorded route retain their content but require explicit resubmission.

### The decision journal

Rollups are sealed prose and memories are flat facts that decay on one clock, so neither can say *that decision is retired now*: a reversed decision sat beside its replacement, and the more-accessed stale one could outrank the correction. The journal is the third shape — typed, individually addressable, and status-bearing.

- **Kinds.** `decision`, `commitment`, `open_question`, `risk`, `goal`, `preference`. Each entry is a concise standalone statement in the mind's own words, never a transcript quote.
- **Three operations.** `append`, `supersede` (this statement replaces entry E) and `resolve` (E is settled). Supersession is the operation the memory store cannot express: the old entry stays readable with `status: superseded` and a pointer to what replaced it, and stops being quoted as current. Nothing is ever deleted.
- **Source-grounded and bounded.** Every operation cites the message sequences it came from; one citing nothing — or citing a range the extraction was never shown — is discarded while its well-grounded siblings still apply. At most five operations per extraction, and **zero is the normal outcome**: greetings, acknowledgements, tool chatter and raw reasoning produce none.
- **Where it runs.** At the same boundary that seals a rollup, on the same pinned provider and the same per-call boundary as the summary it feeds — no new provider path and no cold-bootstrap call. A malformed answer gets one narrow repair attempt and then gives up **without writing**; a failed extraction never blocks the seal.
- **What the rollup becomes.** The sealed summary compacts from the journal rather than from raw turns, so active decisions, outstanding commitments, unresolved questions and risks survive as facts, the settled history that explains the current state is kept, and superseded wording is absent by construction.
- **Untrusted evidence.** Prior entries replayed into the extraction prompt are data, not instructions: every stored statement is quoted so an injected heading or directive cannot forge a prompt section, and the prompt says so in words.
- **Correcting it.** **Mind → Journal** groups active entries by kind, collapses retired ones behind a toggle showing what replaced each, and lets the user settle or retire an entry the mind got wrong. The `history` cleanup scope clears the journal along with the messages it cites; a context-only clear does not.

Storage, retention and the privacy posture are in [STORAGE.md](../STORAGE.md).

## API Endpoints

| Route | Description |
|-------|-------------|
| GET /api/cos | Get CoS status |
| POST /api/cos/start | Start daemon |
| POST /api/cos/stop | Stop daemon |
| GET/PUT /api/cos/config | Configuration |
| GET /api/cos/tasks | Get tasks (bounded: all non-completed + first 25 completed with `completedCount`; `?view=queue`, `?view=completed`, `?view=full` for the raw store) |
| POST /api/cos/evaluate | Force evaluation |
| GET /api/cos/health | Health status |
| POST /api/cos/health/check | Run health check |
| GET /api/cos/agents | List agents |
| POST /api/cos/agents/:id/terminate | Terminate agent |
| GET /api/cos/feedback/stats | Aggregate live and archived agent ratings |
| GET /api/cos/reports | List reports |
| GET /api/cos/learning | Get learning insights |
| GET /api/cos/digest | Get weekly digest |
| GET /api/cos/mind/journal | Persistent Mind decision journal, filterable by `kind` and `status` |
| POST /api/cos/mind/journal/:id/correct | Settle (`resolve`) or retire (`retire`) one journal entry the mind got wrong — a status transition, never a delete |

## Prompt Templates

| Template | Purpose |
|----------|---------|
| cos-evaluate | Evaluate tasks and decide actions |
| cos-report-summary | Generate daily summary |
| cos-self-improvement | Analyze and suggest improvements |

## Related Features

- [Memory System](./memory-system.md)
- Task Learning — see `server/services/taskLearning/` and the `/api/cos/learning` endpoints
- [Self-Improvement](./cos-enhancement.md)
- [Error Handling](./error-handling.md)
- Scheduled Scripts — see the Schedule system (`server/services/taskSchedule.js`, `/api/cos/jobs`)
