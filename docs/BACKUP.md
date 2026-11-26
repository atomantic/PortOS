# Backup & Restore

Use **Settings → Backup** to save a destination, schedule backups, run one
manually, download a snapshot, or restore its database. The dashboard's
**Backup** widget restores files. Each snapshot combines a copy
of `data/` and a PostgreSQL dump. Keep the destination on storage that will
survive the loss of this install. Treat it as private because both parts can
contain personal records and credentials.

Backup configuration, manual runs, downloads, deletion, and restore require
operator authority. With authentication enabled, use a verified human or
delegated agent session. With authentication off, these actions require a
genuine local connection. Scheduled runs use the saved operator settings.

## Set up and check backups

1. Set and save the destination in **Settings → Backup**. Enable the schedule
   and choose a time in your configured timezone. A saved destination with no
   explicit schedule defaults to midnight. Clearing the destination or
   disabling backups stops scheduling. Saved changes take effect immediately.
2. Run a manual backup after saving. Check that the run completed and the
   PostgreSQL dump succeeded. A **degraded** run can leave usable files, but
   check its warning before relying on it. A failed dump cannot recover
   database records. **Last successful run** tracks the latest complete
   snapshot even when a newer attempt fails.
3. Check retention. New installs keep 30 eligible snapshots by default.
   Existing configurations without a limit keep all completed snapshots.
   Only a healthy run prunes, and only in this machine's namespace. Pruning
   skips snapshots being read and can clear older interrupted runs even with
   Unlimited retention. Deleting a snapshot from history is permanent.

### What a snapshot contains

Look under `<destination>/snapshots/<hostname>/<snapshotId>/` for `data/`,
`portos-db.sql`, and `manifest.json`. The manifest records checksums for
both the files and the SQL dump. Older snapshots may sit directly under
`snapshots/`. On a shared destination, use the source shown in history to
distinguish snapshots taken at the same time on different machines.

The Backup tab shows the default exclusions and which can be turned off.
Worktrees, browser profiles, and some caches are always excluded. Cloned
repositories, downloads, intermediate training checkpoints, and film workspace
renders are examples of exclusions you can turn off. Deployed LoRA weights,
authored film sources, and published CoS terminal recordings are included by
default. Review [Storage](STORAGE.md) for where specific records live.

Additional Exclude Paths still apply when a default exclusion is turned off.
PortOS anchors a plain pattern at the root of `data/`, so `cache/` applies
to `data/cache/`. Use `**/cache/` only when you intend to exclude directories
with that name at any depth.

### If the database dump fails

Check PostgreSQL connectivity and the reported dump error. The backup needs
a `pg_dump` client at least as new as the server's major version. PortOS
can discover clients in Homebrew and Postgres.app. Set
`PORTOS_PGDUMP=/path/to/pg_dump` in the server environment if you need to
select one explicitly. After fixing the cause, run another backup and
confirm it includes the dump.

## Restore files

1. Open the dashboard's **Backup** widget and select the snapshot by source
   and date.
   Choose the whole file tree or a path relative to `data/`. Preview the
   scope and check which existing files may be overwritten.
2. Address any preview warnings before confirming. PortOS verifies the
   selected files against the manifest when one exists. An older backup
   without a manifest is shown as unverified. A corrupt manifest or a
   checksum mismatch blocks the restore. Failed, incomplete, and
   interrupted snapshots cannot be restored through the UI.
3. Confirm the file restore. It overwrites matching files and keeps live
   files absent from the snapshot. A transfer error can leave a mix of old
   and restored files. Check the reported transfer and reload errors before
   putting the affected features back into use.

### Restore individual stores while PortOS is running

Use the smallest scope that covers what you need. A full file restore is
subject to the same requirements as the individual stores below.

| Scope | Before and after confirming the preview |
| --- | --- |
| `settings.json` | Wait for the restore to finish before making further edits. PortOS lets admitted saves finish before copying and reloads its settings cache before queued saves continue. |
| `cos` | Stop the CoS daemon and Persistent Mind, then finish or stop active agents. Pausing the daemon alone is insufficient. PortOS reloads CoS configuration and runtime state after the transfer. Restart PortOS before using CoS if either reload fails. |
| `cos/task-schedule.json` | Use this exact path to recover schedules alone. Queued schedule edits continue against the restored file after it has been normalized and the new schedule is published. |
| `health` or one day under `health/` | Let the restore finish before checking the recovered days. PortOS drains admitted day writes, invalidates its Health caches, and then lets waiting imports continue. |
| `media-models.json` | Wait for the restore to finish before editing the registry. If the registry reload fails, edits remain unavailable until a successful restore or a restart reloads it. |

### Federation identity is kept unless adopted

When the snapshot belongs to a different federation identity, file restore
keeps the current `data/instances.json`, including its pair credentials.
Use **Adopt the snapshot's identity** only when replacing a retired machine.
Preview again after changing that option. A restore that installs peer
settings can interrupt peer activity while those settings are replaced.

### Database authority is not restored

Machine-local authority records, including `data/database-authority.json` and
peer execution authority, stay with the destination install. File restore
also preserves the destination's active database maintenance and restore
recovery journals. Some snapshots contain machine-local records as recovery
evidence. See
[Database Maintenance](DATABASE_MAINTENANCE.md) for cutover and recovery.

## Restore PostgreSQL

1. Keep a current complete backup before replacing database contents. Select
   **Restore DB** in **Settings → Backup** for the same source and date if you are recovering
   both halves of an install. File and database restore are independent.
2. Preview the database restore. PortOS checks the dump, its checksum when
   available, and the target database. If the restore cannot find `psql`,
   install a compatible PostgreSQL client or set
   `PORTOS_PSQL=/path/to/psql` in the server environment. If the target
   version check fails, fix connectivity or version access and preview again.
3. Confirm when ready for a **full replacement** of PortOS database contents.
   Current records and tables absent from the dump are removed. The reset
   and replay happen in one transaction. After replay, PortOS upgrades the
   schema and repairs peer sync state before reopening normal database work.
4. If **Resume recovery** appears in the Backup tab, use it to finish the
   recorded restore. A replay can commit before repair finishes. Leave the
   recovery journal in place and preserve the dump and logs. If the journal
   is unreadable or the commit outcome is unknown, keep database writes
   fenced while investigating the restore status and logs.

### Restore an older snapshot

An older dump can replace a newer PortOS database. Preview checks for
unexpected objects and dependencies before reset. If it refuses, inspect the
reported objects before proceeding. After replay, the current schema
upgrades recreate newer tables.

If file restore reports `BACKUP_LEGACY_DB_METADATA`, keep the original
snapshot intact. Stage its historical files and matching dump, when
available, in a disposable offline install on a compatible historical
version. Stage both before running upgrades that import the legacy records.
Upgrade that copy and make a fresh snapshot to preview on the destination.
Snapshots with the old file-based AI usage ledger need their files in place
before database recovery so the upgrade can import it.

## Backup or restore blocked by a publication

PortOS briefly pauses new asset publications and waits for admitted work
before capturing a database and file snapshot or restoring one. If a backup
is already running, wait for it to finish and retry. For a persistent
`backup_snapshot_busy` error, use the owner details from the error and the
procedure below.

The shared consistency boundary is implemented in
[backupSnapshotBoundary.js](../server/lib/backupSnapshotBoundary.js) and the
publisher inventory lives in
[backupAssetOwners.js](../server/lib/backupAssetOwners.js), with coverage in
[backupAssetOwners.test.js](../server/lib/backupAssetOwners.test.js).
These sources describe which changes are coordinated with snapshot cuts.

### Interrupted ownership recovery

1. Record the blocking owner's ID, PID, generation, timestamp, and path.
   Stop both the PortOS server and CoS runner, along with any other writers
   for the affected data.
2. Match the owner to the logs, inspect the affected files and records, and
   finish or roll back that publication. For an interrupted restore, also
   settle any required cache, index, and database recovery. A failed
   snapshot stays failed.
3. After verifying the data, retire only the exact owner directory while
   the writers are still stopped. Keep its owner record with the incident
   evidence, then restart both processes. A dead PID alone is insufficient.
   If the record is unreadable or the data is uncertain, keep the blocker
   and recover from a verified source.

For moving between native PostgreSQL and Docker, use the coordinated
[database cutover](STORAGE.md#moving-between-docker-and-native). For
maintenance fences and other storage incidents, see
[Database Maintenance](DATABASE_MAINTENANCE.md) and
[Storage Recovery](STORAGE_RECOVERY.md).
