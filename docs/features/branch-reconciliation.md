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

This is a recovery inventory, not an unlock or retirement control. Retained
checkouts remain protected. Before a future recovery action can retire one, it
must prove existing owner authority or an explicit scoped release, recheck the
exact checkout/HEAD, merge evidence and ownership immediately before mutation,
and verify a recoverable archive of all unique tracked, untracked and ignored
content. An archive failure must leave the checkout and branch intact. Lock age,
an absent process, and natural-language lock text do not prove release; live
owners and manual handoffs remain protected.

The remaining scope of #12002 is an enforceable scoped release and archived
retirement workflow with ownership-change and archive-failure integration tests.
The inventory does not grant that authority. Long-lived protected branches and
the primary checkout remain governed by the existing reconciliation policy;
an empty reported work list is not permission to remove them.
