# ADR: Tribe Relationship Graph + Universe Render-Runs Stay Machine-Local

- **Date:** 2026-06-26
- **Status:** Accepted
- **Related:** issue #1724 (folded from the #1561 full-sync gap matrix),
  [`server/services/tribe.js`](../../server/services/tribe.js),
  [`server/services/universeBuilder/db.js`](../../server/services/universeBuilder/db.js),
  [`server/services/memorySync.js`](../../server/services/memorySync.js),
  [`docs/STORAGE.md`](../STORAGE.md).

## Context

Epic #1561 ("full-sync federated node pairs") audited every data domain for
whether it mirrors across a federated peer pair. Two `db-primary` PostgreSQL
domains were left undecided and folded into #1724 for a sync-vs-local call:

1. **Tribe / relationship graph** — `tribe_people`, `tribe_touchpoints`,
   `tribe_memory_links`. Not in `PEER_SUBSCRIBABLE_KINDS`
   (`server/services/sharing/peerSync.js`) and not a `dataSync` snapshot
   category. Local-only today.
2. **Universe render-runs** — `universe_runs` (one row per render, capped at
   200 globally). Read through Postgres by `dataSync` when it loads universes,
   but the run rows themselves are never included in any snapshot or push.

The acceptance criterion is a documented decision for each, with anything that
stays local recorded in the #1561 gap matrix as intentionally-excluded.

## Decision

**Both stay machine-local. Neither is federated.**

### Tribe graph — local, by precedent

PortOS already federates memory *nodes* (`memories`, via the `sync_sequence`
pull-cursor in `server/services/memorySync.js`) but **deliberately keeps the
relationship graph between them instance-local**. memorySync.js states it
plainly:

> memory_links (relationships) are not synced — only the memories table is
> replicated. Relationship data is instance-local.

The Tribe graph is the same shape — a personal relationship/CRM graph — and is
structurally coupled to two domains PortOS holds machine-local on purpose:

- **`tribe_memory_links`** is a relationship layer over `memories`, directly
  analogous to the `memory_links` table that is already, by design, not
  federated. Syncing tribe's memory cross-links while the brain's own
  `memory_links` stay local would be internally inconsistent.
- **`tribe_touchpoints`** carry `calendar_account_id` / `calendar_event_id`
  pointing at a per-machine connected-calendar OAuth integration. Those refs do
  not resolve on a peer that has a different (or no) calendar connection, so a
  touchpoint synced verbatim would carry dangling, machine-specific provenance.

Federating people + touchpoints while silently dropping the memory links and
calendar refs would produce a lossy, incoherent partial mirror; federating them
faithfully would first require federating the calendar-account integration
layer, which is inherently machine-local. Keeping the whole Tribe graph local
is consistent with the established "relationship data is instance-local"
boundary.

### Universe render-runs — local, regenerable cache

`universe_runs` is a **regenerable render-output cache**, not durable source
data. The durable source — the universe record itself — already federates via
the `dataSync` snapshot/push model, so a peer reconstructs its own run history
by rendering. Two properties make federation actively wrong rather than merely
unnecessary:

- The cap is **200 rows globally** (newest-across-all-universes, trimmed inside
  `appendRun`), not per-universe. Two peers each generating runs would
  continuously evict each other's rows to honor one shared cap — churn with no
  durable value.
- Runs are append-only outputs of a deterministic-enough render step; there is
  nothing in a run a peer cannot reproduce locally on demand.

This matches the existing classification in `docs/STORAGE.md`, which already
describes `universe_runs` as "local-only, capped 200, never federated."

## Consequences

- No new `PEER_SUBSCRIBABLE_KINDS` entries, no `dataSync` categories, and no new
  `PORTOS_SCHEMA_VERSIONS` keys — so none of the schema-version coverage guards
  (peerSync `RECORD_KIND_SCHEMA_CATEGORIES`, dataSync, `schemaVersions`) are
  touched.
- The decision is pinned by a guard test
  (`server/services/sharing/localDomains.test.js`) asserting `tribe_*` and
  `universe_runs` are absent from the sync graph. Federating either later is a
  conscious act: update that test and this ADR alongside the wiring.
- If the brain `memory_links` relationship graph and the calendar-account layer
  are ever federated, revisit Tribe — at that point the coupling argument no
  longer holds and people + touchpoints could mirror cleanly.

## Alternatives considered

- **Federate the Tribe graph now (mirror the authors/artists record-kind
  pattern).** Rejected: it crosses the deliberate "relationship data is
  instance-local" boundary, and the memory-link + calendar-ref coupling makes a
  faithful mirror impossible without first federating two other machine-local
  layers.
- **Federate `universe_runs` as append/LWW with the 200-cap honored on the
  receiver.** Rejected: a global cap shared by two independent producers
  guarantees mutual eviction churn, and the data is regenerable, so the mirror
  buys nothing the universe-record sync doesn't already provide.
