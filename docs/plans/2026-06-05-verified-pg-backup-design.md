# Verified, Restorable PostgreSQL Backups — Design

**Date:** 2026-06-05
**Branch:** `feat/verified-pg-backup`
**Status:** Approved design, pending spec review

## Problem

PortOS treats PostgreSQL as an **optional accelerator** for vector/search-heavy
data: the memory system (`memoryBackend.js`) switches between `memoryDB.js`
(Postgres + pgvector) and `memory.js` (JSON files) via `MEMORY_BACKEND` or
auto-detect, and `ecosystem.config.cjs` ships a `pgMode='file'` that runs with
no database at all. The creative-ingredients catalog also lives in Postgres
(pgvector). Everything else is file-based by design.

The rsync backup copies `data/`, but Postgres' Docker data lives in a **named
volume** (`portos-pgdata`), outside `data/`. `runBackup` *does* call
`dumpPostgres()` to produce a `portos-db.sql` alongside the snapshot — but four
gaps make "we have a backup" misleading the moment Postgres holds real data
(which it already does: memory + catalog):

1. **Silent skip is indistinguishable from success.** `runBackup` and
   `backupScheduler` both swallow the result:
   `dumpPostgres(...).catch(() => ({ success: false }))`. A missing `pg_dump`
   binary, auth failure, or dump error still reports `status: 'ok'` with a
   green file count. The user gets no signal the DB wasn't captured.
2. **The dump is not verified or hashed.** `generateManifest()` hashes only the
   `data/` tree; `portos-db.sql` sits outside it. A 0-byte or truncated dump
   looks identical to a good one.
3. **No DB restore path.** `restoreSnapshot()` only rsyncs `data/` back. There
   is no `psql`-based counterpart, so restoring the DB is a manual, undocumented
   step — improvised at the worst possible moment.
4. **The UI never surfaces DB-backup status.** `BackupTab` shows file-snapshot
   info only; nothing tells the user whether the last DB dump succeeded, its
   size, or its age.

This design closes all four. It is **backup-mechanism only** — no on-disk
`data/` format change, no data migration, and Postgres stays optional
(`skipped` is a first-class, benign outcome).

## Non-goals

- Moving Brain / Messages / other file stores into Postgres (separate, larger
  decision; this work is a prerequisite for evaluating it, not part of it).
- Making Postgres a required dependency.
- Physical volume-level backup of `portos-pgdata` (rejected: corruption-prone on
  a running DB, version-locked, not restorable across PG versions — `pg_dump`
  logical backup is the correct mechanism).

## Design

### 1. Dump outcome classification (`dumpPostgres` in `backup.js`)

Replace the `{ success: boolean }` return with an explicit status, applying the
project's sentinel discipline (absent ≠ failed ≠ ok):

```js
{ status: 'ok',      sizeBytes, tableCount, path: 'portos-db.sql' }
{ status: 'skipped', reason: 'not_configured' }                       // benign (file mode)
{ status: 'failed',  reason: 'pg_dump_missing' | 'dump_error' | 'empty_dump', error }
```

- `checkHealth()` already distinguishes `connected`/`hasSchema`. When not
  connected or no schema → `skipped/not_configured` (legitimate in file mode).
- After a `code === 0` dump, **verify**: `stat` the output. 0 bytes or missing →
  `failed/empty_dump` (catches truncated/auth-quirk dumps that still exit 0).
- `tableCount` is derived by counting `CREATE TABLE ` occurrences in the dump
  (cheap, single pass; informational only — not a gate beyond the >0-byte check).
- `proc.on('error')` (pg_dump not installed) → `failed/pg_dump_missing`
  (no longer silent).
- Non-zero exit → `failed/dump_error` with captured stderr.

### 2. Backup state & status propagation (`runBackup` in `backup.js`)

Rule: **`failed` degrades the backup; `skipped` does not.**

```js
const pgResult = await dumpPostgres(pgDumpPath);   // no result-swallowing .catch
const status = pgResult.status === 'failed' ? 'degraded' : 'ok';
await saveState({
  lastRun, lastSnapshotId: snapshotId, status,
  filesChanged: changedFiles.length,
  pgBackup: pgResult,                                  // persisted for /status + UI
  error: pgResult.status === 'failed' ? `DB dump ${pgResult.reason}` : null
});
```

- New overall status value **`'degraded'`**, distinct from `'ok'` and `'error'`:
  files backed up fine, DB dump failed. Not a full `'error'` (the file rsync
  succeeded), but not clean either. This is the signal missing today.
- **`pgBackup`** block persisted in backup state so `GET /api/backup/status`
  surfaces the last dump outcome with no re-run.
- **Manifest**: `generateManifest` gains the snapshot's `portos-db.sql`
  hash + size so the dump is integrity-checked like every other file. (The sql
  file lives one level up from the `data/` dir the manifest currently walks; the
  function will hash it explicitly in addition to the `data/` tree.)
- **Scheduler parity**: `backupScheduler.js` calls the same `runBackup`, so it
  inherits degraded status automatically.

### 3. Degraded notification (`runBackup`)

On `failed`, emit through the existing error pipeline so `useErrorNotifications`
toasts it — including on unattended scheduled runs (which call `runBackup` with
`io = null`):

```js
if (pgResult.status === 'failed') {
  const io = ioArg || getIo();          // getIo() returns socket.js ioInstance
  if (io) emitErrorEvent(io, new ServerError(
    `Backup DB dump failed: ${pgResult.reason}`,
    { status: 500, code: 'BACKUP_DB_DUMP_FAILED', severity: 'warning' }
  ));
}
```

- Reuses `emitErrorEvent` (`server/lib/errorHandler.js`) →
  `error:occurred` / `error:notified` → existing client toast hook. No new
  client code for the alert.
- `severity: 'warning'`, not `critical` — files did back up; this is a
  degradation, not an outage (so it does NOT hit `system:critical-error`).
- Requires a `getIo()` accessor exported from `socket.js` (it holds
  `ioInstance` module-locally). If one is not already exported, add a minimal
  `export function getIo() { return ioInstance; }`. Falls back gracefully:
  if no io is available, the degraded state is still persisted and surfaced in
  the UI on next view.

### 4. DB restore counterpart (`restorePostgres` in `backup.js`)

Add the missing half of restore. Dry-run by default, mirroring
`restoreSnapshot`:

```js
export async function restorePostgres(destPath, snapshotId, { dryRun = true } = {}) {
  // 1. Validate snapshotId with the SAME path-traversal guard as restoreSnapshot
  //    (regex + path.relative containment check against the snapshots root).
  // 2. Resolve <snapshotsRoot>/<snapshotId>/portos-db.sql.
  // 3. If the sql file is missing → return { status: 'skipped', reason: 'no_dump' }.
  // 4. checkHealth() must be connected before a real restore; if not →
  //    return { status: 'skipped', reason: 'not_configured' } (never half-restore).
  // 5. dryRun → stat + report { willRestore: true, sizeBytes, tableCount };
  //    do NOT touch the live DB.
  // 6. real → spawn psql -h/-p/-U/-d portos -f <sqlPath> (PGPASSWORD via env,
  //    same as dumpPostgres). The dump was written with --no-owner --no-acl so
  //    it replays cleanly. Return { status: 'ok', tablesRestored }.
}
```

- **Separate endpoint, not coupled** to file restore: restoring files and the DB
  are independent decisions.
- Refuses a non-dry-run when PG is unreachable (no half-restore).

### 5. Route changes (`server/routes/backup.js`)

- `GET /api/backup/status` already spreads backup state, so the new `pgBackup`
  field flows through automatically — no route change needed there.
- New: `POST /api/backup/restore-db` → validate with a new
  `restoreDbRequestSchema` (`{ snapshotId: string.min(1), dryRun: boolean
  .optional().default(true) }`) in `server/lib/validation.js`, call
  `backup.restorePostgres(...)`.

### 6. UI surfacing (`client/src/components/settings/BackupTab.jsx`)

Fed by the `pgBackup` field now in `/status`:

- **Database Backup status block** showing the last-run dump outcome:
  - `ok`      → `DB: ✅ 240 KB · 6 tables`
  - `skipped` → `⏭️ Not configured (file mode)` (neutral, not an error)
  - `failed`  → `❌ Dump failed: <reason>` in `port-warning`
- A `degraded` overall status renders a warning banner (`port-warning`) instead
  of the green "files changed" success after a run.
- The snapshots list shows a small per-snapshot DB badge (dump present + size,
  read from the manifest).
- A **Restore DB** action per snapshot: calls `restore-db` dry-run first, shows
  what would restore, then a confirmation **modal** (per the project's
  no-`window.confirm` rule) to execute the real restore. New API wrapper
  `restoreDatabase(...)` in `client/src/services/api.js` (silent option, since
  the UI owns its own error toast).

## Error handling

- All child-process work (`pg_dump`, `psql`) is outside the Express request
  lifecycle, so it is wrapped per the project convention: resolve a status
  object rather than throwing across the `spawn` boundary; `proc.on('error')`
  and non-zero exits map to `failed` reasons.
- `restorePostgres` validates `snapshotId` against path traversal identically to
  `restoreSnapshot` before touching the filesystem.
- A missing `getIo()` / null io never throws — the degraded state is persisted
  regardless; the toast is best-effort.

## Testing (`server/services/backup.test.js`)

Mock `spawn` and `checkHealth`. Assert:

- `dumpPostgres` → `skipped/not_configured` when `checkHealth` reports
  disconnected or no schema.
- `dumpPostgres` → `failed/pg_dump_missing` on `proc.emit('error')`.
- `dumpPostgres` → `failed/empty_dump` when exit 0 but the output file is 0
  bytes.
- `dumpPostgres` → `failed/dump_error` on non-zero exit (stderr captured).
- `dumpPostgres` → `ok` with `sizeBytes`/`tableCount` on a good dump.
- `runBackup` sets overall status `degraded` ONLY on `failed`; `skipped` and
  `ok` both yield `'ok'`.
- `runBackup` persists the `pgBackup` block into state.
- `generateManifest` (or `runBackup`) includes `portos-db.sql`'s hash.
- `restorePostgres` dry-run reports size/tableCount without invoking `psql`;
  refuses a real restore when `checkHealth` is disconnected; returns
  `skipped/no_dump` when the sql file is absent.

## Out-of-scope follow-ups (capture in PLAN.md if deferred)

- Retention/pruning of old `portos-db.sql` dumps (currently snapshots accrue;
  not changed here).
- Per-table selective restore.

## Dependencies

None added. Uses the existing `pg_dump` / `psql` binaries via `spawn`, and the
existing `pg` pool only for `checkHealth`. Consistent with the project's
write-it-ourselves dependency rule.
