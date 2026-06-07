# Create Storage Inventory + Postgres-First Plan

Date: 2026-06-06

## Short Answer

The creative catalog itself is PostgreSQL-backed today, not file-backed. The surrounding Create section is mixed:

- Catalog scraps, ingredients, source links, refs, ingredient relations, tags, revisions, and catalog media pointers live in PostgreSQL via `server/services/catalogDB.js`, `server/lib/db.js`, and `server/scripts/init-db.sql`.
- Most native Create workflow state still lives under `data/` as JSON, JSONL, Markdown, and binary media files.
- Memory can use PostgreSQL, but it still has a file fallback through `MEMORY_BACKEND=file` or auto-detect fallback.
- User-defined catalog types are still stored in `data/settings.json`, even though the records that use those types live in PostgreSQL.

This means PortOS already treats PostgreSQL as essential for the catalog, but the install/runtime posture still treats it as optional. That mismatch will get more expensive as Create adds richer relationships.

## Current PostgreSQL Inventory

| Area | Storage | Notes |
| --- | --- | --- |
| Creative catalog scraps | `catalog_scraps` | Raw pasted/imported text, chunking metadata, embeddings, FTS, sync sequence. |
| Creative catalog ingredients | `catalog_ingredients` | Typed records with JSONB payload, tags, embeddings, generated `search_tsv`, soft delete, sync sequence. |
| Scrap-to-ingredient provenance | `catalog_ingredient_sources` | Many-to-many extraction source links plus optional spans. |
| Catalog-to-app refs | `catalog_ingredient_refs` | Links catalog rows to `universe`, `series`, `issue`, `work`, and `creative-director` records by string id. |
| Ingredient graph edges | `catalog_ingredient_relations` | Directed ingredient-to-ingredient edges. This is already the strongest argument for Postgres as the catalog graph store. |
| Catalog tags | `catalog_tags` | First-class canonical tag table, while `catalog_ingredients.tags TEXT[]` remains the simple write path. |
| Catalog revisions | `catalog_ingredient_revisions` | Local-only audit trail, not federated. |
| Catalog media pointers | `catalog_ingredient_media` | References media keys in the file-backed media library; does not duplicate bytes. |
| Memory, when available | `memories`, `memory_links` | PostgreSQL + pgvector when explicitly selected or auto-detected. File fallback still exists. |

Relevant files:

- `server/lib/db.js`
- `server/scripts/init-db.sql`
- `server/services/catalogDB.js`
- `server/routes/catalog.js`
- `server/services/memoryBackend.js`
- `server/services/memoryDB.js`

## Current File-Based Inventory

### Create Section

| Area | Storage | Postgres fit |
| --- | --- | --- |
| Universe Builder | `data/universes/{id}/index.json` via `collectionStore`; legacy `data/universe-builder.json` migrations | Strong. Universes contain canon, render pointers, locks, soft deletes, and cross-links to series/catalog. |
| Pipeline series | `data/pipeline-series/{id}/index.json` | Strong. Series has `universeId`, `writersRoomWorkId`, seasons, arc state, and catalog cast panels. |
| Pipeline issues | `data/pipeline-issues/{id}/index.json` | Strong. Issues are children of series and carry stage status, run pointers, output state, and production artifacts. |
| Story Builder | `data/story-builder/{id}/index.json` | Strong. Mostly workflow metadata with `universeId` and `seriesId` FKs. |
| Writers Room manifests | `data/writers-room/works/{workId}/manifest.json` | Medium-strong. Work metadata belongs in DB; draft bodies can remain Markdown files for now. |
| Writers Room drafts | `data/writers-room/works/{workId}/drafts/{draftId}.md` | Keep file-backed initially. Long prose benefits from file workflows and possible external editing. Add DB metadata/index rows. |
| Creative Director projects | `data/creative-director-projects.json` | Very strong. Project, treatment, scenes, run history, source issue, collection id, and final video id are relational. Current monolithic JSON is a bottleneck. |
| Media collections | `data/media-collections/{id}/index.json` | Strong. Collections are many-to-many links over assets, universes, series, and catalog media pointers. |
| Media job queue | `data/media-jobs.json` | Medium. Runtime queue state can remain file-backed short term, but job history and artifact lineage should move to DB. |
| Image/video history | `data/history.jsonl`, `data/video-history.json` | Strong for metadata. Bytes should remain files. |
| Prompt Manager | `data/prompts/stage-config.json`, `variables.json`, template `.md` files | Medium. Stage config/variables are relational enough for DB; templates can remain Markdown files until versioning needs DB. |
| Catalog user types | `data/settings.json#catalogUserTypes` | Strong. Type registry should move into Postgres because it defines catalog row semantics and must version/sync with catalog data. |

### Binary/Asset Stores That Should Stay File-Based

| Area | Storage | Rationale |
| --- | --- | --- |
| Generated images | `data/images/*` plus `.metadata.json` sidecars | Keep bytes on disk. Move searchable metadata, provenance, favorites, notes, and sidecar fields to DB. |
| Reference images | `data/image-refs/*` | Keep bytes on disk; add DB asset rows where durable references matter. |
| Generated videos | `data/videos/*`, `data/video-thumbnails/*` | Keep bytes on disk; move metadata/history/lineage to DB. |
| Audio/music | `data/audio/*`, `data/music/*` | Keep bytes on disk; move library metadata and usage links to DB. |
| LoRAs/models | `data/loras/*`, `data/media-models.json`, external HF caches | Mostly file/model registry. DB can index installed assets later, but not critical for Create relationships. |
| Upload staging | `data/uploads/*` | Ephemeral file staging. Do not put in DB except job references. |

### Deliberately File-Based for Now

| Area | Storage | Rationale |
| --- | --- | --- |
| MortalLoom / Health / Meatspace health data | `data/health`, `data/meatspace`, MortalLoom iCloud store | Keep file-backed to preserve iCloud/file sync workflows and avoid forcing sensitive health records through the app DB before we design that boundary. |
| Settings secrets/config | `data/settings.json` | Split later. Not all settings warrant DB storage, but catalog type definitions should move sooner. |
| App scaffolds/repos/browser profiles | `data/repos`, `data/browser-profile`, generated project files | These are inherently filesystem-oriented. |

## Problems With The Current Split

1. PostgreSQL is optional in setup, but the catalog already requires it. If DB setup is skipped or unhealthy, catalog features have no equivalent file-backed implementation.
2. The Create section uses string ids across stores instead of real constraints. `catalog_ingredient_refs.ref_id`, `series.universeId`, `issue.seriesId`, `storyBuilder.universeId`, `storyBuilder.seriesId`, `creativeDirector.sourceIssueId`, and `mediaCollection.seriesId/universeId` can drift.
3. File-backed collection records require app-level scans for cross-record queries. This is workable for small installs, but poor for “show all artifacts, refs, casts, scenes, issues, and catalog rows related to this universe.”
4. Monolithic files still exist in hot paths (`creative-director-projects.json`, `media-jobs.json`, `video-history.json`), creating unnecessary write contention and growth risk.
5. Asset metadata is split between DB pointers, JSON history, and sidecar files. The bytes should stay on disk, but metadata should have one queryable home.
6. Catalog user-defined types live in settings instead of the catalog database. That makes type evolution and sync/version checks harder than they need to be.

## Postgres-First Target

PostgreSQL should become a mandatory install/runtime dependency for PortOS, defaulting to native PostgreSQL where available and keeping Docker as a supported hosting mode. File storage should remain first-class for large assets, external-file workflows, and explicitly file-sync-oriented domains.

Target boundaries:

- PostgreSQL owns app-native records, relationships, indexes, sync cursors, tombstones, lineage, status, and searchable metadata.
- Files own large binary payloads, long externally-editable prose bodies, model weights, temporary uploads, and iCloud-backed health/life stores.
- File assets referenced from DB get stable `asset_key` or `media_key` rows plus integrity metadata. The DB points to files; it does not absorb the bytes.

## Proposed Migration Phases

### Phase 1: Make PostgreSQL Mandatory

- Remove `file` as a normal setup choice in `scripts/setup-db.js`.
- Keep Docker and native as hosting modes; default to native when a healthy local PostgreSQL 17 + pgvector is available, otherwise offer Docker setup.
- Fail startup or mark the app unhealthy when required DB schema is unavailable, instead of silently falling back to file memory mode.
- Keep a temporary `MEMORY_BACKEND=file` escape hatch only for development/tests, documented as unsupported for production app installs.
- Update backup/restore docs now that PostgreSQL backups are part of required system state.

### Phase 2: Introduce A Storage Classification Contract

Create a small documented contract for every domain:

- `db-primary`: app-native relational records.
- `file-primary`: external-file or sync-sensitive records.
- `asset-file-db-indexed`: bytes on disk, metadata in DB.
- `ephemeral-file`: queues/uploads/transient state.

Add a checklist to new feature docs and PR reviews so new Create features must justify any new JSON store.

### Phase 3: Move Create Metadata To PostgreSQL

Start with the highest-value relational surfaces:

1. Creative Director
   - Tables: `creative_director_projects`, `creative_director_scenes`, `creative_director_runs`.
   - Keep videos/thumbnails in files.
   - Add migration from `data/creative-director-projects.json`.

2. Media asset index
   - Tables: `media_assets`, `media_collections`, `media_collection_items`, `media_jobs`, maybe `media_asset_sidecars`.
   - Migrate `data/history.jsonl`, `data/video-history.json`, `data/media-collections/*`, and durable portions of `data/media-jobs.json`.
   - Keep `data/images`, `data/videos`, thumbnails, audio, and music as bytes on disk.

3. Story universe/pipeline metadata
   - Tables for universes, series, issues, story-builder sessions, stage states, seasons, locks, and tombstones.
   - Preserve existing service APIs first; swap their storage adapter underneath.
   - Backfill `catalog_ingredient_refs` to use canonical DB ids and enforce integrity as much as possible.

4. Writers Room metadata
   - Tables for folders, works, draft versions, segment indexes, media collection links, and promote-to-pipeline links.
   - Keep `.md` draft bodies file-backed initially; store hashes/word counts/segment metadata in DB.

5. Prompt Manager metadata
   - Tables for stages, variables, providers/model overrides, and template versions.
   - Keep Markdown template bodies file-backed until DB versioning/search is needed.

### Phase 4: Make Catalog The Create Graph Hub

- Move catalog user-defined types from `settings.json` into catalog DB tables.
- Replace or supplement `catalog_ingredient_refs.ref_id` string references with typed DB-backed target mappings.
- Add DB-level integrity where possible for app-native targets.
- Add resolver queries for “everything related to this universe/series/issue/work/project.”
- Preserve peer sync semantics by adding per-table sequence cursors before removing old file sync paths.

### Phase 5: Compatibility, Migration, And Rollback

- Write idempotent importers from current files into DB tables.
- Keep old files as read-only migration sources for at least one release.
- Add export commands for DB-backed domains that can regenerate a portable `data/` bundle when needed.
- Expand backup verification to assert table counts for new Create tables, not just memory/catalog.
- Add restore tests that verify DB rows and referenced file assets remain coherent.

## Suggested Non-Goals

- Do not move generated image/video/audio bytes into PostgreSQL.
- Do not migrate MortalLoom, Health, or iCloud-backed Meatspace data yet.
- Do not remove file-backed Markdown drafts until we design external editing/versioning.
- Do not rewrite all services at once. Preserve existing HTTP/client APIs while swapping storage behind service modules.

## First Issues To Track

1. [#998](https://github.com/atomantic/PortOS/issues/998) Make PostgreSQL mandatory for PortOS installs and remove normal file-backend fallback.
2. [#1000](https://github.com/atomantic/PortOS/issues/1000) Add DB-backed media asset and collection metadata while keeping bytes on disk.
3. [#997](https://github.com/atomantic/PortOS/issues/997) Migrate Creative Director project/treatment/run state from monolithic JSON to PostgreSQL.
4. [#999](https://github.com/atomantic/PortOS/issues/999) Design the Create relational schema for universes, series, issues, Story Builder sessions, Writers Room metadata, and catalog refs. — **Design complete:** [`2026-06-07-create-relational-schema-design.md`](./2026-06-07-create-relational-schema-design.md); implementation tracked as #1014–#1018.
5. [#1001](https://github.com/atomantic/PortOS/issues/1001) Move catalog user-defined types from settings into PostgreSQL.
