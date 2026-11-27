# Storage classification and recovery

PortOS requires PostgreSQL on every install and peer. The filesystem holds external documents, large asset bytes and local operational state. A store declares its class and federation stance in its owning module's `Storage: ` header. Search those headers or use `node scripts/lib-catalog.js <term>` for the inventory.

## The four storage classes

| Class | Authority | Use |
| --- | --- | --- |
| `db-primary` | PostgreSQL | App-native records, relational queries, search, lineage, sync cursors and tombstones. |
| `file-primary` | Filesystem | Externally editable or synced files, or machine-local records needed before DB startup. The DB may index the file. |
| `asset-file-db-indexed` | File bytes, database metadata | Large media and model assets. Reference them by stable asset key and store integrity metadata. |
| `ephemeral-file` | Filesystem | Regenerable caches, uploads and transient staging. A durable job record can reference its ephemeral staging. |

Keep durable writes atomic and serialize overlapping writers. Record what is backed up, restored and federated at the owning boundary. Keep federation opt-in and allowlisted. Preserve machine-local secrets and authority across restores. Describe compatibility and migration for existing installs. See [Backup & Restore](BACKUP.md) and [the PostgreSQL ADR](decisions/2026-06-07-postgres-as-primary-datastore.md).

## PostgreSQL is required

Default Docker PostgreSQL listens on port 5561. Native PostgreSQL defaults to 5432. `PGMODE` selects the backend. Nonempty shell settings take precedence over repository-root `.env`. Docker uses `PGPORT_DOCKER` for the published endpoint. Native uses `PGPORT`. Managed processes and setup resolve the same selection. `MEMORY_BACKEND=file` is a dev/test escape hatch for tests that do not need DB-backed features. Run DB suites only through `npm run test:db` against `portos_test`.

### Setup path (`npm run setup:db`)

Run `npm run setup:db` for the selected backend. Normal setup and startup already run it. Fresh native installs set `PGMODE=native` before setup. Existing installs retain the backend holding their data until a coordinated cutover.

- Docker setup reconciles Compose and verifies the exact configured host endpoint and schema with the app driver. It preserves the named volume. An unavailable Docker daemon, invalid authentication or unreadable endpoint fails setup without choosing native. Docker repair refuses if the existing container and resolved Compose data volume disagree.
- Native setup verifies the configured endpoint and provisions the native role, schema and extensions as needed. `scripts/db.sh setup-native` provisions without switching an existing installation.
- Keep the intentional `portos` development password fallback. Set `PGPASSWORD` in production. Setup passes credentials through the child environment and binds probes against libpq environment overrides. Explicit maintenance endpoints strip inherited connection overrides.
- Patch updates preserve the major's disk format. Check native pgvector compatibility or the current pinned Docker image. A major upgrade needs a logical backup and a compatible restore path. Image digest updates must preserve the pinned DB major unless the change also delivers the upgrade path.

## Moving between Docker and native

Use **Settings → Database** for cutover. Changing `PGMODE`, restarting a single process or running legacy `db.sh` switch commands cannot safely move a live install. The databases are separate. Keep both and the logical dump until the target is verified.

Preflight is advisory. Acceptance repeats readiness and writer-inventory checks under the final admission fence, retains the original PM2 producer identities and stops CoS before the server. The machine-local `data/database-maintenance/operation.json` binds the operation and source/target identities without storing credentials. Missing state is idle. Invalid, unreadable or newer-version state keeps admission fenced.

### Offline transfer

The owned worker verifies predecessor and detached-writer quiescence before transferring offline. Stages are accepted, quiescing, exporting, importing, committing, verifying and verified. The exported dump is `data/db-dumps/portos-maintenance-<operation-id>.sql`; its immutable receipt binds the operation, source, size and SHA-256. Import verifies that receipt and uses one target transaction. The import receipt binds the committed result to the target. Recovery retries the same recorded source, target and operation. It never assumes a dump or import ran based on stage or PID alone.

A cutover installs the new configuration and starts verification-only server startup. The current PM2 server must prove its own pool matches the target and can read the schema, with proof bound to process identity. Only then can the coordinator write `data/database-authority.json`, move the journal into the completed directory and reopen admission. CoS restarts last if previously running. The old source is retained as a recovery copy. A managed process still pointed at the retired source refuses with `DATABASE_RETIRED_BACKEND`. Reload that process from the saved configuration. To move back, use another coordinated cutover.

The cutover import replays the restricted migration that removes retired native-usage tables. If an earlier cutover left those tables and a snapshot restore flags them, confirm the active endpoint and apply only the matching migration script to that endpoint. Resolve any reported dependencies before retrying, then run the restore dry-run again.

```sh
bash scripts/db.sh import --endpoint <host> <port> <user> <database> server/scripts/db-migrations/030-drop-retired-native-usage-tables.sql
```

### Cutover recovery

Inspect `node scripts/database-maintenance.mjs status` and `node scripts/database-maintenance.mjs writers`. The Settings panel offers Resume after a recoverable coordinator exit. After fixing the reported cause, use `node scripts/database-maintenance.mjs recover <operation-id>` to resume the same operation. A successor needs its predecessor's durable supervisor exit and verified writer quiescence. On platforms without required process-group proof, recovery can stay fenced. For verification failures, check the saved target endpoint and the bounded diagnostic in `pm2 logs portos-server`. Preserve operation files, process proofs and authority records. Deleting the fence risks concurrent writers or a stale backend.

## Workflow maintenance journal

Graceful maintenance uses machine-local `data/workflow-maintenance/state.json` to fence admission in the API and CoS runner before DB access. Its holds and reservations survive restart. Invalid state and interrupted transactions fail closed. Backups copy the subtree as evidence and restores preserve the running machine's copy.

A hold waits for admitted work and owned publications to settle. Queued work can remain queued. Loss of a peer, age or a dead PID alone does not prove a save. A waiting updater can disposition positively identified inactive ordinary reservations, recording unknown output. Release candidates, unclear ownership and exclusive maintenance stay bound to their own recovery paths.

### Interrupted maintenance transactions

Inspect the maintenance status and logs, then fix the reported disk or I/O problem. Stop PortOS and any standalone producer using the journal before running the recovery command from the install directory.

```sh
pm2 stop portos-server portos-cos
node scripts/ops/recover-maintenance-transaction.mjs --confirm "Inspected interrupted transaction and resolved disk problem"
pm2 start portos-server portos-cos
```

Use the actual recovery reason. From a reviewed isolated checkout, point `PORTOS_DATA_ROOT` at the install root. Recovery refuses live or unreadable ownership and invalid journal state. It retains original state and transaction evidence and preserves any existing hold. If it creates a Transaction recovery hold, inspect remaining blockers. To disposition reservations, resume previous policies and establish a normal operator hold, then wait for any work admitted during handoff. Keep damaged or incompatible journal evidence for repair.

### Operator disposition of inactive reservations

Use a normal operator maintenance hold and wait for running work to settle. Inspect exact owned work before changing its reservation.

```sh
umask 077
node scripts/ops/reconcile-maintenance-reservations.mjs inspect --install-root /absolute/path/to/PortOS --reason "Reviewed inactive work" > /tmp/portos-reservation-request.json
# Review the request and retain only the operations actually inspected.
node scripts/ops/reconcile-maintenance-reservations.mjs reconcile /tmp/portos-reservation-request.json --install-root /absolute/path/to/PortOS --confirm-disposition
```

Keep request files private. Inspection and reconciliation verify the current hold, journal revision, work activity and process ownership. An accepted disposition records unknown output and leaves job outcomes and outputs alone. Use the same verified request when recovering a receipt-first interruption. Preserve exclusive owners, live work, unclassifiable records and release evidence.

### Unsettled generic output publications

Generic reservations lack exact run or destination identifiers. Use the [backup consistency guide](BACKUP.md#backup-or-restore-blocked-by-a-publication) to trace the owning writer and bind the selected reservation to exact record and output or failure evidence. For CoS and toolkit runs inspect run metadata, spools or durable warnings. For media inspect the exact job, expected asset and sidecar/history or failure record. A terminal job or provider result alone cannot prove local publication.

Recover the publication through its owning service if its output or ownership is unresolved. If the inactive-reservation inspection offers the exact record after that investigation, reconcile only that record using the inspected request above. Keep the evidence and request private. A disposition cannot clear transcript warnings or certify saved output.

## Retrying incomplete legacy creative imports

Malformed or unparkable source data keeps the domain import incomplete. Repair the source or filesystem issue and restart. Existing PostgreSQL rows retain precedence. Preserve canonical files, parked recovery copies and completion markers.

For old installs with a premature completion marker, use the explicit recovery script. The default is a read-only inventory. Preview a selection and apply those exact IDs only after reviewing the result.

```sh
node server/scripts/recoverLegacyImports.js
node server/scripts/recoverLegacyImports.js --id series:ser-example --id issue:iss-example
node server/scripts/recoverLegacyImports.js --id series:ser-example --id issue:iss-example --apply
```

Restore parents and drafts by explicit ID. The script reads canonical and parked sources and inserts only missing records, preserving existing and soft-deleted rows. Recover pruned artifacts from a backup first.

## Catalog generated-column rewrite

Upgrading a pre-v2 catalog rebuilds the stored `catalog_ingredients.search_tsv` column and GIN index at startup. Expect a size-dependent lock window. For large catalogs, back up first, stop other local DB writers, and allow the normal update and startup to finish before resuming. An interrupted startup can retry the schema upgrade. Fresh and already upgraded catalogs skip the data rewrite.

## Codex image usage backfill

This explicit import scans local image sidecars and completed job metadata. It never runs on boot or reads provider sessions.

```sh
node scripts/ops/backfill-codex-image-usage.js --data-dir <install>/data --report <private-plan.json>
node scripts/ops/backfill-codex-image-usage.js --data-dir <install>/data --apply <private-plan.json> --journal <private-journal.json>
```

Review coverage before applying. A changed source inventory requires a new plan. Use new paths for plan and journal. Missing attribution, costs and execution-machine evidence stay unknown. Keep the journal to identify exactly the receipts inserted by its batch. Existing live receipts, sidecars and queue history stay intact.
