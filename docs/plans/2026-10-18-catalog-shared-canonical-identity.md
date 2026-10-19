# Owner-coordinated catalog identity

## Scope

Consolidate two same-type catalog ingredients owned by two different paired
instances into one selected canonical identity on those two instances. The
survivor retains its existing owner and ID. The source retains its original ID,
owner, complete reviewed history and assets. This is not ownership transfer or
a presentation-only grouping. Other peers retain their ordinary original-ID
records until they support an independently authorized identity agreement.

No deployment, remote host access, record unlock, generation or live agreement
is implied by implementing this protocol.

## Reviewed protocol

The survivor owner coordinates a durable operation. A plan binds the operation
ID, protocol version, both record IDs and owners, reviewed authoritative
snapshots, explicit populated-field choices and proposed canonical content.
Portable snapshot fingerprints exclude transport sequence counters while
including content, lock state, owner revision identities, references, source
links, relations and media provenance. Oversized evidence is refused, never
silently truncated.

Each owner accepts the exact plan through its existing local operator authority.
Acceptance rechecks its authoritative state and atomically persists a reservation
that fences both ingredient and subordinate writes. Both content records must
already be explicitly unlocked. Peer credentials can read authenticated protocol
evidence; they cannot create operator acceptance.

The coordinator verifies the source owner's prepared receipt and commits its
canonical content and immutable decision in one database transaction. The source
owner adopts that verified decision and activates canonical resolution. No
cross-machine atomicity is claimed: a committed operation can await peer adoption.
Prepared participants remain reserved during outages; the source cannot cancel
unilaterally after preparation. A durable coordinator abort resolves an uncommitted
reservation. Retries reuse the same operation and are idempotent.

Peer responses bind a fresh challenge, operation, plan hash, protocol version,
requester and responder identities. Existing paired authentication is required;
legacy Basic fallback and self-asserted instance headers are insufficient.
Existing enabled catalog sharing and direction controls are enforced. Pair
changes invalidate an in-flight exchange. Bilateral evidence is not transitive
authority for a third peer.

## Identity and ongoing changes

Canonical read resolution is separate from write resolution. Original IDs keep
working in links, canon references, catalog queries, casting and media views.
Histories and attachment provenance retain their original identities. Ordinary
exports and catalog feeds retain original IDs and owners.

Only the canonical owner may modify canonical content after commitment. A source
instance must refuse an old-ID edit, upload or queued attachment that would write
to a foreign canonical projection. Generation is refused before spending work
when its attachment destination cannot be written. Database fences provide the
second check for delayed callbacks and direct subordinate mutations.

Generic last-write-wins catalog sync is not owner proof and cannot overwrite
protected identities. The participating source instance refreshes canonical
content through an explicit, directly owner-verified protocol operation. Retained
source canon cannot overwrite the survivor, and consolidation does not rewrite
foreign universe caches or embedded stable IDs.

## Recovery

Recovery is another bilateral decision over the exact applied state. Both owners
prepare recovery; the coordinator records the durable recovery decision before
the source adopts it. It restores only this operation's effects, keeps original
assets and audit receipts, and refuses to overwrite later content, attachments,
history or locks. Monotonic state prevents a delayed old commit from reactivating
a recovered alias. Interrupted operations remain inspectable and resumable.

## Validation

Persisted tests cover acceptance races, concurrent association inserts, both
relation endpoints, retries and restarts, offline/ambiguous peers, wrong-owner and
third-peer requests, authentication-disabled installations, locks, stale plans,
recovery after later changes, owner refresh, old-ID references, search/facets,
member-attributed history/media, canon projection and original-ID export.

Independent design review accepted this bounded protocol with the reservation,
owner-authentication, complete-fencing, explicit-refresh and guarded-recovery
requirements above. Implementation review and exact-head checks remain required.
