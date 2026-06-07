# Storage Classification Contract

PortOS stores data in two places: **PostgreSQL** (app-native relational records, search/vector indexes, sync cursors, lineage) and the **filesystem** under `./data/` (large binary assets, externally-editable prose, model weights, transient queues, and explicitly file-sync-oriented domains).

PostgreSQL is a **required** install/runtime dependency (see [Backup & Restore](./BACKUP.md) and `scripts/setup-db.js`). Files remain first-class for the things a relational DB is bad at. This document is the contract for deciding **which home a given domain belongs in** — and the checklist a reviewer should apply before any new feature defaults to "just write another `data/*.json`."

> For the full domain-by-domain inventory (every current table and `data/` store, with Postgres-fit notes), see the plan doc: [`docs/plans/2026-06-06-create-postgres-storage-inventory.md`](./plans/2026-06-06-create-postgres-storage-inventory.md). This page covers the **contract and decision rules**, not the exhaustive list.

## The Four Storage Classes

| Class | Bytes live | Searchable metadata | Use when | PortOS examples |
|---|---|---|---|---|
| `db-primary` | PostgreSQL | PostgreSQL | App-native relational records: relationships, indexes, status, lineage, sync cursors, tombstones | `catalog_ingredients`, `catalog_ingredient_relations`, `memories`; **target:** universes, series, issues, Creative Director, media metadata |
| `file-primary` | Filesystem | Filesystem (DB may index) | The record IS an external file, or it must survive in a file-sync workflow (iCloud, Git, hand-editing) | Writers Room draft `.md` bodies, MortalLoom / Health / Meatspace iCloud stores |
| `asset-file-db-indexed` | Filesystem | PostgreSQL | Large binary payloads whose **metadata** must be queryable/searchable | Generated images/videos/audio + DB asset rows referencing them via `asset_key` / `media_key` |
| `ephemeral-file` | Filesystem | None (or DB job ref only) | Transient/regenerable runtime state — queues, uploads, caches | `data/uploads/*`, runtime media job queue, browser profile/cache |

**The one rule that ties them together: the DB points to files; it does not absorb the bytes.** Any file asset referenced from the DB gets a stable `asset_key` / `media_key` row plus integrity metadata. Bytes never go into a column.

---

## `db-primary` — app-native relational records

**Definition.** Records that PortOS itself authors and relates: they have foreign keys, statuses, audit trails, search/vector indexes, and federated sync cursors/tombstones. The DB is the source of truth; there is no meaningful file representation of the record.

**When to use.** The record participates in relationships (`series.universeId`, `issue.seriesId`, catalog refs), needs cross-record queries ("everything related to this universe"), needs full-text or vector search, or needs per-table sequence cursors for peer sync.

**Where it lives.** PostgreSQL via `server/lib/db.js` + `server/scripts/init-db.sql`. Service modules own the storage adapter (e.g. `server/services/catalogDB.js`, `server/services/memoryDB.js`).

**Examples.**
- `catalog_ingredients` — typed creative records with JSONB payload, tags, embeddings, generated `search_tsv`, soft delete, sync sequence.
- `catalog_ingredient_relations` — directed ingredient→ingredient graph edges (the strongest argument for Postgres as the catalog graph store).
- `memories` / `memory_links` — long-term memory + pgvector similarity.
- `creative_director_projects` — Creative Director project/treatment/scene/run state, one row per project (`id`/`status`/timestamps as columns, the full record in `data` JSONB). Migrated from the monolithic `data/creative-director-projects.json` in Phase 3 (#997); CD is local-only, so the row carries no sync cursor/tombstone. Adapter: `server/services/creativeDirector/projectsDB.js`.
- `catalog_user_types` — user-defined ingredient types (the registry that defines catalog row semantics), one row per type (`id` PK, the definition in `data` JSONB, `updated_at`/`deleted_at` mirroring the federation LWW clock + tombstone). Migrated from the `data/settings.json` `catalogUserTypes` slice in Phase 4 lead-in (#1001) so type evolution versions/syncs alongside the catalog data it governs. Federates via the catalog sync `catalogTypes` envelope block (wire shape unchanged by the move). Adapter: `server/services/catalogUserTypes/db.js`, dispatched via `store.js`.
- `universes` / `universe_runs` — Universe Builder records (canon bibles, categories, composite sheets, locks, influences) one row per universe with the full sanitized record in `data` JSONB and `name`/`schema_version`/`ephemeral`/`updated_at`/`deleted`/`deleted_at` mirrored into columns; render-run history one row per run (local-only, capped 200, never federated). Migrated from `data/universes/{id}/index.json` (collectionStore) in Phase 3 Create slice 1 (#1014). **NO `sync_sequence`** — universes federate via the EXISTING `dataSync` snapshot/push model (LWW on the body's `updatedAt`), so the storage swap is invisible to peers (no schema-version bump). The store bumps an in-process mutation epoch on every write that `dataSync` folds into its checksum fingerprint, since a DB edit no longer changes the `data/universes/` directory the fingerprint used to watch. Adapter: `server/services/universeBuilder/db.js`, dispatched via `store.js`.

**Postgres-First target.** Pipeline series/issues, Story Builder sessions, and searchable media metadata are still `db-primary` targets — they currently live in `data/` JSON but carry relationships and status that belong in the DB. The schema for the Create domains is designed in [`docs/plans/2026-06-07-create-relational-schema-design.md`](./plans/2026-06-07-create-relational-schema-design.md) (#999), with implementation tracked as #1014–#1018. (Creative Director project/scene/run state moved to Postgres in Phase 3 / #997; catalog user-defined types moved in Phase 4 lead-in / #1001; **universes moved in Phase 3 Create slice 1 / #1014** — see the `universes` entry above. Pipeline series/issues #1015, Story Builder #1016, Writers Room #1017, and the catalog ref resolver #1018 are the remaining slices.)

---

## `file-primary` — external-file or sync-sensitive records

**Definition.** The record either **is** an external file (long prose, a model, a repo) or must remain a file to preserve a sync/editing workflow PortOS does not own (iCloud, external editors, Git). A DB row may index it, but the file is authoritative for the body.

**When to use.** The payload is long externally-editable prose; the domain syncs through iCloud/file-sync outside PortOS; or forcing the record through the app DB would break an existing sync boundary.

**Where it lives.** Filesystem under `./data/` (or an OS-managed sync container). DB may hold metadata/index rows (hashes, word counts, segment indexes) but **not** the body.

**Examples.**
- Writers Room draft bodies — `data/writers-room/works/{workId}/drafts/{draftId}.md`. Keep `.md` file-backed; store metadata/index rows in DB.
- MortalLoom / Health / Meatspace health data — `data/health`, `data/meatspace`, MortalLoom iCloud store. Kept file-backed to preserve iCloud/file sync and avoid routing sensitive health records through the app DB before that boundary is designed.
- App scaffolds / cloned repos / browser profiles — `data/repos`, `data/browser-profile` — inherently filesystem-oriented.

---

## `asset-file-db-indexed` — bytes on disk, metadata in DB

**Definition.** Large binary payloads (images, video, audio, model weights) stay on disk as bytes, while their **searchable metadata** — provenance, gen params, favorites, notes, lineage, collection membership — lives in PostgreSQL as asset rows that reference the file by a stable key.

**When to use.** You have generated or imported binary assets that the user needs to search, filter, favorite, or relate to other records, but the bytes themselves are large and have no business in a column.

**Where it lives.** Bytes under `./data/` (`data/images/*`, `data/videos/*`, `data/audio/*`, `data/music/*`, thumbnails). Metadata in DB asset rows keyed by `asset_key` / `media_key`, with integrity metadata (SHA-256 — see `server/lib/assetHash.js`). The DB row references the file; it never embeds the bytes.

**Examples.**
- Generated images — `data/images/*` bytes + `.metadata.json` sidecars; indexed into the `media_assets` table (#1000) keyed `image:<filename>`. Sidecars remain authoritative; the DB row is a derived, queryable mirror. Adapter: `server/services/mediaAssetIndex/`.
- Generated videos — `data/videos/*`, `data/video-thumbnails/*` bytes, tracked in `data/video-history.json`; indexed into `media_assets` keyed `video:<jobId>`. History file remains authoritative.
- Media collections — many-to-many links over assets/universes/series/catalog media pointers (`db-primary` link tables) pointing at `asset-file-db-indexed` bytes. **Still `data/media-collections/*` JSON today** — a follow-up slice of #1000.

**Media asset index (`media_assets`, #1000).** One row per generated image/video: `media_key` (`<kind>:<ref>`) PK, `kind`/`ref`/`created_at` mirror columns for queries, the full metadata record in `data` JSONB. It is a **derived index** — the on-disk sidecars + `video-history.json` stay authoritative — reconciled from disk at boot (upsert every asset, prune rows whose file is gone) and kept warm by a generation-`completed` hook. Local-only (rebuilt from disk), so no sync cursor/tombstone. Adapter: `server/services/mediaAssetIndex/{logic,db,index}.js`.

**Postgres-First target (remaining).** `data/history.jsonl` (action log) and the durable portions of `data/media-jobs.json` (job history / lineage) are still file-backed — follow-up slices. Do **not** move generated image/video/audio bytes into PostgreSQL.

---

## `ephemeral-file` — queues / uploads / transient state

**Definition.** Regenerable, short-lived runtime state. Losing it costs at most an in-flight job or a cache rebuild — never durable user data. It should never be the only home for anything the user expects to persist.

**When to use.** Upload staging, in-flight job queues, caches, and scratch state. If a record must survive a reinstall or be queryable across records, it is **not** `ephemeral-file` — promote it.

**Where it lives.** Filesystem under `./data/`, frequently excluded from backups (see `DEFAULT_EXCLUDES` in `server/services/backup.js`). The DB may hold a durable **job reference** even when the staging bytes are ephemeral.

**Examples.**
- Upload staging — `data/uploads/*`. Ephemeral; do not put in DB except as job references.
- Media job queue — runtime queue state can stay file-backed short term, but **job history and artifact lineage are `db-primary`** and should move to the DB.
- Browser CDP profile / downloads — `data/browser-profile/`, `data/browser-downloads/` — cache, non-overridable backup excludes.

---

## Postgres-First Target Boundaries

The contract draws a single line:

- **PostgreSQL owns** app-native records, relationships, indexes, sync cursors, tombstones, lineage, status, and searchable metadata.
- **Files own** large binary payloads, long externally-editable prose bodies, model weights, temporary uploads, and iCloud-backed health/life stores.
- **File assets referenced from the DB** get a stable `asset_key` / `media_key` row plus integrity metadata. The DB points to files; it does not absorb the bytes.

Defaulting a new Create feature to a fresh `data/*.json` file is the anti-pattern this contract exists to stop. Monolithic JSON in hot paths (`media-jobs.json`, `video-history.json` — and `creative-director-projects.json` before #997 moved it to Postgres) causes write contention and growth risk; string-id cross-references across separate JSON stores drift with no integrity check. New relational surfaces should be `db-primary` from the start.

---

## Adding a new data store? Answer these

Apply this checklist to **every new feature that persists data**, and require it in PR review. A new `data/*.json` store must *justify* itself against these questions — the default for app-native records is PostgreSQL.

- [ ] **Which class is it?** Tag the domain `db-primary`, `file-primary`, `asset-file-db-indexed`, or `ephemeral-file`. If you cannot pick one cleanly, the design is probably mixing concerns.
- [ ] **Does it relate to other records?** FKs, cross-record queries, "show everything related to X", graph edges → `db-primary`. Do not encode relationships as string ids across separate JSON files (they drift with no integrity check).
- [ ] **Does it need search?** Full-text or vector search → PostgreSQL (`search_tsv` / pgvector), not an app-level scan over JSON files.
- [ ] **If you chose a new `data/*.json`, why not the DB?** Acceptable reasons: large binary bytes (`asset-file-db-indexed` — index the metadata, keep bytes on disk), long externally-editable prose, an iCloud/file-sync workflow PortOS does not own, or genuinely transient runtime state (`ephemeral-file`). "It was faster to write a JSON file" is **not** acceptable for app-native relational records.
- [ ] **Bytes vs. pointer.** If binary assets are involved, confirm bytes stay on disk and the DB holds only an `asset_key` / `media_key` row + integrity metadata. Never store bytes in a column.
- [ ] **Federation.** If the record syncs to peers, does it have a per-table/per-record sequence cursor and tombstone strategy? (See `server/lib/schemaVersions.js`, `server/lib/syncWire.js`.) Cross-machine sync is first-class — see the Distribution model in [`CLAUDE.md`](../CLAUDE.md).
- [ ] **Migration.** On-disk/DB format changes need a migration in `scripts/migrations/` (applied-list tracked per install in `data/migrations.applied.json`) and seed files in `data.reference/`. Other installs and other federated machines upgrade independently.
- [ ] **Backup coverage.** Will the new store be captured by backup? `db-primary` is covered by the Postgres dump; `file-primary` / `asset-file-db-indexed` by the rsync snapshot; `ephemeral-file` is correctly excluded (`DEFAULT_EXCLUDES`). Confirm the store lands in the right bucket. See [Backup & Restore](./BACKUP.md).

---

## See also

- [Backup & Restore](./BACKUP.md) — what gets backed up (data/ files + mandatory Postgres dump) and how restore works.
- [`docs/plans/2026-06-06-create-postgres-storage-inventory.md`](./plans/2026-06-06-create-postgres-storage-inventory.md) — full inventory + migration phases.
- [`server/lib/README.md`](../server/lib/README.md) — storage helpers (`collectionStore`, `fileUtils`, `db.js`, `assetHash`).
