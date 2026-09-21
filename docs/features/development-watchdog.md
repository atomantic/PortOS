# Development watchdog

The instance-local Persistent Mind maintainer role selects managed repositories.
The watchdog intersects that scope with the live `readPortos`, `createTasks`, and
managed-app grants. Enabling a role does not enable inference or widen grants.
GitHub repositories are supported; other forges report an explicit blocker.

The existing CoS health scheduler checks the configurable interval (hourly by
default), and evaluation and configuration changes reconcile the same service.
A cadence may fire late by one health-check interval. There is no additional
polling timer. Paused CoS, revoked grants, full capacity, unknown ownership and
exhausted autonomy budgets defer writes. The generic Improve switch does not
stop this separately opted-in role from scanning or handling pull-request
maintenance, but it must be enabled before the watchdog queues new issue-claim
batches. Agent execution retains normal provider budget and capacity gates.

The Schedule page's **Development Watchdog** Run Now invokes the programmatic
handler. `POST /api/cos/mind/maintainer/watchdog` with `{ "dryRun": true }` performs
a fresh nonmutating scan; omit `dryRun` for Run Now. The GET endpoint returns the
latest persisted receipt. Both route bodies and task handlers enter the same
serialized service. Maintenance cannot be used as a quota-spending job.

`runDevelopmentWatchdog({ dryRun, force, source })` returns a receipt.
`readDevelopmentWatchdogSnapshot()` only reads the last persisted receipt;
callers requiring fresh read-only context should use a forced dry run. Automatic
runs respect the interval and invalidate cached decisions when role/grants,
CoS pause or autonomy changes. Disabled roles create no runtime state.

Receipts contain `schemaVersion`, `checkedAt`, `complete`, `source`, `dryRun`,
`availableSlots`, `blockers`, scoped `apps`, `decisions`, `counts`, and bounded
`recovery` provenance. Each app includes issues and all open PR dispositions.
PR rows carry current head SHA, first observed time and an evidence fingerprint.
Counts distinguish queued work, owned skips and duplicate admissions prevented;
none claims to measure an agent that was actually duplicated. The service makes
zero model calls and performs no autonomous merge itself: eligible PRs queue the
existing review-then-merge workflow. Pending CI, drafts, ownership and unchanged
failed evidence need no resolution agent.

The latest receipt and 24 historical receipts use the existing machine-local
CoS runtime state, not a new record store. A bounded current-PR dispatch ledger
survives restarts and prevents repeated resolution of unchanged evidence. Queue
admission shares structured work identity across user/internal task files and
existing scheduler/manual follow-up producers. Untargeted claims reserve their
app's issue lane. Full-sync peers participate in ownership reads; unrelated
peers do not block the scan. Failed or capped participating-peer and forge reads
remain unknown. A claim branch alone is not an active agent: an open in-progress
claim without local task evidence remains an explicit unresolved owner.

Recovery metadata identifies source tasks/agents and blocked categories without
copying private transcripts. This watchdog neither spawns cleanup agents nor
runs destructive git cleanup. Existing deterministic completion cleanup retains
ownership of that work.
