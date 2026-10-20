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

## Retiring a held checkout

A row with a checkout path and HEAD offers **Archive and retire checkout**. The
inline confirmation is a scoped release of that exact row: its path, HEAD,
branch and lock text. The server refuses unless the row is in the app's last
persisted inventory and a fresh Git read still matches it — a changed lock,
HEAD or branch is an ownership change. It then requires merge evidence on the
default branch and no live owner, claim binding or manual completion handoff.

Before any mutation, every unique byte is archived under
`data/cos/held-checkout-archives/`: a verified Git bundle of commits not on the
default branch, the staged and unstaged diffs, raw bytes of tracked files that a
clean filter or line-ending conversion hides from those diffs, verbatim copies
of untracked and ignored files (all hash-verified), and symlink targets. A nested repository or
submodule, unmerged or hidden index entries, an oversized file or a write during archiving fails the archive, which leaves the checkout, its lock and its
branch untouched and removes the partial archive. The lock is released only
after a second fresh match, and ownership, HEAD and content are rechecked
immediately before removal; if that recheck refuses, the original lock is
restored. A retired row leaves the inventory and appears under *Recently
retired* with its archive path; only the next sweep can report convergence.

## Explicit initialized-checkout preservation

Automatic cleanup continues to retain initialized submodules. The separate
`/api/cos/schedule/branch-reconcile/initialized-checkouts` capability supports
operator-reviewed private-module checkouts on macOS. Other platforms and unknown
Git layouts fail closed. It never deinitializes a module, force-removes a checkout,
or purges an archive.

1. `POST /review` accepts the exact inventory tuple (`appId`, `path`, `head`,
   `branch`, `locked`, `lockReason`) and `prUrl`. The response binds the merged PR,
   current default head, ownership, completion policy, parent/module content and
   Git administration to a review digest. A repair branch alias is accepted only
   when its exact tip equals the merged PR head. Superseded work needs an explicit
   `acceptSuperseded` decision after reviewing the full comparison.
2. `POST /retire` accepts that tuple plus `review: {prUrl, digest,
   acceptSuperseded}`. It establishes a durable repository reservation and native
   executor lock, repeats the review, archives the entire checkout and private
   administration plus the parent common object store, and proves a standalone
   restore before moving either original directory. Kernel no-replace renames
   quarantine originals without unlinking them. Each intent/result is fsynced.
3. The successful phase is **quarantined**, not fully retired. The branch remains
   with reason `quarantined-checkout-rollback-ref`. `POST /review-branch` accepts
   `appId`, `transactionId` and the fresh status `journalDigest`; it verifies the
   quarantined originals and archive, exact current branch, fresh merge/default
   head, ownership and full supersession comparison. `POST /retire-branch` accepts
   those identifiers plus the newly accepted `review`. It uses exact-head native
   deletion with holder protection and preserves the branch reflog archive,
   then records the original checkout retirement receipt. No UI merged flag
   authorizes either operation.
4. `GET /status?appId=…&transactionId=…` returns the journal phase, placements and
   current `journalDigest`. `POST /restore` requires those two identifiers plus
   that digest. It restores original inodes only to vacant original locations,
   with unchanged ownership, branch and required object proof. Unrelated shared
   refs may advance; shared config, dependency changes, missing indexed objects,
   a new holder or a changed/deleted branch hold in-place rollback.
5. `POST /verify-archive` accepts the same identifiers and journal digest. It
   independently verifies the archive and prebuilt standalone checkout, returning
   `standaloneCheckoutPath`. This recovery remains usable after the original
   branch is deleted or the live parent/module object stores are unavailable.
   Parent and module staged blobs and private recovery refs are explicitly
   checked; `git fsck` alone does not prove every staged blob exists.
6. If branch deletion was conclusively journaled as `branch-retired`, but writing
   its receipt failed, or `retired` was journaled before reservation release,
   repeat `POST /retire-branch` with the latest `journalDigest`. This verifies
   archive integrity, quarantined originals, ownership, no new holder and the
   still-absent ref; it only finishes the receipt and reservation release. It
   never deletes or recreates a ref on replay. A `branch-retirement-intent`
   without a recorded receiver result remains an explicit uncertainty hold,
   even when the ref is absent. Status reports that evidence; standalone recovery
   stays available, but no automatic retry clears the uncertain reservation.

The native backend preserves file bytes, permissions, ownership, timestamps,
ACLs, xattrs, supported flags, empty directories, hard links and symlink targets
without following symlink dependencies. It retains original identity evidence;
only the standalone copy's Git pointers are rewritten to its isolated stores.
An OS-added `com.apple.provenance` attribute on a copy is retained and recorded
with its exact hash; changed existing attributes, missing attributes and other
additions still refuse preservation. No provenance or quarantine attribute is
removed or rewritten. Original and quarantined metadata stay exact. Every later
archive verification or move is bound to the exact manifest hash journaled after
preservation. If that journal write is interrupted before any move, status
exposes an unverified-archive hold and a digest for source-verified cancellation;
it does not infer a preservation proof from the retained manifest.
Shared/external/nested module stores, alternates, promisor dependencies, active
Git operations, insufficient space and unsupported metadata hold the operation.
A full parent store copy and a second standalone restore require bounded free
space; there is no cache deletion fallback.

Managed checkout creation/adoption/removal, claim binding, the full workspace
preparation through agent registration/spawn, and supported Git API writers
share admission under the canonical common Git directory. Read-only merge proof
may add immutable commit objects; concurrent additions conservatively invalidate
an exact archive snapshot rather than authorize removing changed evidence. A pending
reservation survives restart. Normal writers release their permits only after
settlement; timeout, overflow or signal termination retain an uncertain permit
because direct-child exit cannot establish that every helper stopped. No PID,
age, timer or automatic retry clears this evidence. Reservation release atomically
moves the intact owner into a durable private release record, preserving evidence
across a crash without leaving an ownerless cut. Receipt replay keeps the original
archive identity and timestamp so a newer checkout obligation cannot be satisfied
by replaying an older retirement. An interrupted transaction
requires explicit status and recovery; ambiguous identities remain held. The
private journal and all copies remain available after success or recovery.
