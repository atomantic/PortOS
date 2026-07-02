# Backup & Restore

PortOS backs up two things together, into a single timestamped snapshot:

1. **Filesystem data** — an rsync mirror of `./data/` (with SHA-256 manifest).
2. **PostgreSQL** — a `pg_dump` logical dump (`portos-db.sql`) written alongside the snapshot.

Now that PostgreSQL is a **required** dependency (it owns the creative catalog, memory, and a growing set of app-native records — see [Storage Classification Contract](./STORAGE.md)), **the database dump is part of required system state, not an optional extra.** A snapshot that captured `data/` but failed to capture the DB is incomplete, and PortOS surfaces that explicitly.

Implementation: `server/services/backup.js` (snapshot/dump/restore), `server/services/backupScheduler.js` (cron), `server/routes/backup.js` (API), and `server/routes/database.js` (DB export/sync).

## What gets backed up

A backup run (`runBackup` in `server/services/backup.js`) writes to:

```
<destPath>/snapshots/<hostname>/<snapshotId>/
├── data/             # rsync mirror of ./data/ (minus excludes)
├── portos-db.sql     # pg_dump logical dump
└── manifest.json     # SHA-256 of every data/ file AND ../portos-db.sql
```

- Snapshots are namespaced by `<hostname>` so one shared destination (e.g. an iCloud folder) can host backups from several federated machines without `snapshotId` collisions.
- The `manifest.json` hashes the SQL dump too (keyed as `../portos-db.sql`, since the dump lives one level above the `data/` tree), so a truncated or corrupt dump is detectable rather than silently trusted.

### What is excluded by default

`DEFAULT_EXCLUDES` (in `backup.js`) skips ephemeral/cache data and large re-downloadable assets — all anchored with a leading `/` (rsync filter syntax). Two tiers:

- **Non-overridable** (`overridable: false`): browser CDP profile, agent worktrees — caches with no irreplaceable user data; never backed up.
- **Overridable** (`overridable: true`): LoRA weight files, cloned repos, reference repos, browser downloads — re-downloadable; the user can opt back in from the Backup settings UI via `disabledDefaultExcludes`.

The effective exclude list is computed by the pure `computeEffectiveExcludes()` helper (unit-tested in `backup.test.js`). The scheduled cron handler in `backupScheduler.js` re-reads settings on every run, so `destPath`, `excludePaths`, `disabledDefaultExcludes`, and `enabled` all take effect on the next run without a restart.

## The Postgres dump is mandatory, not optional

`dumpPostgres()` runs `pg_dump --no-owner --no-acl --clean --if-exists` and returns an explicit status (no silent failure):

| Result | Meaning | Effect on backup |
|---|---|---|
| `{ status: 'ok', sizeBytes, tableCount }` | Dump succeeded and is non-empty | Backup `ok` |
| `{ status: 'failed', reason: 'pg_unreachable' \| 'pg_dump_missing' \| 'version_mismatch' \| 'dump_error' \| 'empty_dump' }` | Postgres is the active backend but the dump failed | Backup **`degraded`** + warning toast |
| `{ status: 'skipped', reason: 'not_configured' }` | The explicit file escape hatch is active — `MEMORY_BACKEND=file` or the backend resolved to `file` (dev/test, unsupported for production) | Backup stays `ok` (benign) |

Key behaviors, accurate to the code:

- **A failed dump degrades the whole backup.** `backupStatusForPg()` maps `failed → 'degraded'`; the run persists `pgBackup` into `data/backup/state.json` and emits a `BACKUP_DB_DUMP_FAILED` warning through the error pipeline — **even on unattended scheduled runs** (which pass `io = null`; the service falls back to the module-level `getIo()`).
- **A skipped dump is still benign** only for the temporary `MEMORY_BACKEND=file` escape hatch (documented as unsupported for production installs). On a normal install where Postgres is active or auto-detected, an unreachable DB returns `failed/pg_unreachable`, not a green "not configured" run.
- **`--clean --if-exists`** makes the dump replay cleanly into a live, already-initialized PortOS database — the common restore target — instead of erroring on `relation already exists`.
- A `pg_dump` that exits 0 but produces a 0-byte file is treated as `failed/empty_dump`; a non-zero exit deletes the partial file so a later restore can't trust a truncated dump.
- **`version_mismatch`** means no installed `pg_dump` is new enough for the running server (`pg_dump` aborts when older than the server it dumps — the common Homebrew case where an old `postgresql@NN` keg shadows a newer running server in `PATH`). `dumpPostgres()` reads the server's major version (`getServerMajorVersion()` in `lib/db.js`) and auto-selects the closest `pg_dump` whose major is `>=` the server from the installed Homebrew kegs / Postgres.app bundles. Set `PORTOS_PGDUMP=/path/to/pg_dump` to override the auto-discovered binary (e.g. on Linux/Windows where the keg locations don't apply).

## How restore works

Restore is two independent operations — restoring files and restoring the DB are separate decisions. Both are **dry-run by default** and validate `snapshotId` against path traversal before touching anything.

### Files — `restoreSnapshot()`

rsyncs `<snapshot>/data/` back to `./data/`. `dryRun: true` (the default) reports what would change without writing; an optional `subdirFilter` limits the restore to one subdirectory.

### Database — `restorePostgres()`

Replays the snapshot's `portos-db.sql` into the live database via `psql -v ON_ERROR_STOP=1 --single-transaction`, so the restore is **atomic**: it either fully applies or rolls back, never leaving a mixed snapshot/current state.

| Result | Meaning |
|---|---|
| `{ status: 'ok', dryRun, sizeBytes, tableCount }` | Dry-run report, or a successful real restore |
| `{ status: 'skipped', reason: 'no_dump' }` | No `portos-db.sql` in the snapshot (or 0 bytes) |
| `{ status: 'skipped', reason: 'not_configured' }` | Real restore requested but Postgres is unreachable — refuses to half-restore |
| `{ status: 'failed', reason: 'manifest_mismatch' }` | Snapshot's `portos-db.sql` hash disagrees with `manifest.json` — dump considered untrustworthy |
| `{ status: 'failed', reason: 'restore_error', error }` | `psql` replay failed (stderr captured) |

A non-dry-run restore requires a reachable DB first (`checkHealth()`), so a restore never half-applies against a down database.

### Backend export / sync — `POST /api/database/sync`

Separate from snapshot restore: `server/routes/database.js` can copy data **between** the native (port 5432) and Docker (port 5561) Postgres backends. It exports the active backend with `pg_dump`, ensures the target backend has the `portos` role/database/extensions, then imports under `ON_ERROR_STOP=1 --single-transaction`. `POST /api/database/export` produces an on-demand dump under `data/db-dumps/`. These power the Database settings tab's mode-switch/sync flows; they are independent of the rsync snapshot backups above.

## Scheduling & status

- Daily backups are driven by `backupScheduler.js` via the `backup-daily` cron event; `getNextRunTime()` reports the next run.
- `GET /api/backup/status` surfaces the persisted state including the last `pgBackup` outcome, so the Backup settings tab shows whether the last DB dump succeeded, its size, and table count.

## See also

- [Storage Classification Contract](./STORAGE.md) — which data lives in Postgres vs files (and therefore which half of a snapshot captures it).
- [`docs/superpowers/specs/2026-06-05-verified-pg-backup-design.md`](./superpowers/specs/2026-06-05-verified-pg-backup-design.md) — design rationale for verified, restorable DB backups.
