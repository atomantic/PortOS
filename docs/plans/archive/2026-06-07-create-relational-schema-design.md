# Create Relational Schema Design (#999)

Date: 2026-06-07
Issue: [#999](https://github.com/atomantic/PortOS/issues/999)
Predecessor: [`2026-06-06-create-postgres-storage-inventory.md`](./2026-06-06-create-postgres-storage-inventory.md)

## Purpose

Phase 3 of the Postgres-First plan needs a concrete schema before any service's storage adapter is swapped. This doc designs the PostgreSQL data model for the file-backed Create domains — **universes, pipeline series, pipeline issues, Story Builder sessions, Writers Room metadata** — plus the plan to make **`catalog_ingredient_refs`** point at DB-native targets instead of bare string ids.

It is a **design** deliverable. No code ships from this doc; it exists so each implementation slice (separate issues, linked at the end) can be picked up without re-litigating the storage boundary.

## Guiding decisions (read these first)

Three decisions shape every table below. They follow directly from how the catalog already works (see the inventory doc's catalog conventions) and from PortOS's existing federation machinery.

### D1 — One row per record, full record in a `data JSONB` column, FKs/status/timestamps promoted to columns

These records are large, deeply nested, and already have battle-tested **sanitizers** (`sanitizeTemplate`, `sanitizeSeries`, `sanitizeIssue`, `sanitizeSession`) that operate on the whole object. Decomposing canon entries, seasons, stages, etc. into child tables would mean rewriting all of that validation as relational projections — high risk, low near-term payoff, and the inventory's nested shapes (8 issue stages, per-season covers with proof/final splits, canon bibles with ~30 character fields) are genuinely document-shaped.

**Mirror the Creative Director (#997) and `catalog_user_types` (#1001) pattern exactly:** one row per record, the sanitized record verbatim in `data JSONB NOT NULL`, and only the fields we **query, join, or sort on** promoted to real columns. This keeps the existing service API stable — adapters do `rowToRecord(row) => row.data` and `writeRecord(rec)` upserts — which is the explicit ask in #999 ("preserve existing service APIs first; swap their storage adapter underneath").

Promoted columns are the contract; the JSONB is the payload. When a query need emerges (e.g. "all live series in universe X"), promote that field to a column + index; never add a query that reaches into JSONB on a hot path.

### D2 — Keep the EXISTING federation model; do NOT add catalog-style `sync_sequence` pull cursors

This is the most important call in the doc, and it diverges from the catalog.

The catalog uses **pull-based** federation: `sync_sequence BIGSERIAL` per table + per-kind cursors + `GET /api/catalog/sync?since[...]`. The Create file stores use a **completely different, already-working** model:

- **`server/services/dataSync.js`** — periodic (~60s) snapshot reconciliation per record type.
- **Per-record push** on mutation (`autoSubscribeRecordToAllPeers`, `peerSync.js`).
- **LWW on `updatedAt`** for record bodies; tombstones (`deleted` + `deletedAt`) federate as normal records.
- **`ephemeral: true`** = local-only (never crosses the wire, except minimized tombstones).
- **Base-hash conflict journal** (`server/lib/conflictJournal.js`, `data/sharing/sync_base_hashes.json`) detects 3-way divergence.

Moving storage from a `data/{id}/index.json` file to a `db-primary` row must be **invisible to federation** — exactly like #1001, where moving catalog user types out of `settings.json` required **no schema-version bump** because the wire shape was storage-independent. The same property must hold here: the snapshot/push payloads stay byte-identical, peers on either side of the migration interoperate, and **no `PORTOS_SCHEMA_VERSIONS` bump is needed for the storage swap itself.**

Therefore:

- **No `sync_sequence` column** on these tables. Federation continues to read records through the service adapter (now DB-backed) and feed the same snapshot/push pipeline.
- **`updated_at` / `deleted` / `deleted_at`** ARE promoted to columns (they drive LWW + tombstone GC + "show live records" queries), but they are populated from the record body, not from a DB trigger. The body's `updatedAt` remains the LWW source of truth; the column mirrors it for indexing (via `mirrorTimestamp`).
- **`ephemeral`** is promoted to a column so the snapshot loop can `WHERE NOT ephemeral` without deserializing every row.
- The conflict-journal base-hash machinery is unchanged — it hashes the wire projection, which is storage-independent.

> If a future need arises to replace snapshot reconciliation with catalog-style pull cursors, that is its OWN project with its own schema-version gate. It is explicitly **out of scope** here — bundling it would make the storage swap a federation rewrite and break the "invisible migration" property.

### D3 — `catalog_ingredient_refs.ref_id` stays a string; integrity becomes a *resolver + reverse-index*, not a hard FK

`catalog_ingredient_refs` already references `universe | series | issue | work | creative-director` targets by `(ref_kind, ref_id)` string tuple with **no FK** — deliberately, because (a) refs federate and a peer may sync a ref before the target arrives, and (b) targets lived in files. Once targets are `db-primary`, a hard FK is *tempting* but **wrong**:

- A hard FK would make catalog sync **fail** when a ref arrives before its target (the inventory notes this is why there's no FK today — unresolved keys surface via the `metadata-missing` integrity endpoint instead of aborting the apply).
- Targets can be soft-deleted (tombstoned) while refs to them legitimately persist as history.

**Decision:** keep `ref_id TEXT` with no DB-level FK. Deliver integrity as:
1. A **resolver query layer** ("everything related to this universe/series/issue/work") that LEFT JOINs `catalog_ingredient_refs` against the new target tables on `(ref_kind, ref_id)` and reports resolved vs. dangling.
2. An **integrity endpoint** extension that lists refs whose `ref_id` no longer resolves to a live target (mirroring the existing `metadata-missing` media check).
3. The existing `idx_catalog_ing_refs_target (ref_kind, ref_id)` index already makes the reverse lookup cheap — no schema change to the refs table is required for the resolver.

This satisfies #999's "reference app-native DB targets instead of only string ref_id" without introducing a sync-breaking constraint.

## Storage classification (per the four-class contract)

| Domain | Class | Bytes | Searchable metadata |
|---|---|---|---|
| Universes (record body) | `db-primary` | PG `data` JSONB | PG promoted columns |
| Universe render runs (`config.runs[]`) | `db-primary`, local-only | PG (own table) | PG |
| Pipeline series | `db-primary` | PG `data` JSONB | PG |
| Pipeline issues | `db-primary` | PG `data` JSONB | PG |
| Story Builder sessions | `db-primary` (opt-in sync) | PG `data` JSONB | PG |
| Writers Room works (manifest) | `db-primary` | PG `data` JSONB | PG |
| Writers Room folders | `db-primary` | PG (own table) | PG |
| Writers Room exercises | `db-primary` | PG (own table) | PG |
| **Writers Room draft `.md` bodies** | **`file-primary`** | **Filesystem** | PG (`content_hash`, `word_count`, `segment_index` on a draft-version row) |
| Generated images/videos/audio bytes | `asset-file-db-indexed` | Filesystem | (handled by #1000, not here) |

The **only** thing that stays on disk from these domains is the Writers Room draft prose body (`drafts/{draftId}.md`) — long, externally-editable text the inventory flagged for file workflows. Its *metadata* (hash, word count, segment index, version lineage) becomes a DB row so the library, staleness analysis, and budgets can query it.

---

## Proposed tables

All tables follow the catalog column conventions: `TEXT PRIMARY KEY` (app-minted deterministic ids — `ser-…`, `iss-…`, `stb-…`, `wr-work-…`, the universe UUID), `data JSONB NOT NULL DEFAULT '{}'::jsonb`, `created_at`/`updated_at TIMESTAMPTZ`, `deleted BOOLEAN DEFAULT FALSE` + `deleted_at TIMESTAMPTZ`, `ephemeral BOOLEAN DEFAULT FALSE`. **No `sync_sequence`** (see D2). DDL ships in BOTH `server/lib/db.js` `ensureSchema` (a new `createDDL` array, parallel to `catalogDDL`) AND `server/scripts/init-db.sql`, locked by an extension of `db.catalogDdlParity.test.js`.

### `universes`

```sql
CREATE TABLE IF NOT EXISTS universes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version INTEGER NOT NULL DEFAULT 4,   -- record-shape version (sanitizeTemplate)
  ephemeral   BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  deleted     BOOLEAN DEFAULT FALSE,
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_universes_live ON universes (deleted) WHERE deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_universes_updated ON universes (updated_at);
```

- `name` promoted because the universe→collection rename, the delete-guard, and lists sort/filter on it.
- `schema_version` promoted from the record (`sanitizeTemplate` migrates v2→v3→v4 on read); keeping it a column lets a migration scan find unmigrated rows without parsing JSONB.
- **Local-only fields** (`styleImageRefs`, `importDraft`) stay inside `data` and are stripped by the existing `sanitizeRecordForWire` on the way to peers — unchanged.

### `universe_runs` (render-history log, local-only)

The type-level `config.runs[]` array (capped 200, never federated) becomes its own table rather than living in a singleton row, because it's append-mostly and per-peer-local.

```sql
CREATE TABLE IF NOT EXISTS universe_runs (
  id            TEXT PRIMARY KEY,
  universe_id   TEXT NOT NULL,           -- soft ref; ON DELETE handled in app (cascade-clean on universe delete)
  collection_id TEXT,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- jobIds[], promptCount
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_universe_runs_universe ON universe_runs (universe_id, created_at DESC);
```

- Pruned on universe delete (the existing `deleteUniverse` cascade) and trimmed to the most recent 200 per universe.
- No `universe_id` FK constraint: the delete cascade is handled in the service (same as today), and this keeps the table independent of universe-row insert ordering during import.

### `pipeline_series`

```sql
CREATE TABLE IF NOT EXISTS pipeline_series (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  universe_id         TEXT,                 -- FK target: universes.id (soft ref, see below)
  writers_room_work_id TEXT,                -- back-link to writers_room_works.id
  data                JSONB NOT NULL DEFAULT '{}'::jsonb,
  ephemeral           BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  deleted             BOOLEAN DEFAULT FALSE,
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_series_universe ON pipeline_series (universe_id) WHERE deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_series_wr_work ON pipeline_series (writers_room_work_id);
CREATE INDEX IF NOT EXISTS idx_series_updated ON pipeline_series (updated_at);
```

- `universe_id` promoted + indexed: this is the hot relationship (the delete-guard "reject universe delete when live series link it", and "series in this universe" lists). **Soft ref, not a hard FK** — same federation rationale as D3: a series can sync before its universe arrives. The delete-guard stays in the service layer (query `idx_series_universe`).
- `seasons[]`, `arc`, `locked`, covers — all stay in `data`.

### `pipeline_issues`

```sql
CREATE TABLE IF NOT EXISTS pipeline_issues (
  id          TEXT PRIMARY KEY,
  series_id   TEXT NOT NULL,            -- parent; soft ref to pipeline_series.id
  season_id   TEXT,                     -- optional arc grouping (series.seasons[].id)
  number      INTEGER,                  -- renumber-recomputed display ordinal
  status      VARCHAR(32),              -- draft|running|needs-review|shipped
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ephemeral   BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  deleted     BOOLEAN DEFAULT FALSE,
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_issues_series ON pipeline_issues (series_id, number) WHERE deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_issues_season ON pipeline_issues (season_id) WHERE season_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_issues_updated ON pipeline_issues (updated_at);
```

- `series_id`, `season_id`, `number` promoted: the renumber pass (`renumberInline` / `applyVolumeOrderedNumbers`) reads all issues of a series ordered by number; this is the single most common cross-record query in the pipeline. `idx_issues_series (series_id, number)` serves it directly.
- `status` promoted for "issues needing review" dashboards.
- The 8-stage `stages` map (text/visual/audio, `runHistory`, `canonExtraction`, covers) stays entirely in `data` — it's the canonical document-shaped blob. **Stage `lastRunId` pointers stay strings in JSONB**; they reference `data/runs/<runId>/` transcript dirs which are NOT migrating (out of scope, file-backed run artifacts).
- Issues inherit the parent series' subscription — no per-issue federation change.

### `story_builder_sessions`

```sql
CREATE TABLE IF NOT EXISTS story_builder_sessions (
  id          TEXT PRIMARY KEY,
  universe_id TEXT,
  series_id   TEXT,
  sync        BOOLEAN DEFAULT FALSE,    -- OPT-IN cross-machine resume (story-builder is opt-in, unlike others)
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ephemeral   BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  deleted     BOOLEAN DEFAULT FALSE,
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_stb_universe ON story_builder_sessions (universe_id);
CREATE INDEX IF NOT EXISTS idx_stb_series ON story_builder_sessions (series_id);
```

- `sync` promoted because Story Builder is the one store whose federation is **opt-in** — the snapshot loop filters `WHERE sync = TRUE` to decide what to even consider pushing. Promoting it avoids deserializing every session per snapshot tick.
- `steps`, `syncedHashes`, `currentStep`, `llm` stay in `data`.

### `writers_room_folders`

Currently a monolithic `data/writers-room/folders.json` array — a clean win for a flat table.

```sql
CREATE TABLE IF NOT EXISTS writers_room_folders (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT,                     -- nullable; nested folder tree (self-ref, soft)
  name       TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wr_folders_parent ON writers_room_folders (parent_id, sort_order);
```

### `writers_room_works`

The manifest (`data/writers-room/works/{workId}/manifest.json`).

```sql
CREATE TABLE IF NOT EXISTS writers_room_works (
  id                  TEXT PRIMARY KEY,
  folder_id           TEXT,
  title               TEXT NOT NULL,
  kind                VARCHAR(32),        -- short-story|comic-script|teleplay|prose
  status              VARCHAR(32),        -- drafting|reviewing|finalized
  active_draft_version_id TEXT,
  pipeline_series_id  TEXT,               -- promote-to-pipeline link
  pipeline_issue_id   TEXT,
  cd_project_id       TEXT,
  media_collection_id TEXT,
  data                JSONB NOT NULL DEFAULT '{}'::jsonb,  -- imageStyle, liveMode, usage counters
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  deleted             BOOLEAN DEFAULT FALSE,
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wr_works_folder ON writers_room_works (folder_id) WHERE deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_wr_works_series ON writers_room_works (pipeline_series_id) WHERE pipeline_series_id IS NOT NULL;
```

- Writers Room currently has **no soft-delete** (delete = `rm -rf` the work dir). Adding `deleted`/`deleted_at` is a small behavior upgrade that aligns it with the other stores and is safe; the migration sets `deleted = FALSE` for all existing works.
- The `drafts[]` array moves OUT of the manifest into `writers_room_draft_versions` (next table) — this is the one place we decompose, because draft versions are a genuine 1-to-many the library queries ("show all versions, word counts, which is active").

### `writers_room_draft_versions` (`file-primary` metadata index)

The draft **bodies stay on disk** at `data/writers-room/works/{workId}/drafts/{draftId}.md`. This table is the queryable metadata index over them.

```sql
CREATE TABLE IF NOT EXISTS writers_room_draft_versions (
  id            TEXT PRIMARY KEY,        -- wr-draft-…
  work_id       TEXT NOT NULL,
  label         TEXT,
  content_file  TEXT NOT NULL,           -- relative path: drafts/wr-draft-….md (bytes on disk)
  content_hash  TEXT,                    -- sha256 of the .md body (staleness detection)
  word_count    INTEGER DEFAULT 0,
  segment_index JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{id,kind,heading,start,end,wordCount}]
  created_from_version_id TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wr_drafts_work ON writers_room_draft_versions (work_id, created_at);
```

- This is the canonical `asset-file-db-indexed`-shaped pattern applied to prose: bytes in a file, metadata in PG. `content_hash` enables the Phase-5 live-director staleness comparison the inventory flagged.

### `writers_room_exercises`

Monolithic `data/writers-room/exercises.json` → flat table.

```sql
CREATE TABLE IF NOT EXISTS writers_room_exercises (
  id            TEXT PRIMARY KEY,
  work_id       TEXT NOT NULL,
  status        VARCHAR(16),             -- running|paused|finished
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- prompt, durations, word counts, appendedText, timestamps
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wr_exercises_work ON writers_room_exercises (work_id, started_at DESC);
```

---

## Relationship map (after migration)

```
universes ──< pipeline_series ──< pipeline_issues
    │              │                    └─ season_id ⇢ series.data.seasons[].id (intra-row)
    │              └─ writers_room_work_id ⇢ writers_room_works.id  (bidirectional promote link)
    │
    └──< universe_runs (local-only render log)
    └──< story_builder_sessions (universe_id, series_id)

writers_room_folders ──< writers_room_works ──< writers_room_draft_versions
                                  │                      └─ .md body on disk (file-primary)
                                  ├──< writers_room_exercises
                                  ├─ pipeline_series_id / pipeline_issue_id (promote)
                                  └─ cd_project_id / media_collection_id

catalog_ingredient_refs (ref_kind, ref_id) ⇢ {universes|pipeline_series|pipeline_issues|writers_room_works|creative_director_projects}.id
    (resolver LEFT JOIN — NO hard FK; see D3)
```

All `⇢` are **soft references** (string id match, resolver/guard at app layer). The only hard FK candidates would be parent→child within a fully-local, non-federated subtree (e.g. `universe_runs.universe_id`), and even those we keep soft to avoid insert-ordering pain during bulk import and to match every other table's convention. **Zero hard FKs** is the deliberate posture — it preserves the "ref can arrive before target" federation property uniformly.

---

## Migration order & importers

Each slice is idempotent (re-runnable), follows the #997/#1001 import pattern (read file store → upsert rows `ON CONFLICT (id) DO ...` → mark the file source aside, never destroy it for ≥1 release), and gates on `MEMORY_BACKEND=file`/`NODE_ENV=test` for the dev/test escape hatch. Order is dependency-first so resolver/guard queries work mid-migration:

1. **Universes** (`universes` + `universe_runs`) — no upstream deps. Import from `collectionStore('universes')` + the type-index `config.runs[]`.
2. **Pipeline series** (`pipeline_series`) — depends on universes for `universe_id` resolution (soft, so order is a nicety not a hard gate).
3. **Pipeline issues** (`pipeline_issues`) — depends on series.
4. **Story Builder** (`story_builder_sessions`) — depends on universes + series.
5. **Writers Room** (`writers_room_folders` → `writers_room_works` → `writers_room_draft_versions` → `writers_room_exercises`) — folders first (parent tree), then works, then per-work draft-version rows (read each `manifest.json` `drafts[]`, leave the `.md` files in place), then exercises.
6. **Catalog refs resolver** — no data migration; add resolver query + integrity-endpoint extension once targets exist.

Each importer:
- Lives in `server/scripts/migrate<Domain>ToDB.js` with a one-time marker (mirror `migrateCatalogUserTypesToDB.js` — marker = absence of the legacy store, value parked aside under a recovery key, never overwriting an existing recovery copy).
- Uses `mirrorTimestamp(record.updatedAt, NOW())` to populate the promoted `updated_at` column from the body.
- Preserves `ephemeral`/`importDraft`/`sync` flags into their promoted columns AND inside `data`.
- Is wired into the boot-time backend selector for that domain's `store.js` dispatcher (mirror `catalogUserTypes/store.js`: `checkHealth → ensureSchema → migrate → return DB backend`, with the memoized-promise guard against double-migration).

## Adapter shape (preserve service APIs)

Each domain gets a `server/services/<domain>/store.js` dispatcher + `<domain>DB.js` adapter, mirroring `catalogUserTypes/`:

- `store.js` — backend selector (`isFileBackend()` → `collectionStore` path; else PG path after health/schema/migration), memoizes the selection promise.
- `<domain>DB.js` — `readRecord(id)`, `listRecords({includeDeleted})`, `writeRecord(rec)` (upsert: promote columns + `data = $json`), `softDeleteRecord(id)`, `pruneTombstoned(beforeMs)`. `rowToRecord(row) => sanitize(row.data)` so the existing sanitizer still owns shape.
- The existing service module (`universeBuilder.js`, `pipeline/series.js`, etc.) calls the dispatcher instead of `collectionStore` directly — **its public functions and return shapes are unchanged**, which is what keeps routes, client, federation, and tests stable.
- The `collectionStore` file backend is retained behind the escape hatch (dev/test), exactly as catalog user types retained their settings-slice file backend.

## Peer sync implications

Per D2, the storage swap is **federation-invisible**:
- `dataSync.js` snapshot reconciliation and per-record push read through the (now DB-backed) service adapter — same record shape in, same wire payload out.
- LWW on body `updatedAt`, tombstone federation, `ephemeral` exclusion, and the base-hash conflict journal are all unchanged.
- **No `PORTOS_SCHEMA_VERSIONS` bump** for the migration. A peer on the old (file) build and a peer on the new (DB) build sync identically — the property #1001 proved out.
- The one new federation-adjacent capability (catalog ref resolver / dangling-ref integrity report) is **read-only and local**; it doesn't touch the wire.

## Backup / restore implications

- PostgreSQL is already in the required backup set (Phase 1, #998). These tables join the dumped schema automatically; no `pg_dump` flag change.
- Writers Room `.md` bodies remain in the `data/` rsync set — restore must keep DB `writers_room_draft_versions.content_file` rows and their on-disk `.md` files **coherent**. Add a restore-verification check (extend the existing backup-count assertions) that every live draft-version row's `content_file` exists on disk and its `content_hash` matches — surfacing orphaned-metadata or orphaned-body drift.
- Add table-count assertions for the new Create tables to backup verification (per Phase 5 of the plan).

## Rollback / export

- Importers never destroy the file source for ≥1 release (parked-aside, recovery-key-preserving) — rollback = flip the escape hatch back to the file backend, the untouched `data/` stores are still authoritative.
- Add `export` commands (mirroring the plan's Phase 5) that regenerate a portable `data/<domain>/{id}/index.json` bundle from the DB rows, so a `db-primary` domain can always round-trip back to a file bundle for portability/debugging.

## What this design deliberately does NOT do

- Does **not** decompose canon entries, seasons, or the 8-stage issue map into child tables (D1 — document-shaped, sanitizer-owned).
- Does **not** add `sync_sequence` pull cursors or change the federation model (D2 — out of scope, own project).
- Does **not** add hard FKs anywhere (D3 + uniform soft-ref posture — preserves "ref before target").
- Does **not** migrate `data/runs/<runId>/` LLM transcripts, generated media bytes, or MortalLoom/health stores (out of scope; transcripts stay file-backed, media metadata is #1000).
- Does **not** move Writers Room draft `.md` bodies into the DB (`file-primary` — only their metadata index).

## Follow-up implementation issues (to open)

The first implementation slice can be picked up cold from this doc. Issue breakdown (dependency order):

1. [#1014](https://github.com/atomantic/PortOS/issues/1014) **Universes → PostgreSQL** (`universes` + `universe_runs`, dispatcher + adapter + importer + DDL/parity + boot warm). Highest value, no upstream deps.
2. [#1015](https://github.com/atomantic/PortOS/issues/1015) **Pipeline series + issues → PostgreSQL** (depends on #1014; the renumber query is the payoff).
3. [#1016](https://github.com/atomantic/PortOS/issues/1016) **Story Builder sessions → PostgreSQL** (depends on #1014, #1015).
4. [#1017](https://github.com/atomantic/PortOS/issues/1017) **Writers Room metadata → PostgreSQL** (folders/works/draft-versions/exercises; `.md` bodies stay file-backed; draft-version metadata index).
5. [#1018](https://github.com/atomantic/PortOS/issues/1018) **Catalog ref resolver + dangling-ref integrity** (depends on #1014–#1017 existing as targets; delivers #999's "reference DB targets" via resolver, no schema change).

Each slice mirrors the #997 (Creative Director) / #1001 (catalog user types) playbook end-to-end: DDL in `db.js` + `init-db.sql` + parity test, dispatcher + DB adapter preserving the service API, idempotent recovery-key-preserving importer, boot-time backend selection + warm, file backend retained behind the dev/test escape hatch, federation untouched (no schema-version bump), tests at the adapter + dispatcher + importer layers.
