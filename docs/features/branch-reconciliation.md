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

### Held archive work budgets

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
Unknown contract versions fail closed. The real-Git regression measured
16.9–20.9 seconds for cancellation/cleanup/retry and 20.2 seconds for the
1,100-plus-file restore; those integration cases have explicit 30-second test
budgets. Existing tests retain their default timeout. This does not change
initialized-checkout archives or their separate operational budgets.

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
OS-added `com.apple.provenance` on a copy is retained with its exact hash. When
the OS replaces an existing provenance value, version 3 also preserves the exact
original bytes in the bound manifest as canonical base64 and checks their hash
against the captured source. Archive and restore copies record separate values
when the OS replaces it twice. These retained original bytes are recovery
evidence; the backend never installs them onto the copy. Missing attributes,
changes to any other attribute, and unrecorded additions still refuse preservation.
No provenance or quarantine attribute is removed or rewritten by this backend.
Normal retirement and rollback require exact original and quarantined metadata. Every later
archive verification or move is bound to the exact manifest hash journaled after
preservation. If that journal write is interrupted before any move, status
exposes an unverified-archive hold and a digest for source-verified cancellation;
it does not infer a preservation proof from the retained manifest.
Shared/external/nested module stores, alternates, promisor dependencies, active
Git operations, insufficient space and unsupported metadata hold the operation.
A full parent store copy and a second standalone restore require bounded free
space; there is no cache deletion fallback.

### Reviewed recovery after a move changes metadata

On Darwin, an exclusive directory rename can remove residual
`com.apple.decmpfs` attributes even when `UF_COMPRESSED` was unset. The normal
transaction refuses further moves when this changes its captured original
manifest. A source content change is never treated as that metadata transition.

While the interrupted transaction still owns its exact repository reservation:

1. `POST /review-metadata-restore` accepts `appId`, `transactionId` and the current
   `journalDigest`. It holds the native executor lock and existing reservation,
   checks current ownership and the unchanged branch, verifies the standalone
   archive, and creates immutable private evidence for the full observed delta.
2. Independently inspect that evidence before accepting the returned review
   digest. Only removed residual compression attributes on regular files whose
   compressed flag was unset, and a provenance addition on an original root
   directory, are eligible. Original raw compression bytes must still match the
   captured hashes in the verified archive. All content, inode identities,
   timestamps, permissions, ownership, ACLs, flags, other attributes and paths
   remain exact. Nothing rewrites the original manifest or installs attributes.
3. `POST /restore-metadata` takes the same identifiers and `review: {digest}`.
   It repeats the review under both locks, journals the accepted evidence, and
   restores original inodes with exclusive renames. Post-move observations are
   retained. A changed review, unknown metadata transition, new holder, changed
   branch or uncertain reservation refuses further work.
4. Success is `restored-with-metadata-transitions`, with archives and the
   metadata evidence retained. The exact reservation is released only after
   final proof. This restores a checkout; it never deletes or recreates a ref,
   proves a PR merged, or authorizes another retirement. Obtain a fresh
   retirement review after restoration.

If the installed server predates this recovery capability, run the supported
`scripts/recover-initialized-checkout.js` from an independently reviewed checkout
of this version. It uses the same service, native lock and existing reservation;
it does not patch the running server or clear a reservation manually:

```sh
node scripts/recover-initialized-checkout.js review /absolute/request.json \
  --install-root /absolute/PortOS --output /absolute/new-review.jsonl
node scripts/recover-initialized-checkout.js restore /absolute/approved-request.json \
  --install-root /absolute/PortOS --output /absolute/new-restore.jsonl
```

The request file contains only the API fields above. Each output must be new;
it records a durable pending intent before execution and then a response. A
pending-only record means inspect the transaction before any retry. The CLI
requires an existing self-install registry and trusted owner state, and refuses
an absent or uncertain reservation. It never initializes a different data tree.
Journal rows are fully written and synced to private staging files before
exclusive hardlink publication to their numbered names. Staging files remain
as evidence, including partial writes; recovery reads only committed numbered
rows. Existing malformed numbered rows are never silently ignored or replaced.
After an interrupted recovery, read status again and obtain a new review for
the new journal digest rather than replaying an old approval.

### Finalizing originals that have already been restored

Metadata can change after the post-move proof succeeds. In an observed case,
directory modification times changed and some residual compression attributes
returned with exactly their archived original bytes. The writer was not
established. The restore's final verification correctly retained its reservation.

When both original directories are already back at their exact original inode
identities, a separate completion path can record this narrow delta without
moving or repairing anything:

1. `POST /review-restored-finalization` accepts the transaction identifiers and
   fresh journal digest. It binds the previous accepted restore review and its
   immutable post-move observations, verifies the archive, and captures a new
   immutable full source snapshot under the existing reservation and executor.
2. Independently review the new digest and complete evidence. Only directory
   modification-time changes and reappearance of original residual
   `com.apple.decmpfs` bytes are eligible. Reappeared attributes must match both
   their prior raw preimages and the verified archive; the file must remain
   uncompressed. Administration, file contents and modification times, paths,
   identities, permissions, ownership, ACLs, flags, and all other attributes
   remain exact. Unknown drift stays held.
3. `POST /finalize-restored` accepts that separately reviewed digest. It repeats
   the review, verifies the exact snapshot again, and rechecks the branch,
   ownership, policy and reservation before recording completion and releasing
   the exact reservation. It performs no directory moves, metadata writes,
   branch changes or cleanup. Original manifests, raw values, observations,
   archives and journal evidence remain retained.

The bootstrap CLI exposes the same separate operations:

```sh
node scripts/recover-initialized-checkout.js review-finalization /absolute/request.json \
  --install-root /absolute/PortOS --output /absolute/new-finalization-review.jsonl
node scripts/recover-initialized-checkout.js finalize /absolute/approved-request.json \
  --install-root /absolute/PortOS --output /absolute/new-finalization.jsonl
```

These operations do not relax normal retirement or restore-move checks, and
finalization does not authorize branch deletion. Any subsequent retirement
requires a fresh review and preservation proof for the current checkout.
A move-based restore retry refuses when both originals are already restored and
its working-move proof is present, preserving that evidence for this separate
finalization path instead of replacing it with no-op observations.

### Automatic continuation of initialized retirement journals

CoS discovers existing private initialized-retirement journals at startup evaluation
and every 30 minutes, independently of branch-reconcile scheduling or free agent
slots. It acts only while the daemon is running, unpaused, and CoS autonomy is
`execute`. Discovery never starts a retirement or grants authority from a journal
phase alone. The bounded drain handles at most two transactions per pass, rotates
past held work, and refreshes evidence on subsequent passes. It creates no agent,
worktree, or additional persistent queue.

Automatic continuation requires a valid original transaction, a bound preservation
manifest, the original exact reservation, and fresh service/native proofs. The
local tip must equal the merged PR head; the complete scoped comparison must be
`integrated` with no differences. The native classifier permits only the archived
residual-compression removal and root-provenance addition described below. Every
other source field must still match the preserved baseline. A successful review
is passed to the same purpose-specific operation with its exact digest; the
operation recomputes the proof before moving anything. After its internal scan,
the native helper waits for an exact, fresh server acknowledgement before rename;
pause, a lost executor, invalid replies, and parent exit grant nothing. The branch
receiver guard runs after preservation and fsyncs deletion intent before invoking
Git. Before lengthy branch verification, `branch-retirement-prepared` durably
binds the new exact reservation without granting deletion. Restart obtains a fresh
branch review under that same cut. The daemon never accepts
supersession. Branch retirement requires its own subsequent fresh review.

A plain `quarantined` journal whose reservation release was interrupted can finish
through this same proof without moving either original again. Durably confirmed
branch deletion can replay its receipt without another Git deletion; it still
requires archive, placement, absent-ref, ownership, and reservation checks. A
completed receipt or completed restore with an already released reservation needs
no further action and consumes no replay slot. A missing owner file inside an
existing cut is uncertainty, not a released reservation.

Unknown metadata, changed sources, superseded work, active owners, manual policy
holds, unsupported pre-move/restoration phases, and uncertain deletion results
remain held for explicit review. CoS does not restore originals automatically,
transfer a cut, infer ownership from age/PIDs, or turn ref absence into a deletion
receipt. Existing schedule status exposes `reconcileOutcomes[appId].initializedRetirements`
with each transaction, branch, observed journal digest, phase, and reason. These
observations are diagnostics, never cached approval. Invalid unbound journals are
reported in the global reconcile outcome. The journals and archives remain the
recovery evidence after restart. A crash between cut creation and publication of
its preparation record remains an explicit reservation-mismatch hold; the daemon
never adopts an unrecorded owner. A pause or interruption after deletion intent
was fsynced remains uncertain even when no receiver result was observed.

The narrow machine-verified continuation above does not require another runtime
agent or human approval. The explicit operations below remain available for
independent inspection, supersession decisions, and unsupported recovery cases.

### Completing an interrupted quarantine

When the working directory has already moved into quarantine, restoring it
solely to retry retirement can trigger further metadata changes. A separate
reviewed operation can instead finish quarantining its administration while
preserving the working directory at its existing quarantine location.

1. `POST /review-quarantine-resumption` accepts `appId`, `transactionId` and
   the current `journalDigest`. Under the native executor and exact existing
   reservation, it verifies the archive, full current sources, original inode
   placements, current ownership and branch, and fresh forge/integration
   evidence for the PR recorded in the original transaction.
2. Independently inspect the returned `resume-initialized-quarantine` review.
   Its distinct native proof preserves full current manifests and raw metadata
   deltas. Only removal of residual compression attributes from uncompressed
   regular files and addition of provenance on an original root directory are
   eligible. Every other source field, including directory timestamps, stays
   exact. Restore and already-restored finalization approvals cannot authorize
   this operation.
3. `POST /resume-quarantine` takes the same identifiers and
   `review: {digest, acceptSuperseded?}`. Explicit supersession acceptance is
   required when the fresh comparison calls for it. The service recomputes the
   review and moves only administration, if it is still original, using an
   exclusive rename. A separately recorded post-move observation and full
   verification must prove both original inodes are quarantined before the
   exact reservation is released. Unexpected drift retains all evidence and
   requires a new review. If the rename completed but publication of its
   post-move observation was interrupted, a fresh review may prove both
   original inodes already quarantined; it neither repeats the rename nor
   fabricates a missing historical observation.
4. Quarantine completion retains the branch. The existing branch-review and
   branch-retirement operations require a second fresh approval, now also
   bound to the recorded quarantine metadata proof. They verify the complete
   quarantined originals, archive and object closure, current branch tip,
   ownership, holders and forge state before exact-head branch retirement.
   Receipt recovery after a durably confirmed deletion verifies the preserved
   sources again and requires the ref to remain absent.

The bootstrap CLI provides `review-quarantine` and `resume-quarantine` with
the same request fields, explicit `--install-root`, and a new private `--output`
record for each invocation. It cannot accept a caller-supplied native proof or
reuse a restore/finalization approval as quarantine authorization.

Neither resumption nor receipt recovery deletes original directories or
rewrites their metadata. A lost branch-deletion result remains an uncertainty
hold; an absent ref alone does not establish that the intended deletion
completed. An occupied or malformed loose-ref path, unsafe ref parent, or
unreadable packed refs cannot establish absence for receipt recovery. Archive
copies, original quarantines, raw preimages, post-move observations, journal
staging and released reservation evidence remain retained.

Managed checkout creation/adoption/removal, claim binding, the full workspace
preparation through agent registration/spawn, and supported Git API writers
share admission under the canonical common Git directory. Synthetic read-only
merge proofs use a private temporary object store. Concurrent Git writes conservatively invalidate
an exact archive snapshot rather than authorize removing changed evidence. A pending
reservation survives restart. Normal writers release their permits only after
settlement; timeout, overflow or signal termination retain an uncertain permit
because direct-child exit cannot establish that every helper stopped. No PID,
age, timer or automatic retry clears this evidence. Reservation release atomically
moves the intact owner into a durable private release record, preserving evidence
across a crash without leaving an ownerless cut. Receipt replay keeps the original
archive identity and timestamp so a newer checkout obligation cannot be satisfied
by replaying an older retirement. Interrupted transactions outside the machine-verified continuation above
require explicit status and recovery; ambiguous identities remain held. The
private journal and all copies remain available after success or recovery.
