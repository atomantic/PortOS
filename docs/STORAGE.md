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
- `universes` / `universe_runs` — Universe Builder records (canon bibles, categories, composite sheets, locks, influences) one row per universe with the full sanitized record in `data` JSONB and `name`/`schema_version`/`ephemeral`/`updated_at`/`deleted`/`deleted_at` mirrored into columns; render-run history one row per run (local-only, capped 200, never federated). Migrated from `data/universes/{id}/index.json` (collectionStore) in Phase 3 Create slice 1 (#1014). **NO `sync_sequence`** — universes federate via the EXISTING `dataSync` snapshot/push model (LWW on the body's `updatedAt`), so the storage swap is invisible to peers (no schema-version bump). The store bumps an in-process mutation epoch on every write that `dataSync` folds into its checksum fingerprint, since a DB edit no longer changes the `data/universes/` directory the fingerprint used to watch. **`universe_runs` is intentionally never federated** — a regenerable render cache under a 200-row *global* cap that two producers would mutually evict, while the durable universe record already syncs (ADR [tribe + universe-runs local](./decisions/2026-06-26-tribe-and-universe-runs-local.md), #1724). Adapter: `server/services/universeBuilder/db.js`, dispatched via `store.js`.
- `tribe_people` / `tribe_touchpoints` / `tribe_memory_links` — the Tribe relationship/CRM graph (people + their care cadence, contact touchpoints, and cross-links into brain `memories`). **Intentionally machine-local — never federated** (ADR [tribe + universe-runs local](./decisions/2026-06-26-tribe-and-universe-runs-local.md), #1724): it is relationship-graph data, mirroring the deliberate "memory_links are instance-local" boundary in `memorySync.js` (memory *nodes* federate, the link graph does not), and is coupled to machine-local domains — `tribe_memory_links` extends the non-federated `memory_links` layer and `tribe_touchpoints` carry per-machine calendar-account refs. NO `sync_sequence`, no peer-sync record kind, no `dataSync` category. Adapter: `server/services/tribe.js`.
- `creative_commissions` — Creative Commissions (Autonomous Creation Engine Phase 1, #2657): standing recurring creative briefs that fire on a cron cadence and drive the Creative Director directive pipeline unattended. One row per commission, the full sanitized record (brief / schedule / generation / feedback / capped `runs[]`) in `data` JSONB with `name`/`enabled`/`created_at`/`updated_at` mirrored into columns for the scheduler's "arm every enabled commission" query. **Intentionally machine-local — never federated** (a synced schedule would double-run on every peer, same rationale as `seriesAutopilotScheduler`): NO `sync_sequence` and NO `deleted`/`deleted_at` tombstone — deletes are hard deletes, mirroring `tribe`. Phase 2 will split the machine-local *schedule* from a federatable *brief/feedback* record before adding any sync hook. Adapter: `server/services/creativeCommissions/db.js`, selected pg-vs-file by `server/services/creativeCommissions/store.js` (file backend is the `NODE_ENV=test`/`MEMORY_BACKEND=file` escape hatch only).
- `threejs_models` — generated procedural 3D-model workspaces: one row per model with gallery-image lineage, provider/model attribution, generation/refinement status, and the validated declarative scene spec in `data` JSONB. The referenced image bytes remain under `data/images/`; deterministic Three.js source is derived from the stored spec rather than persisted as a second mutable artifact. The table is local-only in this first slice, with soft-delete columns retained so federation can be added without a record-shape migration.

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
- LoRA training datasets — `data/lora-datasets/{id}/index.json` + `images/*.png` (collectionStore). The record is inseparable from the image bytes it organizes, has no cross-record queries beyond a small characterId scan, and is **machine-local** like `data/loras/` itself (training artifacts tied to this machine's GPU output — never federates, no sync cursor/tombstone). Backed up in full: uploads and hand-edited captions are not re-creatable. Training RUN records are `db-primary` (`lora_training_runs`); run artifacts (checkpoints/samples) live under `data/training-runs/{runId}/` with checkpoints/cache excluded from backup.

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

**Standalone media-library federation (`mediaLibrary`, #1566).** For **full-sync peers**, the standalone media-library *bytes* (generated images + sidecars, videos, pipeline audio, uploaded music) mirror across the pair — not just bytes referenced by a synced creative record. The sender advertises a library-level manifest at `GET /api/peer-sync/library-manifest` (`{ schemaVersion, manifestHash, assets:[{kind,filename,sha256,sidecarSha256?}] }`); the receiver's periodic sweep (`syncMediaLibraryFromPeer`, driven from `initSharing`) diffs it against local disk, receiver-pulls missing bytes through the SAME `diffAssetManifestAgainstLocal` + `pullOneAsset` machinery as the per-record path, then rebuilds the derived `media_assets` index. Video thumbnails are regenerated locally on video pull (not byte-federated); `video-history.json` metadata already union-merges via the `videoHistory` dataSync category; the generic `data/history.jsonl` action log is machine-local and never federated. Byte replication is gated to `peer.fullSync` and honors backup `DEFAULT_EXCLUDES` (a media dir excluded from backup isn't federated). Manifest envelope versioned by `PORTOS_SCHEMA_VERSIONS.mediaLibrary` (a non-record category — see `NON_RECORD_SCHEMA_CATEGORIES`); the receiver gently skips a sender ahead of its version.

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

### Legacy migration-source cleanup

Each file→Postgres migrator parks its source aside (`<domain>.imported`, per-record `index.json.imported` / `manifest.imported.json`) instead of deleting it, as a one-release recovery copy. `server/scripts/pruneImportedLegacyFiles.js` (run at boot from `server/index.js`, after every store's file→DB warm, registered in the ledger by `scripts/migrations/077-prune-imported-legacy-files.js`) removes the **`.imported`** copies **only** when it has verified, by **record identity**, that every migrated record those artifacts hold is still present in the database. It reads the record ids straight off the parked artifacts — the **parsed `index.json.id`** of each per-record directory (the same id the migrator inserted, which can differ from the folder name), or the parsed JSON `.id` of the creative-director export, each writers-room manifest/folder/exercise, the universe `config.runs[]`, and each manifest's `drafts[]` — and checks those exact ids exist via `WHERE id = ANY(...)`. Identity rather than a row count, because a count can be satisfied by unrelated rows after a wipe+restore to a different record set (and the migrators' `imported` count comes from `INSERT … ON CONFLICT DO NOTHING`, so it can undercount). Anything that can't be verified withholds the whole domain's prune: a missing id, a present-but-unparseable artifact, an id-less record, or a domain whose migration is still pending (legacy source on disk, no marker). The prune deliberately does **not** touch the deeper `*.bak-NNN` monolith backups (the file→file split migrations 034–036) or the file-split backups (037 history, 059 media-collections): those predate the DB, can hold records the split migrator *skipped*, and carry soft-deleted records the live DB legitimately lacks, so they're neither identity-verifiable nor safe to auto-delete — they're left for manual cleanup. None of these artifacts are excluded from rsync backups: while a prune is blocked they are the only recovery source and `pg_dump` is capturing the incomplete DB, so a snapshot must keep them — once pruned from disk they leave subsequent snapshots naturally.

---

## PostgreSQL is required — `MEMORY_BACKEND=file` is test-only

PortOS treats **PostgreSQL as a mandatory install/runtime dependency** for every install and every federated peer machine (decision: [ADR — PostgreSQL as the Primary Datastore](./decisions/2026-06-07-postgres-as-primary-datastore.md)). Run it as either:

- **System (native) PostgreSQL on `:5432`** — `PGMODE=native`, or
- **Docker PostgreSQL on `:5561`** — `PGMODE=docker` (the default).

Provision either path with **`npm run setup:db`** (also run automatically by `npm run setup` and `npm start`). It auto-detects an already-healthy local PostgreSQL and uses native mode; otherwise it starts/initializes the Docker container, or — when Docker is unavailable — offers to bootstrap native PostgreSQL. See [Setup path](#setup-path-npm-run-setupdb) below.

### `MEMORY_BACKEND=file` is a development/test-only escape hatch — NOT a deployment mode

The file backend (`server/services/memory.js`, JSON under `./data/`) is **unsupported for production and for federated peers.** It exists only so the test suite (and ad-hoc local development) can boot without a database. It is **not** a fallback, a "lite" mode, or a way to run PortOS without Postgres:

- It is reached **only** via the explicit `MEMORY_BACKEND=file` env var (set from `PGMODE=file` in `.env`, mapped by the launcher) **or** automatically under `NODE_ENV=test`. There is no menu choice for it (`scripts/setup-db.js` offers only Docker and Native), and `npm run setup:db` with `PGMODE=file` prints an "unsupported" notice and refuses to provision it.
- When `MEMORY_BACKEND` is unset, PortOS **requires** a healthy database and **does NOT silently fall back to file storage** — an unreachable/unmigrated DB is an error condition. `server/services/memoryBackend.js` fails fast with an actionable message (`run npm run setup:db`) rather than serving a half-broken install. This no-silent-fallback behavior is intentional; do not "fix" it.

**Why file storage cannot be a supported mode:**

- **No creative-catalog / vector equivalent.** The catalog graph, memory similarity, and hybrid search depend on PostgreSQL + pgvector (HNSW vector search fused with `tsvector` full-text). There is no file-backed implementation of these — a file-backed install would serve a half-broken app the moment a user touched the catalog, memory search, or any `db-primary` Create domain. As each Create domain migrates to Postgres (universes #1014, pipeline #1015, Story Builder #1016, Writers Room #1017, catalog refs #1018), its file path survives **only** under this dev/test escape hatch.
- **Federation assumes Postgres.** Cross-machine sync (snapshot/push + last-writer-wins) and the `db-primary` sequence cursors/tombstones are designed around the database. A file-backed peer is not a supported member of a federation.
- **Backup assumes Postgres.** The backup/restore contract treats the `pg_dump` logical dump as **required system state** (see [Backup & Restore](./BACKUP.md)) — a file-backed install has no dump to capture or verify.

The escape hatch is **guarded from bitrot by the test suite** (tests boot with `NODE_ENV=test` and exercise the file backend), so the path stays runnable — but "the tests use it" is **not** an argument that it is a deployment option. It isn't.

### Setup path (`npm run setup:db`)

`npm run setup:db` → `scripts/setup-db.js` is the single command that makes PostgreSQL ready, and is wired into `npm run setup` and `npm start` so a normal install never has to think about it. Its happy path:

1. **Already healthy?** If the configured role can authenticate to the configured database **and** the `memories` table from `server/scripts/init-db.sql` exists, it reports ready and exits (fast path — no re-provisioning on every `npm start`).
2. **`PGMODE=docker` (default):** starts the `pgvector/pgvector:pg17` container (`docker-compose.yml`), waits for it to accept connections **and** finish applying the init schema, then reports ready on `:5561`. If Docker is missing or not running, it prints platform-specific install/start hints and — if a healthy native PostgreSQL is already present — switches to native automatically.
3. **`PGMODE=native`:** runs `scripts/db.sh setup-native` (idempotent: brew install, role, db, extensions, schema) and verifies at the domain level (role can auth + schema present) before reporting ready on `:5432`.
4. **Failure is non-zero exit.** A started-but-unresponsive container, a failed native bootstrap, or a non-interactive context with no usable DB exits non-zero with an actionable message — so the `&&`-chained `npm start` halts here instead of crash-looping under PM2 against an unready database.

`PGPASSWORD`/`PGUSER`/`PGDATABASE`/`PGPORT` are resolved from `process.env` first, then `.env`, then the backward-compatible defaults (`portos`/`portos`/`portos`/`5432`). The default `portos` password is an **intentional** local-development fallback (see the Distribution model note in [`CLAUDE.md`](../CLAUDE.md)); production deployments override it via `PGPASSWORD`.

### Boot schema upgrades & the CREATE INDEX lock window

`ensureSchema()` in `server/lib/db.js` applies **idempotent** schema upgrades on every boot (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). Every index it creates — including the HNSW vector index and the GIN full-text index on `catalog_scraps` — is a plain, **non-`CONCURRENT`** build.

The **first** time a given index materializes on a table that **already holds many rows** (an existing install upgrading into a newly-added index), Postgres takes a `SHARE` lock that **blocks writes** (INSERT/UPDATE/DELETE) to that table until the build completes. So an existing install can see a one-time write stall at boot proportional to the table's row count — HNSW builds are the slowest. Fresh installs never see this: they build every index on an **empty** table, so the lock is effectively instant.

This is left as-is deliberately rather than switched to `CREATE INDEX CONCURRENTLY`, because `CONCURRENTLY` cannot run inside a transaction block, needs its own retry/cleanup path (a failed concurrent build leaves an `INVALID` index that must be dropped by hand), and roughly doubles build time — too fragile to run unattended on every boot for a stall that only bites large-table upgrades.

**If a future index must land on a table known to already carry a large row count on existing installs,** note that the standard db-migration runner (`server/scripts/run-db-migrations.js`) wraps every migration in a `withTransaction()` block — so `CREATE INDEX CONCURRENTLY` **cannot** run there either. It would have to be issued from a dedicated **non-transactional** path (a standalone maintenance script or manual step run outside any transaction), not from `ensureSchema()` or a standard db-migration.

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
