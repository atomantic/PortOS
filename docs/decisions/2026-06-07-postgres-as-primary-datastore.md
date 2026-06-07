# ADR: PostgreSQL as the Primary Datastore (Multi-Model)

- **Date:** 2026-06-07
- **Status:** Accepted
- **Supersedes:** the implicit "JSON files in `./data/` are primary" assumption that
  held through early development.
- **Related:** [`docs/STORAGE.md`](../STORAGE.md) (storage-classification contract),
  [`docs/plans/2026-06-06-create-postgres-storage-inventory.md`](../plans/2026-06-06-create-postgres-storage-inventory.md)
  (inventory + phase roadmap),
  [`docs/plans/2026-06-07-create-relational-schema-design.md`](../plans/2026-06-07-create-relational-schema-design.md)
  (Create-domain schema design).

## Context

PortOS is single-user, self-hosted, runs on a private Tailscale network, and is
**distributed to many independent installs** — a single user commonly federates
several of their own machines as sync peers. Two needs pushed past what flat JSON
files can serve:

1. **Semantic search over embeddings.** Memory and the creative Catalog need
   vector similarity at query time. Loading every JSON record into memory to scan
   doesn't scale, and a separate vector database (Pinecone/Qdrant/Chroma) would be
   a second stateful dependency to provision, back up, and keep transactionally
   consistent with the source records on every self-hosted install.
2. **Rich connections between elements** across Universe, Series, Catalog, and the
   Create domains — connections we want to query and report on, not just store.

The monolithic single-file JSON stores were also already cracking under write
contention (`media-jobs.json`, `video-history.json`), and `collectionStore` —
the per-record-directory pattern — was itself the "we outgrew one big JSON" patch.

## Decision

Use **PostgreSQL as the primary datastore, as a *multi-model* engine** — not as a
classically normalized relational schema. Concretely:

- **JSONB document bodies.** Each app-native record (Universe, Series, Issue, etc.)
  is one row whose full payload lives in a `JSONB data` column. The existing
  sanitizers stay the single source of truth for record shape. Nested structures
  (seasons, stages, covers) stay in the JSONB — no decomposition into child tables.
- **Promoted columns** for the handful of fields the service queries/sorts/filters
  on (`name`, `status`, `schema_version`, `ephemeral`, `updated_at`, `deleted`,
  `deleted_at`) — mirrored from the record body on write, indexed for cheap scans.
- **pgvector** (768-dim, HNSW + `vector_cosine_ops`) co-located with the data for
  embedding search, fused with BM25 full-text (`tsvector`) via Reciprocal Rank
  Fusion. One engine, one backup unit, transactionally consistent with the records.
- **Connections via soft refs + catalog edge tables.** No hard foreign keys.
  Cross-domain links are `TEXT` refs resolved at the app layer
  (`catalog_ingredient_refs`); ingredient-to-ingredient edges live in
  `catalog_ingredient_relations`. Integrity is delivered by resolver queries and
  dangling-ref reports, not DB constraints — because in a federated install, a ref
  can legitimately arrive before its target, and targets can be soft-deleted.
- **Binary assets stay on the filesystem**, indexed in the DB
  (`asset-file-db-indexed`). The DB points to files; it does not absorb the bytes
  (per `STORAGE.md`).

## Alternatives Considered

- **Keep everything in JSON files (status quo).** Rejected: no indexed or vector
  search, no transactional multi-record writes, and monolithic-file write
  contention was already a problem. Files remain correct only for binary asset
  bytes, externally-synced bodies (iCloud/Git/hand-edited), and ephemeral state.
- **A NoSQL / document database (Mongo, Couch).** Rejected: it would preserve the
  JSONB-blob ergonomics we already get from Postgres, but **lose** pgvector, native
  full-text search, recursive-CTE graph traversal over the catalog edges, and
  transactional multi-table writes — while *still* adding an external stateful
  dependency that is no lighter to operate. The only NoSQL upside is horizontal
  write-scaling across nodes, which a single-user app will never need.

## Consequences

**Positive**

- One stateful service to run and back up; embeddings, documents, full-text, and
  the connection graph all live together and stay consistent.
- The Catalog becomes the **Create graph hub** (roadmap Phase 4): every cross-domain
  connection is expressed as one catalog relation/ref instead of FKs scattered
  across a dozen tables — one graph to query.
- Federation stays **storage-invisible**: the snapshot/push + last-writer-wins model
  is unchanged, the wire payload is identical whether the sender is file- or
  DB-backed, and no `PORTOS_SCHEMA_VERSIONS` bump is required for the storage swap.

**Costs / risks to manage** (tracked as GitHub issues)

- **Postgres is now a load-bearing install dependency** for normal installs and for
  every federated peer machine. The `MEMORY_BACKEND=file` path must be explicitly
  classified as supported-or-test-only and the setup/docker path must be bulletproof.
- **There is no versioned DB-migration runner yet** — schema evolves through
  idempotent `ensureSchema()` `CREATE IF NOT EXISTS` gates plus a parity test against
  `init-db.sql`. That covers additive changes only; column renames, type changes, and
  row transforms (including an embedding-dimensionality change away from the hardcoded
  `vector(768)`) need a real runner before the schema grows further.
- **The federation `mutationEpoch` patch is a seam.** Moving universes to the DB
  broke dataSync's directory-mtime fingerprint, patched with a module-level epoch
  counter. As each further domain migrates, this should collapse into a single
  change-token abstraction rather than N ad-hoc counters.

## Scale Note

Data **volume** is not the concern — tens of universes, hundreds of issues,
low-thousands of catalog rows, single-digit MB of JSONB. Postgres is idle at this
size for the lifetime of a single-user install. The scalability that matters here is
**capability** (search, connections, integrity reporting), which is exactly what this
decision buys and what flat files could not provide.
