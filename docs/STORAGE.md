# Storage Classification Contract

PortOS stores data in two places: **PostgreSQL** (app-native relational records, search/vector indexes, sync cursors, lineage) and the **filesystem** under `./data/` (large binary assets, externally-editable prose, model weights, transient queues, and explicitly file-sync-oriented domains).

PostgreSQL is a **required** install/runtime dependency (see [Backup & Restore](./BACKUP.md) and `scripts/setup-db.js`). Files remain first-class for the things a relational DB is bad at. This document is the contract for deciding **which home a given domain belongs in** — and the checklist a reviewer should apply before any new feature defaults to "just write another `data/*.json`."

**This page is the contract, not the inventory.** Each store records its class, federation stance and the reason in its own module header, as a paragraph starting `Storage: `. To list or look up stores, search the headers (``rg -n 'Storage: `' server scripts``) or the module catalog (`node scripts/lib-catalog.js <term>`). Operator recovery procedures are in [Storage Recovery](./STORAGE_RECOVERY.md) and [Database Maintenance](./DATABASE_MAINTENANCE.md).

## The Four Storage Classes

| Class | Bytes live | Searchable metadata | Use when | PortOS examples |
|---|---|---|---|---|
| `db-primary` | PostgreSQL | PostgreSQL | App-native relational records: relationships, indexes, status, lineage, sync cursors, tombstones | `catalog_ingredients`, `catalog_ingredient_relations`, `catalog_ingredient_refs`, `memories`, `universes`, `pipeline_series`, `pipeline_issues`, `story_builder_sessions`, `writers_room_works`, `creative_director_projects`, `media_assets`, `cos_tasks`, `cos_agents` |
| `file-primary` | Filesystem | Filesystem (DB may index) | The record IS an external file, or it must survive in a file-sync workflow (iCloud, Git, hand-editing) | Writers Room draft `.md` bodies, MortalLoom / Health / Meatspace iCloud stores |
| `asset-file-db-indexed` | Filesystem | PostgreSQL | Large binary payloads whose **metadata** must be queryable/searchable | Generated images/videos/audio + DB asset rows referencing them via `asset_key` / `media_key` |
| `ephemeral-file` | Filesystem | None (or DB job ref only) | Transient/regenerable runtime state — queues, uploads, caches | `data/uploads/*`, runtime media job queue, browser profile/cache |

**The one rule that ties them together: the DB points to files; it does not absorb the bytes.** Any file asset referenced from the DB gets a stable `asset_key` / `media_key` row plus integrity metadata. Bytes never go into a column.

---

## `db-primary` — app-native relational records

**Definition.** Records that PortOS itself authors and relates: they have foreign keys, statuses, audit trails, search/vector indexes, and federated sync cursors/tombstones. The DB is the source of truth; there is no meaningful file representation of the record.

**When to use.** The record participates in relationships (`series.universeId`, `issue.seriesId`, catalog refs), needs cross-record queries ("everything related to this universe"), needs full-text or vector search, or needs per-table sequence cursors for peer sync.

**Where it lives.** PostgreSQL via `server/lib/db.js` + `server/scripts/init-db.sql`. Service modules own the storage adapter (e.g. `server/services/catalog/catalogDB.js`, `server/services/memoryDB.js`).


**Create domains in PostgreSQL.** Universes, pipeline series/issues, Story Builder sessions, Writers Room metadata, Creative Director projects, catalog refs, and `media_assets` are `db-primary` in PostgreSQL (see `server/scripts/init-db.sql`); historical Create-domain schema design notes are archived in [`docs/plans/archive/2026-06-07-create-relational-schema-design.md`](./plans/archive/2026-06-07-create-relational-schema-design.md).

---

## `file-primary` — external-file or sync-sensitive records

**Definition.** The record either **is** an external file (long prose, a model, a repo) or must remain a file to preserve a sync/editing workflow PortOS does not own (iCloud, external editors, Git). A DB row may index it, but the file is authoritative for the body.

**When to use.** The payload is long externally-editable prose; the domain syncs through iCloud/file-sync outside PortOS; or forcing the record through the app DB would break an existing sync boundary.

**Where it lives.** Filesystem under `./data/` (or an OS-managed sync container). DB may hold metadata/index rows (hashes, word counts, segment indexes) but **not** the body.

---

## `asset-file-db-indexed` — bytes on disk, metadata in DB

**Definition.** Large binary payloads (images, video, audio, model weights) stay on disk as bytes, while their **searchable metadata** — provenance, gen params, favorites, notes, lineage, collection membership — lives in PostgreSQL as asset rows that reference the file by a stable key.

**When to use.** You have generated or imported binary assets that the user needs to search, filter, favorite, or relate to other records, but the bytes themselves are large and have no business in a column.

**Where it lives.** Bytes under `./data/` (`data/images/*`, `data/videos/*`, `data/audio/*`, `data/music/*`, `data/models/*`, thumbnails). Metadata in DB asset rows keyed by `asset_key` / `media_key`, with integrity metadata (SHA-256 — see `server/lib/assetHash.js`). The DB row references the file; it never embeds the bytes.

**Postgres-First target (remaining).** `data/history.jsonl` (action log) and the durable portions of `data/media-jobs.json` (job history / lineage) are still file-backed — follow-up slices. Do **not** move generated image/video/audio bytes into PostgreSQL.

---

## `ephemeral-file` — queues / uploads / transient state

**Definition.** Regenerable, short-lived runtime state. Losing it costs at most an in-flight job or a cache rebuild — never durable user data. It should never be the only home for anything the user expects to persist.

**When to use.** Upload staging, in-flight job queues, caches, and scratch state. If a record must survive a reinstall or be queryable across records, it is **not** `ephemeral-file` — promote it.

**Where it lives.** Filesystem under `./data/`, frequently excluded from backups (see `DEFAULT_EXCLUDES` in `server/services/backup/excludes.js`). The DB may hold a durable **job reference** even when the staging bytes are ephemeral.

---

## Postgres-First Target Boundaries

The contract draws a single line:

- **PostgreSQL owns** app-native records, relationships, indexes, sync cursors, tombstones, lineage, status, and searchable metadata.
- **Files own** large binary payloads, long externally-editable prose bodies, model weights, temporary uploads, and iCloud-backed health/life stores.
- **Model weights belong in the shared Hugging Face hub cache.** A runtime that cannot use it (its own layout, converted artifacts, hand-placed files) declares its directory in `server/lib/modelRoots.js` and gets an inventory backend in `lib/modelInventory.js`; `lib/modelRoots.test.js` fails when the two drift. Docs and installers download by repo id (no `--local-dir`), so Models can size, flag and reclaim every copy. Large weights in a hand-placed root are reported as **unmanaged**.
- **File assets referenced from the DB** get a stable `asset_key` / `media_key` row plus integrity metadata. The DB points to files; it does not absorb the bytes.

Defaulting a new Create feature to a fresh `data/*.json` file is the anti-pattern this contract exists to stop. Monolithic JSON in hot paths (`media-jobs.json`, `video-history.json` — and `creative-director-projects.json` before #997 moved it to Postgres) causes write contention and growth risk; string-id cross-references across separate JSON stores drift with no integrity check. New relational surfaces should be `db-primary` from the start.

## PostgreSQL is required — `MEMORY_BACKEND=file` is test-only

PortOS treats **PostgreSQL as a mandatory install/runtime dependency** for every install and every federated peer machine (decision: [ADR — PostgreSQL as the Primary Datastore](./decisions/2026-06-07-postgres-as-primary-datastore.md)). Run it as either:

- **System (native) PostgreSQL on `:5432`** — `PGMODE=native`, or
- **Docker PostgreSQL on `:5561`** — `PGMODE=docker` (the default).

Provision either path with **`npm run setup:db`** (also run automatically by `npm run setup` and `npm start`). It follows `PGMODE` (nonempty shell export → `.env` → `docker`; an empty export is unset) — the same precedence `ecosystem.config.cjs` uses to pick the managed processes' `PGPORT`, so setup and PM2 never disagree — and provisions only that selected backend. An unavailable Docker installation fails setup without probing native PostgreSQL or changing the saved mode. See [Setup path](#setup-path-npm-run-setupdb) below.

The standalone `scripts/db.sh` also reads the repository-root `.env` through the
shared setup parser (Node is required), with nonempty shell settings taking
precedence. Quoted mode and connection values are supported without evaluating
shell syntax. Native commands use `PGPORT`; Docker commands use
`PGPORT_DOCKER`, unless the caller explicitly exports an active `PGPORT`.
`setup-native` uses `PORTOS_NATIVE_PGPORT` when inherited from PM2, then the
configured native `PGPORT`, without changing the selected mode. Container-local
dump/import tools are used only for the selected local Docker endpoint; a
host/port override cannot silently fall back to the local container. Maintenance
`--endpoint` transfers remain bound to their explicitly recorded endpoint.

**Docker repair preserves volume identity.** Before `scripts/db.sh fix` stops
or removes an existing database container, it compares that container's data
volume with the named volume resolved by `docker compose config`. A changed
checkout directory, `COMPOSE_PROJECT_NAME`, or volume override can select a
different volume for the next startup. Repair refuses a mismatch or an
unresolved volume without changing the container or its data; restore the
original Compose project/volume configuration before retrying. With no
container, repair requires the configured named volume to already exist and
never creates one.

**Endpoint binding (#10757).** The resolved host, port, user and database are
passed as explicit arguments, but libpq also honors inherited variables that
choose where a client really connects: `PGHOSTADDR` overrides the network
destination of `-h`, `PGSERVICE`/`PGSERVICEFILE` can supply another endpoint,
and `PGOPTIONS` alters session settings. Every host `psql`, `pg_dump` and
`pg_isready` that `scripts/db.sh` starts — readiness, `setup-native` role,
database, extension and schema statements, and ordinary `export`/`import` —
runs with those four variables removed from the child only (`pg_bound`), as does
the readiness probe and bootstrap child of `scripts/setup-db.js`. The operator's
shell is never modified. Supported TLS and authentication settings (`PGSSLMODE`,
`PGSSLROOTCERT`, `PGPASSFILE`, ...) pass through on these ordinary paths;
`--endpoint` maintenance transfers keep their stricter scrub of every `PG*`
variable. Passwords stay in the child environment or stdin, never argv.

### Database endpoints in managed processes

The ecosystem resolves native `PGPORT` and Docker `PGPORT_DOCKER` from the
launching environment, then `.env`, then their defaults. It passes `PGPORT`
to the server and CoS runner as the **active pool port**. It also passes the
resolved native port as internal `PORTOS_NATIVE_PGPORT` and the resolved Docker
port as `PGPORT_DOCKER`. Child maintenance/configuration processes preserve
those backend identities when reloading the ecosystem or preparing native
setup, even when the parent's active pool is Docker. Do not put the internal
variable in `.env`; configure the native port with `PGPORT` in the ordinary
launching shell or `.env`. Inherited endpoint identity takes precedence over
a later file edit: restart from the intended launch environment to apply changed
connection settings. A coordinator must still compare saved configuration,
recorded endpoints, and the running pool before cutover.

### `MEMORY_BACKEND=file` is a development/test-only escape hatch — NOT a deployment mode

The file backend (`server/services/memory.js`, JSON under `./data/`) is **unsupported for production and for federated peers.** It exists only so the test suite (and ad-hoc local development) can boot without a database. It is **not** a fallback, a "lite" mode, or a way to run PortOS without Postgres:

- It is reached **only** via the explicit `MEMORY_BACKEND=file` env var (set from `PGMODE=file` in `.env`, mapped by the launcher) **or** automatically under `NODE_ENV=test`. Setup has no interactive backend menu, and `npm run setup:db` with `PGMODE=file` prints an "unsupported" notice and refuses to provision it.
- When `MEMORY_BACKEND` is unset, PortOS **requires** a healthy database and **does NOT silently fall back to file storage** — an unreachable/unmigrated DB is an error condition. `server/services/memoryBackend.js` fails fast with an actionable message (`run npm run setup:db`) rather than serving a half-broken install. This no-silent-fallback behavior is intentional; do not "fix" it.

**Why file storage cannot be a supported mode:**

- **No creative-catalog / vector equivalent.** The catalog graph, memory similarity, and hybrid search depend on PostgreSQL + pgvector (HNSW vector search fused with `tsvector` full-text). There is no file-backed implementation of these — a file-backed install would serve a half-broken app the moment a user touched the catalog, memory search, or any `db-primary` Create domain. For the migrated Create domains (universes #1014, pipeline #1015, Story Builder #1016, Writers Room #1017, catalog refs #1018), any remaining file path survives **only** under this dev/test escape hatch.
- **Federation assumes Postgres.** Cross-machine sync (snapshot/push + last-writer-wins) and the `db-primary` sequence cursors/tombstones are designed around the database. A file-backed peer is not a supported member of a federation.
- **Backup assumes Postgres.** The backup/restore contract treats the `pg_dump` logical dump as **required system state** (see [Backup & Restore](./BACKUP.md)) — a file-backed install has no dump to capture or verify.

The escape hatch is **guarded from bitrot by the test suite** (tests boot with `NODE_ENV=test` and exercise the file backend), so the path stays runnable — but "the tests use it" is **not** an argument that it is a deployment option. It isn't.

### Setup path (`npm run setup:db`)

`npm run setup:db` → `scripts/setup-db.js` is the single command that makes PostgreSQL ready, and is wired into `npm run setup` and `npm start` so a normal install never has to think about it. Its happy path:

1. **Select the mode first.** For a fresh native install, set `PGMODE=native` in the repository-root `.env` before running setup. For an existing install, retain its authoritative backend; changing backends requires coordinated maintenance cutover, not a setup-time selection. An exported `PGMODE` overrides `.env` for this script; unset a conflicting shell value before retrying.
2. **`PGMODE=docker` (default):** reconciles the current `docker-compose.yml` service configuration with `docker compose up -d db` before accepting even an already-running `pgvector/pgvector:pg17` container. Compose applies changed loopback bindings and `PGPORT_DOCKER` mappings while preserving the named data volume, and reuses unchanged containers. Setup waits for TCP connections **and** the base `memories` table, then makes a bounded authenticated query for that table through the exact configured host endpoint (`PGHOST`, `PGPORT_DOCKER`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`) using the server workspace's `pg` driver, and only then reports ready. A role whose persisted password differs from the configured one, an unreachable host endpoint, or a missing driver fails setup non-zero (before `npm start` replaces PM2 apps) without touching the volume, role or backend, and without logging the password. It does not probe native PostgreSQL first. The host port defaults to `:5561` (`PGPORT_DOCKER` overrides it).
3. **Docker unavailable:** if Docker or Compose is missing, or the daemon is stopped, setup exits non-zero with restoration instructions, even when native PostgreSQL is healthy. Both interactive and unattended runs preserve `.env` and never offer a backend switch.
4. **`PGMODE=native`:** first checks whether the configured role can authenticate to the configured database and its base `memories` table exists. A healthy database exits immediately without re-provisioning. Otherwise it runs `scripts/db.sh setup-native` (Homebrew install, role, database, extensions, schema) and verifies readiness again. The endpoint defaults to `localhost:5432` (`PGHOST`/`PGPORT` override it, from the shell or `.env`). Both the provisioning script and the readiness probes use that same selected endpoint: an unavailable selected endpoint fails without sending SQL to any other cluster on the machine.
5. **Failure is non-zero exit.** A started-but-unresponsive container or a failed native bootstrap exits non-zero with an actionable message — so the `&&`-chained `npm start` halts here instead of crash-looping under PM2 against an unready database.
6. **The Docker image is digest-pinned.** `docker-compose.yml` (and the CI Postgres service) reference `pgvector/pgvector:pg17@sha256:<manifest-list digest>` — the readable tag plus the multi-platform (linux/amd64 + linux/arm64) index digest — so every install at one revision runs identical image contents and nothing pulls an unspecified newer image. Refresh only in a dependency-update PR: resolve the tag's index digest from the registry (`docker buildx imagetools inspect pgvector/pgvector:pg17`), confirm the index lists both architectures and its digest equals the SHA-256 of the manifest body, update both files together (`server/test/guards/repo/dbImageDigestPin.test.js` guards tag-only regressions), then verify a fresh start and an existing named volume both come up healthy with the base `memories` table, without replacing the volume.

**Mode selection does not migrate data.** Native and Docker PostgreSQL are separate databases; setup checks schema readiness, not whether one contains your existing records. Keep an existing install pointed at the database holding its data. Back up before an intentional move between modes (see [Backup & Restore](./BACKUP.md)).

`PGPASSWORD`/`PGUSER`/`PGDATABASE`/`PGHOST`/`PGPORT` are resolved from `process.env` first, then `.env`, then the backward-compatible defaults (`portos`/`portos`/`portos`/`5432`). The default `portos` password is an **intentional** local-development fallback (see the Distribution model note in [`AGENTS.md`](../AGENTS.md)); production deployments override it via `PGPASSWORD`.

**Compose receives the resolved values.** PortOS and PM2 read `.env` literally (matching surrounding quotes removed; no inline comments, no `$` expansion), but `docker-compose.yml` interpolates its `PGUSER`/`PGDATABASE`/`PGPASSWORD`/`PGPORT_DOCKER` with Docker's own `.env` grammar, which treats ` #` as a comment and expands `$`. So `npm run setup:db` and `scripts/db.sh` put the already-resolved values in the environment of every `docker compose` subprocess (process environment outranks Compose's `.env`), and the container is provisioned with exactly what PortOS connects with. They travel in the child environment only — never argv or logs. If you run `docker compose` yourself, Compose applies its own grammar to `.env`: wrap a password containing ` #` or `$` in single quotes (`PGPASSWORD='pa$$word'` — in Compose, single quotes are literal), or export the variables first.

### PostgreSQL version updates

**Settings › Software** lists the running server's version with the latest patch release and end-of-life date of its major line, read from [postgresql.org's release index](https://www.postgresql.org/versions.json). The row shows an update when a newer patch release exists, needs attention within a year of end of life, and shows a security state once the line is past end of life.

- **Patch (minor) releases need no data migration.** A minor release keeps the on-disk format. Native Homebrew: upgrade `postgresql@NN` and `pgvector` from the Homebrew section of **Settings › Software**, which marks an upgrade that would break the database (a pgvector release built only for newer majors removes the library `postgresql@NN` loads), restarts the server and checks that pgvector still loads, running `npm run setup:db` to rebuild it when it does not. **Hold** (`brew pin`) keeps a plain `brew upgrade` in a terminal from moving a package PortOS depends on, and **Check & repair** runs the same checks after a terminal upgrade. Docker: a dependency-update PR refreshes the pinned digest (step 6 above); after updating PortOS, `npm run setup:db` recreates the container on the existing volume. Upgrade the client tools (`psql`, `pg_dump`, `pg_restore`) of any other installed `postgresql@NN` kegs too. Read the release's "Updating" notes for any REINDEX it asks for.
- **A new major cannot open an older data directory.** `PINNED_DB_MAJOR` in `scripts/lib/dbImage.js` fixes the Docker image's major, and `server/test/guards/repo/dbImageDigestPin.test.js` fails if a digest refresh moves the tag. Changing the major must ship a dump/restore path for existing volumes in the same change. Native installs move by taking a backup that includes the database dump ([Backup & Restore](./BACKUP.md)), installing the new major, then restoring that dump into it.

### Moving between Docker and native

Use **Settings → Database** for coordinated backend migration, including
progress and recovery of an interrupted cutover. The legacy switch/migration
requests and `scripts/db.sh migrate`, `use-native`, and `use-docker` still refuse
before copying data or changing mode. Those former paths could accept writes
after the dump snapshot and strand them on the source; changing `.env` also
leaves the running server connected to its original pool.

`POST /api/database/maintenance/preflight` accepts explicit `source` and `target`
backend names through the ordinary instance authentication gate. It checks the
saved direction against the running pool and requires complete, trusted, idle
work state. A successful response is `{ source, target, advisory: true, accepted: false }`: it creates no operation, reserves no maintenance window, and does
not promise that a later request is safe. Cutover acceptance repeats
these checks under its final admission protocol. Both inspect the detached writer inventory against the process table and refuse pending, ambiguous, or orphaned writers before producer shutdown. Acceptance repeats the inventory check after draining publications, before creating the fence, and under the fence before taking coordinator ownership. An unsafe final check cancels the unowned operation when the saved source still matches. Missing/unreadable work state,
configuration drift, or an existing maintenance fence refuses the check.

The internal `stopOwnedDatabaseProducers` coordinator stage retains the original
PM2 CoS/server identities in the operation's local `producers.json`, stops CoS
before the server by numeric PM2 id, and verifies a fresh daemon read after each
stop. Missing/duplicate/foreign identities, changed live PIDs, unknown lifecycle
states, failed stops, or failed readback keep the operation fenced. Recovery
uses the same recorded operation and original identities; it never changes the
saved backend. Producer shutdown alone does **not** prove child/spawn quiescence
or authorize a dump. The internal transfer worker follows it with predecessor
and descendant reconciliation, then exports the recorded source and imports the
recorded dump into the recorded target (see [offline transfer](./DATABASE_MAINTENANCE.md#offline-transfer)).
The backend cutover API (`POST /api/database/maintenance/cutover`, `POST /api/database/maintenance/recover`, host-control gated) runs the whole verified lifecycle. The Settings database tab displays progress from the durable maintenance journal and offers Resume when the coordinator has exited; it reports success only after verifying the completed operation, not merely an accepted request or reconnect.

For stage diagnostics, run `node scripts/database-maintenance.mjs status` and
`node scripts/database-maintenance.mjs writers`. `accepted` means no transfer
has begun; `quiescing` requires retained producer and child reconciliation
evidence; `exporting`/`importing` report `transfer` dump/import state. Do not remove the fence, erase `producers.json`, probe a PID to infer
ownership, or reverse source/target. There is no user-callable resume or bypass
for the transfer stages. A same-operation internal successor requires
the prior detached supervisor's durable exit receipt and repeats shutdown
readback, predecessor and writer reconciliation before any export or import.

Keep the existing backend selected until you deliberately start a coordinated
cutover through Settings or the API. A safe cutover requires
downtime for **all** PortOS writers, including the CoS runner, and verification
that the restarted server actually uses the target. A server-only restart or
a saved-mode change is not that verification. Do not use Sync followed by Switch
as a migration workaround.

`scripts/db.sh setup-native` provisions native PostgreSQL without selecting it
or copying Docker data. Fresh-install setup still selects its configured mode. Preserve the backend holding your records. If an earlier
migration already ran, keep both databases and its dump intact: the old source
may contain writes missing from the target. Do not destroy either backend or
reverse the migration before comparing and recovering those records.
See [Backup & Restore](./BACKUP.md) for backup and restore semantics.

### Boot schema upgrades & lock windows

`ensureSchema()` in `server/lib/db.js` applies **idempotent** schema upgrades on every boot (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). Every index it creates — including the HNSW vector index and the GIN full-text index on `catalog_scraps` — is a plain, **non-`CONCURRENT`** build.

There is one Postgres per install, shared by every process that opens it (the server, `portos-cos`, and every CoS agent worktree), so two processes calling `ensureSchema()` at once is routine — most visibly when an update restart overlaps an outgoing server still shutting down with the incoming one. The DDL block is idempotent **within one session** but not atomic **across sessions**: the per-table audit triggers are installed as a `DROP TRIGGER IF EXISTS` / `CREATE TRIGGER` pair, and two interleaved sessions can both pass the `DROP` before either reaches `CREATE`, so the second `CREATE` throws "already exists" (#5977). `ensureSchemaImpl()` takes a dedicated client and holds a session-level `pg_advisory_lock` around the entire DDL block (upgrades + catalog) to serialize this cluster-wide; the lock is released in `finally` on both the success and throw path, and a dropped connection (a hard kill mid-boot) releases it automatically so a later boot is never blocked by a stale lock.

The **first** time a given index materializes on a table that **already holds many rows** (an existing install upgrading into a newly-added index), Postgres takes a `SHARE` lock that **blocks writes** (INSERT/UPDATE/DELETE) to that table until the build completes. So an existing install can see a one-time write stall at boot proportional to the table's row count — HNSW builds are the slowest. Fresh installs never see this: they build every index on an **empty** table, so the lock is effectively instant.

This is left as-is deliberately rather than switched to `CREATE INDEX CONCURRENTLY`, because `CONCURRENTLY` cannot run inside a transaction block, needs its own retry/cleanup path (a failed concurrent build leaves an `INVALID` index that must be dropped by hand), and roughly doubles build time — too fragile to run unattended on every boot for a stall that only bites large-table upgrades.

**If a future index must land on a table known to already carry a large row count on existing installs,** note that the standard db-migration runner (`server/scripts/run-db-migrations.js`) wraps every migration in a `withTransaction()` block — so `CREATE INDEX CONCURRENTLY` **cannot** run there either. It would have to be issued from a dedicated **non-transactional** path (a standalone maintenance script or manual step run outside any transaction), not from `ensureSchema()` or a standard db-migration.

A pre-v2 catalog upgrade rewrites `catalog_ingredients.search_tsv` in a one-time boot-time maintenance window; see [Catalog generated-column rewrite](./STORAGE_RECOVERY.md#catalog-generated-column-rewrite) before updating an install with a very large catalog.

---

## Adding a new data store? Answer these

Apply this checklist to **every new feature that persists data**, and require it in PR review. A new `data/*.json` store must *justify* itself against these questions — the default for app-native records is PostgreSQL.

- [ ] **Record the classification in the store module header; do not add a section here.** Add a ``Storage: `<class>` — <federation stance>. <why>.`` paragraph to the module that owns the store (after the one-sentence summary in cataloged directories). Operator recovery procedures go in [Storage Recovery](./STORAGE_RECOVERY.md).
- [ ] **Which class is it?** Tag the domain `db-primary`, `file-primary`, `asset-file-db-indexed`, or `ephemeral-file`. If you cannot pick one cleanly, the design is probably mixing concerns.
- [ ] **Does it relate to other records?** FKs, cross-record queries, "show everything related to X", graph edges → `db-primary`. Do not encode relationships as string ids across separate JSON files (they drift with no integrity check).
- [ ] **Does it need search?** Full-text or vector search → PostgreSQL (`search_tsv` / pgvector), not an app-level scan over JSON files.
- [ ] **If you chose a new `data/*.json`, why not the DB?** Acceptable reasons: large binary bytes (`asset-file-db-indexed` — index the metadata, keep bytes on disk), long externally-editable prose, an iCloud/file-sync workflow PortOS does not own, or genuinely transient runtime state (`ephemeral-file`). "It was faster to write a JSON file" is **not** acceptable for app-native relational records.
- [ ] **Bytes vs. pointer.** If binary assets are involved, confirm bytes stay on disk and the DB holds only an `asset_key` / `media_key` row + integrity metadata. Never store bytes in a column.
- [ ] **Federation.** If the record syncs to peers, does it have a per-table/per-record sequence cursor and tombstone strategy? (See `server/lib/schemaVersions.js`, `server/lib/syncWire.js`.) Cross-machine sync is first-class — see the Distribution model in [`AGENTS.md`](../AGENTS.md).
- [ ] **Migration.** On-disk/DB format changes need a migration in `scripts/migrations/` (applied-list tracked per install in `data/migrations.applied.json`). Seed fresh defaults in `data.reference/` only when appropriate: a migration deriving an output from existing records must ship no output seed, must gate on its input, and must declare the output in `scripts/lib/migrationOwnedPaths.js`. Other installs and other federated machines upgrade independently.
- [ ] **Backup coverage.** Will the new store be captured by backup? `db-primary` is covered by the Postgres dump; `file-primary` / `asset-file-db-indexed` by the rsync snapshot; `ephemeral-file` is correctly excluded (`DEFAULT_EXCLUDES`). Confirm the store lands in the right bucket. See [Backup & Restore](./BACKUP.md).

---

## See also

- [Backup & Restore](./BACKUP.md) — what gets backed up (data/ files + mandatory Postgres dump) and how restore works.
- [Storage Recovery](./STORAGE_RECOVERY.md) and [Database Maintenance](./DATABASE_MAINTENANCE.md) — operator recovery procedures.
- [`server/lib/README.md`](../server/lib/README.md) — storage helpers (`collectionStore`, `fileUtils`, `db.js`, `assetHash`).
