# Branch reconciliation outcomes

In **Chief of Staff > Schedule**, expand the outcome beneath the
`branch-reconcile` task. Each app has its own persisted outcome, separate from
whether its coordinator agent completed successfully. The card updates on
schedule changes and reconnects.

A manual run continues through eligible batches even when perpetual scheduling
is disabled. No-progress and dispatch limits bound that sweep. A failed provider,
unreadable scan, ownership uncertainty, or remaining hold produces an incomplete
outcome rather than implying repository convergence. The inventory timestamp is
the last observation; an interruption can preserve an older inventory.

The remaining-work list includes branch holds and a post-cleanup inventory of
secondary checkouts. It shows checkout paths, HEADs, detached state, lock text,
and whether a checkout lies outside managed roots. Detached checkouts with
unmerged work are included, even though merged-checkout cleanup cannot retire
them. A failed or empty Git checkout listing is unknown evidence and prevents a
completed empty-scan outcome. Lock text is descriptive data, never authority.

Lock age, an absent process, and natural-language lock text never release a
checkout on their own. Long-lived protected branches and the primary checkout
remain governed by the existing reconciliation policy; an empty reported work
list is not permission to remove them.

## A parked sweep is not necessarily a clean repository

`no coordinator task eligible; unresolved holds retained` means the inventory
still contains work, but none can currently be dispatched. Inspect the per-app
outcome rather than treating the absence of a generated task as successful cleanup.
Every retained branch is also named with its reason in the run log. Open delivery
rows link their PR and retain observed conflicts, requested changes and failed
check names alongside any review-recovery hold, so an ownership hold cannot hide
the delivery failure. Serial retries with the same task, instance, budget epoch
and consecutive dispatch ordinals share one review owner; unrelated or overlapping
executions remain ambiguous. Historical policies and current task budgets still apply.

- `review-task-missing` means the completed owner's task record is unavailable.
  Restore trusted task history before resuming its configured review; PR text is
  not a replacement policy and a missing record does not replenish any budget.
- `not-merged-on-recheck` means the checkout's work is not merged: its PR did
  not merge at this exact head, its commits are not on the default branch, and no
  later merged PR head contains them. Finish wanted work through normal delivery;
  a merged PR at another head is not permission to discard local commits.
- `worktree-dirty` means merged work with uncommitted, untracked or nested
  content that only an exact-head merge makes disposable. Commit and deliver it,
  or clean it deliberately, then retry.
- `delivery-evidence-unavailable` means the forge or the checkout could not be
  read. The checkout stays until a fresh read answers.
- `retirement-receipt-unverified` is a legacy failure name still returned by
  cleanup producers when recording their result fails. Refresh inventory to
  inspect current paths/refs; no historical receipt is required to converge.
- Named merged branches retire through the same checks regardless of checkout
  location, from both the Git page and `branch-reconcile`. A clean external
  checkout needs no separate PR, merge timestamp, idle window, or managed-root
  registration. This is intentional for external tool-created branches too:
  directory age or an unregistered process is not a cleanup hold. External
  sessions that need to retain a clean checkout must use `git worktree lock`;
  the server still honors that lock. The server rechecks the actual holder and current integration
  evidence before removal. Locks, active owners, protected branches, completion
  policy and unsaved work still hold it. A dirty checkout is disposable only
  when the forge proves its PR merged at that exact head, as described below.
- `worktree-unmanaged-location` still applies to detached checkouts outside
  managed roots, and superseded branches that have not passed their idle window.
  This does not block cleanup of a named merged branch.
- `delivery-head-unverified` requires comparing the current local branch and
  published PR. Preserve local-only changes and establish the current owner
  before continuing delivery; do not reset the checkout to make the heads match.

## Cleanup-only recovery completion

A cleanup-only recovery succeeds when the recorded checkout path and local branch
are both absent. Finalization, interrupted-run recovery and queued retry settlement
use the same live observation, without reading the retirement receipt ledger or
requiring a parent checkout-generation receipt. An existing or unreadable path/ref
keeps the task unresolved. The task's managed-app target and explicit operator
review holds on the task or its parent still apply; a task that also repairs delivery retains its PR and commit
gates. This verifies local cleanup only, not remote-branch deletion or delivery.

The branch-reconcile completion pass checks its assigned cleanup targets the same
way. It records remaining local targets directly instead of manufacturing missing
receipt obligations. Ownership, locks, cleanliness and merged-PR checks still run
in the retirement service before anything is deleted.

Inventory reads prune absent local checkout/ref rows. If a checkout vanished but
its branch survives, the branch is listed independently with its current HEAD;
old checkout locks and physical-generation identities do not attach to that ref.
Unreadable paths/refs and remote-only holds remain visible. Reading inventory
never deletes a ref. Branch-only cleanup requires an exact inventory HEAD, a
current direct ref, no checkout holder or active owner, respected completion
policy and merged work, then an expected-head Git deletion under the ownership
fence. An already-absent ref is recorded as retired only when the forge proves
its PR delivered that exact head, so an unexplained disappearance stays visible.

Only the most recent 20 retirements are kept for display. Completion, release
synchronization and branch-only cleanup never depend on that history.

## Retiring a held checkout

A row with a checkout path and HEAD offers **Retire checkout**. The inline
confirmation is a scoped release of that exact row: its path, HEAD, branch and
lock text. The server refuses unless the row is in the app's last persisted
inventory and a fresh Git read still matches it — a changed lock, HEAD or branch
is an ownership change. It then requires merged work and no live owner, claim
binding or manual completion handoff.

A merged checkout is removed at its original path with its branch. Work counts as
merged when the forge reports its branch PR MERGED at the observed head, when
every commit is already on the default branch (ancestor or patch-equivalent), or
when a later merged PR head contains the observed head (an update or follow-up
pushed from elsewhere before the merge). **Merged at the exact head ⇒
disposable:** that checkout loses its uncommitted, untracked and git-ignored files
with it (build output, caches, dependency links, seeded data, scratch edits). They
are never the delivered work, which the merged PR already places on its target.
The other two forms of merge evidence cover commits only, so they retire a clean
checkout and keep a dirty one. The answer is bound to that exact SHA and
re-checked at the removal boundary, so a later local commit keeps the hold. Every
retirement path applies the same exact-head disposal predicate: the
branch-reconcile merged retirement, the merged-worktree reaper (including
external-repo checkouts), held-checkout, pending-merge receipt and legacy-release
retirement, and quality-snapshot checkouts. Containment in a later merged head is
recognized by the held-checkout service (operator, automatic and release-candidate
retirement). An unmerged, protected or live-owner checkout stays where it is; an
empty branch trivially "contains" main, so local ancestry alone never makes a
dirty checkout disposable.

Retirement does not copy the checkout, its ignored files, or its commit history.
A released lock is removed only after a second fresh match, and ownership, HEAD,
merge evidence and content are rechecked immediately before removal; if that
recheck refuses, the original lock is restored. A retired row leaves the inventory
and appears under *Recently retired*; only the next sweep can report convergence.
No retirement path writes a checkout archive. Setup migrations 442 and 454 remove
the historical `data/cos/held-checkout-archives/`,
`data/cos/branch-retirement-archives/`, and
`data/cos/initialized-checkout-retirements/` directories (a symlinked directory
is left alone), and nothing reads them. A missing original generation is never
recovered from an archive.

### Operator retirement

`POST /api/cos/schedule/branch-reconcile/checkouts/retire` is a single step.
The body is the exact inventory tuple the operator saw; a row held only for
`pr-completion-review-required` retires the same way once its work is merged,
since a merged review-then-merge obligation has nothing left to gate. There is
no review endpoint, PR URL, digest or supersession acceptance (#16016). Ownership,
content, merge and current path/ref rechecks run inside the retirement and keep
the checkout on any mismatch.

### Automatic retirement

Branch reconciliation retires a completion-review hold directly when its managed,
unlocked, ownerless checkout is merged by the rules above, through the same
service and behind the daemon gate (`daemon-stopped`,
`automatic-retirement-disabled`). It dispatches no agent to review or retire
checkouts. Unmerged work stays held and visible with its completion reason.
Superseded branches keep their own verdict-based reap, and older release
candidates have their candidate lock released once their release PR delivered
the head.

### Released ref without a checkout

Use the existing `POST /api/git/delete-branch` with the repository `path`, exact
`branch`, `local: true`, `remote: false`, and caller-observed `expectedHead`.
The Git service checks current owners and worktree holders, retains the exact
source under `refs/portos/completed/<head>`, and removes only that ref with
compare-and-swap. Refresh branch reconciliation afterward to observe the actual
remaining refs. This is an explicit source-retaining removal, not a claim that
its original commits were merged.

Earlier releases could preserve a superseded prototype's small checkout-only
files in the schedule record (`supersededSourceEvidence`). That mode is gone;
existing records are left untouched and no longer read.

## Completing a merged job

Normal merged-work cleanup belongs to the completing job. After durable signal
ingestion and exact checkout capture, the server stops that job's finished
writer, releases its execution binding, and awaits deterministic retirement and
receipt verification. An already merged exact head does not create a cognitive
review or cleanup job. A genuine delivery follow-up wakes its original parent
directly when it completes; duplicate observations coalesce, and a pre-release
audit cannot substitute its stale owner-active result for the post-release
check. Scheduled reconciliation is a crash/restart and legacy fallback.

Cognitive investigation is reserved for actual unexplained failures. Its contract
includes resolving the affected work within original authority and budgets,
repairing demonstrated root code defects with regression coverage and normal PR
delivery, and reusing active fixes. External permission and transient causes are
recorded accurately rather than turned into invented code defects.

## Later deliveries on a captured checkout

A later merged PR whose head contains the checkout's head settles a clean
checkout through the same rules, whatever earlier PR the run recorded: the
merged history holds every commit. Changed generations, active owners and human
handoffs remain held. Cleanup preserves an incomplete multi-claim batch's
result, captures and unfinished sibling checkouts; it does not reset or resume
exhausted retry budgets.

## Archive-era bookkeeping transition

Migration 443 remains unchanged and runnable through its frozen migration-only
helper. On schedule reads, the existing serialized writer removes the obsolete
receipt ledger and legacy reconciliation fields. It retains historical inventory
observations until current path/ref checks prune or update them. No runtime code
replays legacy receipt observations or needs historical evidence to converge.
Execution results and retry budgets remain unchanged; a fresh scan establishes
repository convergence.
