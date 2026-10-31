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
- `worktree-unmanaged-location` requires a scoped release of the inventoried
  checkout using the action below. Do not add all external checkouts to a trusted
  root merely because their commits are merged: another tool may still own them.
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
*Recently retired*; only the next sweep can report convergence. Older copies
under `data/cos/held-checkout-archives/`,
`data/cos/branch-retirement-archives/`, and
`data/cos/initialized-checkout-retirements/` are not written anymore. Setup
migration 442 preserves those directories: they may contain the only unpublished
files or originals held by unfinished recovery transactions. Existing restore
and verification workflows remain available after setup.

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

### Held archive work budgets

Review fingerprints still apply these byte budgets and can refuse with
`retirement-archive-limit-exceeded`. That refusal keeps the checkout and does
not write an archive directory. Historical archives that already exist are
checked with the same budgets.

Patch capture preserves original Git output bytes, including non-UTF-8 content. Metadata names and symlink targets must round-trip losslessly through UTF-8; unsupported encodings refuse preservation before removal.

Held archives use resource contract `1`, recorded as `resourceContract` in the
manifest. File count is not admission policy: every ignored/untracked content
file and worktree-private Git file remains included. Hashing and copying use
64 KiB chunks, with one copy at a time and at most two concurrent snapshot
file streams. Git snapshot queries keep their existing finite fan-out: seven
content queries plus the private Git directory lookup. A source growing during a copy aborts rather than expanding disk use.

The existing limits remain 25 MiB per raw file, 250 MiB combined content and
private administration, 16 MiB serialized manifest, and the existing Git output
buffer of `64 * 1024 * 1024` JavaScript code units. Git output overflow and command timeout retain measured usage and recovery guidance, without changing either existing limit. Patch verification bounds its
raw byte representation at three bytes per decoded code unit (192 MiB), preserving older multibyte
patch admission. Metadata is charged incrementally against the same 16 MiB ceiling,
including file entries, symlink targets and gitlinks; this also bounds
zero-byte-file trees. Transient sorted directory names have a separate 16 MiB
scan budget, so directory traversal cannot allocate unbounded name lists. These
byte ceilings retain the prior safety envelope instead of estimating work from a count. A snapshot, archive write (both source
passes included), or independent verification has a ten-minute elapsed work
budget. This is a conservative ceiling of twenty existing 30-second Git command
timeouts; it allows ordinary many-small-file archives while bounding repeated
filesystem work. Checks run between filesystem operations and 64 KiB chunks;
a running Git command retains its existing 30-second timeout. Kernel I/O may
finish before cancellation is observed. No new global setting is written.

Internal callers may pass an `AbortSignal` as `opts.signal`. Cancellation or a
resource refusal keeps the original checkout, ref and outstanding obligations;
partial archives and temporary bundle refs are cleaned up. A new attempt starts
from fresh snapshots rather than treating partial work as preservation evidence.
After a process crash, an archive without a complete manifest cannot prove
preservation; an existing completed archive still needs the full independent
hash and isolated Git object proof. No historical receipt is synthesized.

Capacity responses include measured bytes, Git output code units, or elapsed
milliseconds. Recover by
freeing resources or preserving large outputs separately, then retrying the exact
checkout with fresh evidence; do not remove it or raise global limits to clear a
refusal. Existing unversioned archives follow an explicit compatibility path
through the same bounded verification and complete content/private-Git proof.
Unknown contract versions fail closed. The real-Git benchmark at `d200ec77d2`
measured 16.9–20.9 seconds for cancellation/cleanup/retry and 20.2 seconds for
the 1,100-plus-file restore. Integration fixture construction, retirement or
confirmation, and independent proof retain separate existing 30-second phase
budgets; cumulative case duration includes its hooks. Existing tests retain their
default timeout. This does not change initialized-checkout archives or their
separate operational budgets.

Historical held-checkout archives must also prove that their staged patch
reconstructs the preserved private index. Verification imports the bundle into
a fresh, isolated Git repository, starts from the recorded HEAD, applies
`index.diff` to a new index, and compares every path, mode, stage and object ID
with the archived index. Split-index support uses only validated archived index
files; archived Git configuration, pointers and object stores are never execution
targets. Matching patch hashes alone cannot establish this proof: an older writer
could have hashed bytes already damaged during decoding.

A missing, unsupported or mismatched index retains the historical preservation
obligation with `archive-index-reconstruction-failed`. Locate a complete archive
for that exact checkout generation or recover the original data from backup, then
retry reconciliation. Failure never fabricates a retirement receipt or authorizes
deletion of a checkout, branch or archive.

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
