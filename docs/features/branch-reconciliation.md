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

- `retirement-forge-unavailable` means PR evidence could not be read. Restore
  the managed app's forge access and rerun. A missing local commit on the forge
  is handled separately: reconciliation tries bounded merged-branch history,
  requires exactly one matching-repository candidate, and still performs the
  fresh checkout/policy/content review before any retirement. A branch-name
  match alone never establishes that local work was integrated.
- `retirement-pr-lookup-unavailable` and `retirement-review-unavailable`
  distinguish an unexpected lookup failure from a failed checkout preview.
- `retirement-receipt-unverified` means preservation is unproven. An exception
  after retirement starts retains this obligation, including the exact checkout
  identity; it is not downgraded to a failed preview or silently retried as one.
- `worktree-unmanaged-location` means the checkout sits outside PortOS's
  managed roots. A checkout that only looks merged because it was cut from the
  default branch stays there (#10270): another tool may still own it, and
  ancestry alone is not delivery. When the forge reports that branch's pull
  request MERGED at the exact observed head and names when that merge happened,
  reconciliation waits out the shipped hour from the later of that merge and
  the checkout's age, then retires the checkout and the local branch. A lock,
  a live owner, a missing merge time, or an unreadable forge still holds it.
  Do not add external checkouts to a trusted root to clear this.
- `delivery-head-unverified` requires comparing the current local branch and
  published PR. Preserve local-only changes and establish the current owner
  before continuing delivery; do not reset the checkout to make the heads match.

## Retiring a held checkout

A row with a checkout path and HEAD offers **Retire checkout**. The
inline confirmation is a scoped release of that exact row: its path, HEAD,
branch and lock text. The server refuses unless the row is in the app's last
persisted inventory and a fresh Git read still matches it — a changed lock,
HEAD or branch is an ownership change. It then requires merge evidence on the
default branch and no live owner, claim binding or manual completion handoff.

A merged checkout is removed at its original path. **Merged ⇒ disposable:** a
checkout whose branch PR the forge reports MERGED at the observed head loses its
uncommitted, untracked and git-ignored files with it (build output, caches,
dependency links, seeded data, scratch edits). They are never the delivered
work, which the merged PR already places on the default branch. The skip is bound
to that exact SHA and re-checked against the head observed at the removal
boundary, so a later local commit keeps the hold. Every retirement path applies
the same predicate: the branch-reconcile merged retirement, the merged-worktree
reaper (including external-repo checkouts), held-checkout and legacy-release
retirement, and quality-snapshot checkouts (merged PR). A dirty checkout with no
merged PR at its head, an unmerged, protected, or live-owner checkout stays
where it is; an empty branch trivially "contains" main, so local ancestry alone
never makes a dirty checkout disposable. Retirement does not
copy the checkout, its ignored files, or its commit history. The lock is
released only after a second fresh match, and ownership, HEAD and cleanliness
are rechecked immediately before removal; if that recheck refuses, the original
lock is restored. A retired row leaves the inventory and appears under
*Recently retired*; only the next sweep can report convergence. No retirement
path writes a checkout archive. Setup migrations 442 and 454 remove the
historical `data/cos/held-checkout-archives/`,
`data/cos/branch-retirement-archives/`, and
`data/cos/initialized-checkout-retirements/` directories (a symlinked directory
is left alone), and nothing reads them. A merged checkout is disposable; a
missing original generation is never recovered from an archive.

### Explicit delivery reviews

`POST /api/cos/schedule/branch-reconcile/checkouts/review` accepts the exact
inventory tuple and `prUrl`. A detached checkout may name its merged PR only
when its HEAD exactly equals the published PR head. The published branch's
saved completion policy and live owners still apply. Retirement preserves the
detached checkout and records checkout-only completion; it never deletes the
published branch.

Sometimes a completed local branch was delivered through a replacement PR
instead of its original tip. For that case, add `kind: "source-supersession"`
to the review request and name the replacement merged PR. The server verifies
the same repository and default branch, refuses an open delivery for the
original branch, and binds both original and replacement heads plus current
source differences. This does not claim that the original commits were merged.
Inspect the original unique patch and its current replacement before accepting;
wanted unfinished work still needs delivery. Unknown/active owners, failed or
manual-handoff completion policies, and changed evidence remain holds.

Confirm through `checkouts/retire` with the same inventory tuple and
`review: { prUrl, digest, kind: "source-supersession", acceptSuperseded: true }`.
Explicit acceptance is required even when the affected file bytes now match.
Ownership, content, and merge rechecks plus a persisted retirement receipt
remain prerequisites to removal. The checkout is not copied into an archive.
Initialized checkouts retain their separate workflow; this mode does not bypass
its gates.

### Preserved superseded prototypes

A closed prototype can be replaced by different code without its original
commits ever becoming ancestors of the replacement. Do not merge obsolete code
or claim it was merged just to make cleanup eligible. An operator may instead
request `kind: "preserved-supersession"` with the replacement merged PR, inspect
the exact source/replacement differences, and confirm the returned digest with
`acceptSuperseded: true` and that same kind.

Published sources require an exact same-repository source ref and one closed,
unmerged source PR at that head. A private source instead retains its exact
commit/tree objects under `refs/portos/retained-checkout-source/<head>`; it does
not need publication or a patch-size inspection limit. Separate private recovery
commits are retained too. Missing, advanced, reopened, ambiguous or foreign
source evidence refuses removal. An index with resolve-undo conflict stages
remains held. Existing owner,
completion-policy, inventory-generation and final content checks still apply.

Before removal, the service durably retains at most 64 KiB of checkout-only
non-cache files and Git administration evidence in the local schedule record.
Git source objects remain reachable through the exact retained refs rather than
being copied into that record. It also retains symlink
metadata. Only independently recognized module cache artifacts and a clean,
reconstructible index/checkout pointers are omitted. The aggregate encoded evidence store is bounded to 1 MiB. Stale, unconsumed
preparations are pruned; completed preservation evidence is never evicted just
to make room. Larger evidence or a full store remains
in its original checkout; this mode does not copy a repository or create an
archive directory. Preparation is replayable and does not settle an obligation
or claim deletion. A completed service removal records
`disposition: "superseded-preserved"`, bound to that preparation digest, instead
of claiming merged delivery. Ordinary merged cleanup does not use this mode.

### Released ref without a checkout

Use the existing `POST /api/git/delete-branch` with the repository `path`, exact
`branch`, `local: true`, `remote: false`, and caller-observed `expectedHead`.
Do not invent a checkout path for the checkout-review endpoint. The Git service
checks current owners and worktree holders, retains the exact source under
`refs/portos/completed/<head>`, and removes only that ref with compare-and-swap.
Refresh branch reconciliation afterward to observe the actual remaining refs.
This is an explicit source-retaining removal, not a claim that its original
commits were merged.

To recover the prototype, fetch the recorded source ref, verify the exact head,
and create a new checkout. Retained small files and symlink metadata are audit
and recovery evidence; old Git registration pointers/locks must never be copied
into a recreated checkout as if it were the previous incarnation. The published
source branch is retained; local retirement does not delete it remotely.

### Review work budgets

Review fingerprints apply byte budgets and can refuse with
`retirement-archive-limit-exceeded`. That refusal keeps the checkout; review
never writes an archive directory.

Patch capture preserves original Git output bytes, including non-UTF-8 content. Metadata names and symlink targets must round-trip losslessly through UTF-8; unsupported encodings refuse before removal.

File count is not admission policy; the byte and metadata budgets below bound
each snapshot, and independently recognized disposable test caches do not count
against them. Hashing uses 64 KiB chunks with at most two concurrent
snapshot file streams. Git snapshot queries keep a finite fan-out: seven content
queries plus the private Git directory lookup.

The limits are 25 MiB per raw file, 250 MiB combined content and private
administration, and the Git output buffer of `64 * 1024 * 1024` JavaScript code
units. Git output overflow and command timeout report measured usage and recovery
guidance. Metadata is charged incrementally against a 16 MiB ceiling, including
file entries, symlink targets and gitlinks; this also bounds zero-byte-file trees.
Transient sorted directory names have a separate 16 MiB scan budget, so directory
traversal cannot allocate unbounded name lists. A snapshot has a ten-minute
elapsed work budget, a conservative ceiling of twenty 30-second Git command
timeouts. Checks run between filesystem operations and 64 KiB chunks; a running
Git command retains its 30-second timeout. Kernel I/O may finish before
cancellation is observed. No global setting is written.

Internal callers may pass an `AbortSignal` as `opts.signal`. Cancellation or a
resource refusal keeps the original checkout, ref and outstanding obligations. A
new attempt starts from fresh snapshots rather than treating partial work as
evidence. Capacity responses include measured bytes, Git output code units, or
elapsed milliseconds. Recover by freeing resources or preserving large outputs
separately, then retrying the exact checkout with fresh evidence; do not remove it
or raise global limits to clear a refusal.

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

A later merged PR on the same captured checkout generation can satisfy an
earlier completed review obligation. Explicit retirement review must prove that
both PRs merged on this repository's default branch, the earlier PR head is an
ancestor of the captured completion head, and that capture is an ancestor of the
currently reviewed delivery. The captured pointer and private-administration
generation must match exactly. Missing evidence, changed generations, active
owners and human handoffs remain held. The original agent result and policy are
never rewritten; the new proof is bound into the retirement review and removal receipt.
Cleanup creates no checkout archive. Only that reviewed generation can finish branch retirement;
a recreated checkout path or new branch holder still refuses.

An incomplete multi-claim batch does not prevent cleanup of a separately
verified merged checkout. Its completed execution must have a valid capture of
that same generation, and the captured head must be included in the exact
merged delivery. Failed execution or validation, missing captures and unmerged
delivery remain held. Cleanup preserves the batch's incomplete result, every
capture and unfinished sibling checkout; it does not reset or resume exhausted
retry budgets.

## Archive-era bookkeeping transition

Migration 443 freezes existing retirement observations for reconciliation. A
supported inventory refresh settles those observations only when no checkout,
local branch, registered holder or active/human owner remains and a unique
service receipt or verified merged delivery explains the old work. Squash and
rebased deliveries use exact merged-head lineage or stable patch equivalence;
an old SHA need not itself be an ancestor of main. Changed or unreadable
evidence stays unresolved. New missing-checkout incidents are outside this
frozen upgrade scope.

The original observation and proof remain in `legacyRetirementTransition`
audit history. Delivery-only settlement explicitly does not claim a verified
deletion and creates no retirement receipt. Agent results, retry budgets and
current worktrees are unchanged. A new sweep still establishes convergence.
