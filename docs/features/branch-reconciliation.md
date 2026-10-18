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
