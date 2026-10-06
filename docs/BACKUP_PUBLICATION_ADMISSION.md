# Shared backup publication admission

The server and `portos-cos` are separate processes that share one install data
root. `withBackupAssetPublication` registers a short durable lease in
`data/backup-admission/publications/` before changing an asset and its owning
record. Model execution and transfers into unreferenced staging files remain
outside the lease. Hold it through the final record write and failure rollback.
Nested calls reuse the existing lease. Synchronous completion listeners receive
separate leases while their parent remains admitted.

A snapshot or live restore atomically creates `data/backup-admission/cut/`, then
drains every registered publication before reading or replacing either store.
New publications wait until the cut owner releases it, for at most two minutes
by default (`withBackupAssetPublication(work, { timeoutMs })` can set a shorter
caller deadline). Expiry rejects with `BACKUP_SNAPSHOT_BUSY`, the cut ownership
and recovery path; no publication callback runs and the cut remains intact. Readers register before
checking the cut; the cut registers before checking readers. This ordering closes
the cross-process admission race. A preliminary gate check avoids registering
and deleting leases repeatedly during a long snapshot. Directory creation and
removal work on Windows and POSIX; ownership files are fsynced, with directory
fsync on POSIX (Windows does not support opening a directory that way). The
directory-sync capability follows the native host OS associated with the filesystem;
a simulated product platform must not change durability behavior.

If a publication cannot restore its previous pair, throw an error with
`backupPublicationUncertain: true`. The boundary settles its local callback count
but retains the durable owner with an uncertainty marker. Even a nested failure
caught by its caller retains this blocker; ordinary errors after successful
rollback release admission normally. The next snapshot refuses until recovery.

Every owner has a random ID, process generation, PID, kind, and timestamp. Only
the matching owner may release its directory. Neither elapsed time nor a missing
PID permits automatic removal: a dead publication may have left an incomplete
file/record pair, and a dead restore may have installed only part of its snapshot.
A cut that cannot drain refuses with `BACKUP_SNAPSHOT_BUSY` and includes the
blocking ownership records. The read-only `backupPublicationAdmissionStatus()`
returns both cut and publication ownership, including unreadable records.

The control directory is machine-local authority. Backup excludes it
unconditionally, and all full or selective restores preserve it. Upgrade and
restart both the server and CoS runner before relying on coordination between
them; an older runner does not participate. Admission still only covers owners
listed as admitted in the backup inventory, not arbitrary shell commands or
external tools that write the data tree.

## Interrupted ownership recovery

An interrupted owner is a recovery blocker, not evidence that its data is safe.
Keep the recorded ID, PID, generation, timestamp, and directory path in the
incident record. Stop both PortOS processes and any tool writing the affected
data before examining it. Correlate the owner with logs, inspect the affected
file/record pair, and finish or roll back that domain's interrupted publication.
For a restore, also complete its cache/index and database recovery before
reopening publication admission. A failed snapshot must remain failed.

Only after the affected data has been verified may an operator explicitly retire
that exact ownership directory while all writers remain stopped. Preserve its
owner record with the recovery evidence; do not delete the entire control tree,
clear ownership merely because its PID exited, or remove a record from a running
process. Restart both processes after recovery. If the record is unreadable or
the affected data cannot be established, retain the blocker and restore from a
verified source with a deliberate recovery plan.
