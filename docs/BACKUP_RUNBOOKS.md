# Backup and restore runbooks

Operator procedures that complement [Backup & Restore](./BACKUP.md): switching the
database backend, restoring a database snapshot, and restoring individual stores into
a running server. The backup contract itself (what is captured, excludes and tiers,
restore semantics, retention, scheduling) lives in BACKUP.md; the publication
admission mechanism that keeps snapshots consistent lives in
[BACKUP_PUBLICATION_ADMISSION.md](./BACKUP_PUBLICATION_ADMISSION.md).

## Database backend migration

Settings (Database tab) offers a coordinated offline cutover between Docker and
native PostgreSQL. It stops/drains every PortOS writer (including the CoS
runner), transfers the data, commits the new backend, restarts, and verifies
the restarted server's target connection before reporting success — the same
lifecycle `POST /api/database/maintenance/cutover` runs for automation (the
Settings tab submits that same request; it uses the ordinary instance
authentication gate). `scripts/database-maintenance.mjs` is **not** a complete
migration path: its `begin` command only admits a fence and starts nothing (see
[Database maintenance admission](#database-maintenance-admission) below).
`scripts/db.sh migrate`, `use-native`, and `use-docker` still refuse directly;
native setup provisions without selecting a backend. Do not substitute Sync
followed by Switch — that copies data without stopping writers or verifying
the restart, and can strand writes accepted after the snapshot.

Start and provision the destination PostgreSQL service before requesting a
cutover. Preflight and cutover acceptance use host `psql` with PortOS's
configured credentials to check that the destination accepts a connection to
the configured database. The read-only check also verifies that the session
allows writes and the role can use and create objects in the `public` schema.
If this check fails, correct the destination prerequisites and retry while the
source stays online. If the destination fails after acceptance, repair it and
resume the same recorded operation.

Expect brief downtime while PortOS restarts. The Database tab shows the
operation's stage (preparing, exporting/importing, restarting and verifying),
never reports success from an accepted request, a reconnect, or a saved-mode
change alone, and reconciles the outcome from the durable maintenance journal
on socket reconnect and page reload — because the server it is watching is the
one restarting. If the cutover worker exits before finishing, the tab shows an
interrupted state with a Resume control that continues the same recorded
operation; there is no rollback, force, or skip.

If a previous migration left records missing, preserve both backend databases
and the migration dump. The source may hold accepted writes absent from the
target; overwriting or deleting it can destroy that recovery copy. Compare and
recover the missing records before choosing an authoritative backend.
See [storage mode guidance](STORAGE.md#moving-between-docker-and-native).

### Explicit database endpoints for standalone transfers

Standalone exports and imports can bind all connection fields explicitly:

```bash
scripts/db.sh export --endpoint localhost 5432 example_user example_db recovery-copy
scripts/db.sh import --endpoint localhost 5561 example_user example_db data/db-dumps/portos-recovery-copy.sql
```

These commands require host `pg_dump` / `psql` and never fall back to a Docker
container or select a backend from saved mode. Use a `pg_dump` version compatible
with the source PostgreSQL server. The four endpoint arguments are host, port,
user, and database name; connection strings are not accepted as database names.
Supply credentials through `PGPASSWORD`, never as command arguments.
A failed export does not replace an existing dump.
Import retains the dump and uses one transaction with `ON_ERROR_STOP`.

An explicit endpoint only selects where a standalone transfer runs. Import
replaces database objects present in the dump: keep recovery copies and stop
the target's writers before restoring. These commands do not stop PortOS,
change saved mode, verify a restarted pool, or authorize a backend cutover —
use the coordinated cutover above (Settings Database tab, or the
authenticated `POST /api/database/maintenance/cutover` for automation) for
that. `scripts/database-maintenance.mjs` is admission-only and does not run it.

## Restoring an older database snapshot

Database restore is a **full replacement**, not a merge. It removes current
PortOS tables, functions and sequence state before replaying the snapshot,
including tables introduced after the backup. Current schema upgrades and
ordered migrations then recreate newer tables consistently without retaining
post-snapshot records. The public namespace's owner and permissions are retained.

Preview performs read-only ownership/object/dependency checks. Unknown objects
or external dependencies refuse the restore; the reset uses `RESTRICT`, never
an unrestricted cascade. Reset and dump replay share one PostgreSQL transaction
with `ON_ERROR_STOP`: a replay failure restores the previous rows and constraints.
Schema reconciliation follows the commit; a reconciliation failure explicitly
reports that replay committed and recovery still needs attention. Application
database operations drain before reset; new operations receive a temporary
maintenance error until replay and reconciliation finish (including failures).

## Restoring settings in a running server

Full live file restores and selective `settings.json` restores join the settings
write queue. Previously admitted mutations finish before transfer starts; later
mutations wait through transfer and cache reconciliation, then read the restored
file as their base. Partial transfer and reconciliation failures release the
queue while retaining the existing restore diagnostics. Malformed restored
settings still invalidate the cache rather than broadcasting empty defaults.
Dry runs and unrelated selective restores do not acquire this settings boundary.

A full live restore acquires boundaries in this order: shared snapshot cut
(asset publications drained), task schedule, settings, CoS configuration, CoS
runtime state, media model registry, Apple Health day-file admission. A
selective restore acquires the same order minus the boundaries its scope does
not touch; the snapshot cut is always held.
Each boundary stays held until everything inside it — transfer and cache
reconciliation, including after a partial transfer failure — has settled, so the
settings queue remains held through CoS reconciliation. The order is declared once
in `LIVE_FILE_RESTORE_OWNERS` (`server/services/backup.js`); insert a new
boundary there rather than nesting another wrapper. Snapshot integrity is
verified before any boundary is acquired, and a dry run acquires none of them.

The peer-execution identity fence is shorter-lived: it wraps only the rsync
transfer, never reconciliation, and only when the restore installs
`instances.json` (see [Federation identity is kept unless adopted](./BACKUP.md#federation-identity-is-kept-unless-adopted);
decided before verification, so a preview reports the same choice).

A restore callback must never call a queued settings write API; cache reload reads
directly and does not re-enter the queue.

## Restoring task schedules in a running server

Full live file restores, `cos` restores, and exact `cos/task-schedule.json`
restores join the schedule's existing write queue after the shared snapshot cut
and before settings/CoS ownership. Schedule mutations can consult CoS state, so
reversing that order could deadlock. Already admitted writes finish before
transfer; later writes read the restored schedule and preserve untouched task
settings, prompts, and templates.

The queue stays held through compatibility normalization and the schedule-change
notification, including after a partial transfer failure. Normalization reads
and saves directly inside that turn without re-entering the queue. Transfer
errors retain partial-overwrite diagnostics; reconciliation errors are surfaced
without discarding the transfer failure. Dry runs and unrelated scopes do not
acquire the schedule boundary.

## Restoring CoS files in a running server

A full live file restore or selective `cos` restore requires the CoS daemon and
Persistent Mind to be stopped and active agents to be finished or stopped. The
server rejects unsafe or unreadable ownership state before rsync starts, with
`COS_RESTORE_BUSY`. Pausing the daemon alone is insufficient.

The restore drains configuration writes, then runtime-state writes, and holds
both queues through the transfer and cache reload. Both CoS caches are reloaded
and the normal configuration-change event is emitted even after a partial rsync
failure. Subsequent partial settings saves preserve restored fields. Transfer
errors still report that files may have been overwritten; a cache-reload failure
requires restarting PortOS before using CoS. Dry runs and selective restores
outside the CoS state/config scope do not acquire this boundary.

## Restoring Apple Health day files in a running server

Full live file restores, `health` restores, and single-day `health/...` restores
own Apple Health mutation admission (`withLiveHealthRestore` in
`server/services/appleHealthIngest.js`). JSON ingest, XML import batch flushes,
and health archive capture and removal each take admission before their day's
write queue and hold it until that day's read-modify-write (or capture/removal)
settles, so no cycle can carry a pre-restore read across the transfer.

From the moment the restore is requested, new day cycles wait. Cycles already
admitted finish first; then rsync runs; then health caches are invalidated and
admission reopens — on success, partial transfer failure, or reconciliation
failure alike. Waiting imports then read the restored day files, so points the
snapshot recovered are preserved. An XML import takes admission per day, so a
restore can land between two of its days. Archival releases admission while
`tar` encodes; its hash-conditional removal retains any day whose bytes the
restore changed. Outside a restore, different days still import concurrently.
Health admission is acquired last, so a restore refused earlier (for example by
`COS_RESTORE_BUSY`) never pauses imports. Dry runs and unrelated selective
restores do not acquire it.

## Database maintenance admission

While the server is still running, `GET /api/database/maintenance/status` reads the journal without querying PostgreSQL or launching shell probes. It uses the ordinary instance authentication gate (authentication remains optional) and returns `{ stage: "idle", fenced: false }` when no operation exists, or the operation's `id`, `stage`, source/target mode names, and `fenced: true`. Connection identities and coordinator credentials are never returned. Responses are not cacheable; damaged or unreadable state returns HTTP 503 with `DATABASE_MAINTENANCE`, never idle. A `verified` stage alone still reports fenced: it does not authorize writers or prove admission has reopened. Once the server has stopped or its boot fence refuses startup, use the local status command below; this endpoint does not bypass the boot fence.

The persistent maintenance boundary is a prerequisite for coordinated offline migration (#8805). It does **not** migrate data, change saved mode, stop existing writer processes, or prove a target cutover. In particular, entering maintenance is not permission to invoke an uncoordinated SQL import or backend migration.

From the install root, inspect the journal with `status`. `begin` is a
**low-level, admission-only command — it does not start a migration.** It
immediately fences normal database work, launches no coordinator or worker, and
will never progress by waiting; `recover` cannot start it either, because
there is no coordinator to resume. Use Settings (Database tab) or
`POST /api/database/maintenance/cutover` to migrate. Run `begin` only when you
deliberately want the bare fence:

```sh
node scripts/database-maintenance.mjs status
node scripts/database-maintenance.mjs begin native docker
# Or, when the saved source mode is Docker:
node scripts/database-maintenance.mjs begin docker native
```

If an operation was created by `begin` alone (status shows stage `accepted`
and no `coordinator`), cancel it with the command below, using the unchanged
source configuration, before starting the complete cutover. The cutover is
refused while that ownerless fence exists.

The command returns the operation ID and direction. Plan for downtime: new pooled database operations, database administration mutations/exports, and CoS spawn admission are refused immediately, and both managed server and runner refuse normal boot while fenced. Admission is the synchronous fence check: work admitted just before publication may still obtain a connection or spawn afterward. Already-admitted transactions may finish; this boundary alone is **not a drained snapshot boundary**. The offline coordinator must still stop/drain all owned writers and validate live/spawning work before export. A process-local restore callback cannot bypass this persistent fence.

If no transfer has started and saved source configuration is unchanged, cancel using that exact ID:

```sh
node scripts/database-maintenance.mjs cancel <operation-id>
```

Cancellation supports only the initial accepted stage, preserves the journal in the machine-local cancelled archive, and never switches mode or reverses direction. Restart managed processes through the existing PM2 ecosystem workflow after cancellation if their normal boot was refused. CLI configuration follows the ecosystem's environment precedence; run from the same configured operator environment. Changed source configuration, a different operation ID, an unknown stage/version, and a competing operation are refused.

An incomplete publication or interrupted cancellation remains fenced. Do not remove the active directory, steal its cancellation claim, or guess a backend from `.env`: retain the journal for recovery. There is no rollback, force or skip command. Cancellation clears an ownerless `accepted` fence; `node scripts/database-maintenance.mjs recover <operation-id>` is a different case: it only resumes the same recorded, coordinator-owned operation (identity preserved) after its worker exited. The offline transfer, its retained `data/db-dumps/portos-maintenance-<operation-id>.sql` recovery dump, mode commit, verified restart and release are described in [offline transfer](DATABASE_MAINTENANCE.md#offline-transfer) and [mode commit, verified restart, and release](DATABASE_MAINTENANCE.md#mode-commit-verified-restart-and-release); Settings (Database tab) surfaces the interrupted state and its Resume control from the same journal. `data/database-authority.json` and `data/database-maintenance-completed/` are local records of a finished cutover. Snapshots keep them as recovery evidence, but a file restore never installs `database-authority.json` (see [Database authority is not restored](./BACKUP.md#database-authority-is-not-restored)), so restoring another machine's or an older backup can neither lift nor impose the retired-backend guard. Normal startup and migration must not be re-enabled by treating this preparatory operation as a completed cutover.

Coordinator stage publication uses immutable, atomically linked records. A same-operation retry with the existing owner token can confirm its last transition after a lost response; abandoned temporary files do not advance the stage, and a delayed retry cannot overwrite later progress. Interrupted claims from the older publication protocol still fail closed. This does not permit replacing a coordinator, reopening admission, or retrying SQL import: those require the offline recovery protocol.

## Verification-only server startup

The managed server entrypoint is `server/start.js`. Normal startup checks the
persistent fence before importing the application graph, so routes, migrations,
schedulers, and writer modules cannot initialize while maintenance is active.
The CoS runner retains its separate boot fence.

For an operation already at `verifying` or `verified`, a recovery operator can
run a read-only target diagnostic from the intended target launch environment:

```sh
node server/start.js --verify-database <operation-id>
```

Supply the recorded target's `PGHOST`, `PGPORT`, `PGUSER`, and `PGDATABASE` through
that environment, and credentials through `PGPASSWORD`. This direct Node command
does not load `.env`; use the same resolved values the PM2 ecosystem would pass
to the server. It checks the actual pool's captured connection settings against
the recorded target before checkout, then checks database/user identity and the
required memory/catalog schema in one read-only transaction. A stale source
port, wrong operation, earlier stage, unavailable database, incomplete schema,
or changed/damaged journal refuses the diagnostic. Raw connection errors and
credentials are omitted from its response.

Success returns `targetHealthy: true` and `fenced: true`, then closes the pool
and exits. Repeating the command repeats the probe without changing any journal
stage. It never imports the application, clears the fence, rewrites saved mode,
or resumes writers. This is **not completed cutover or proof of a later ordinary
restart**. The offline coordinator still must own shutdown/drain, transfer,
interruption recovery, and a verified admission-release handshake (#8816).
Do not advance journal stages manually to make this diagnostic run; unsupported
or damaged operations must stay fenced with both database copies preserved.

## Restoring the media model registry in a running server

A full live file restore or a selective `media-models.json` restore fences the
cached media registry (`withLiveMediaModelsRestore` in `server/lib/mediaModels.js`).
From the moment the restore is requested, availability toggles, adds, patches and
removes are refused with `MEDIA_MODELS_RESTORE_BUSY` before any disk or cache
change; competing restores are serialized. After the transfer — including a
partial rsync failure — the registry is reloaded from the resulting file before
the fence is released, so a later toggle can no longer write the pre-restore
registry back over the restored one. If the reload cannot read the file, edits stay
refused with `MEDIA_MODELS_UNAVAILABLE` until a later restore reconciles it or
PortOS restarts. Dry runs and unrelated selective restores do not acquire this
boundary.

Code Animation [Film projects](CODE_ANIMATION_PACKAGES.md#film-projects) use the
same split: authored `data/code-animation/films/<id>/src/`, `manifest.json` and
`song.json` are backed up alongside the Production PostgreSQL record. The
anchored, overridable `/code-animation/films/*/renders/` exclusion omits
regenerable output. An accepted final is copied to `data/videos/` and remains
covered by media backup even when workspace renders are excluded.
