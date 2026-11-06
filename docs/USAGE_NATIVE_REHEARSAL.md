# Offline usage barrier-store rehearsal

These #15031 tools validate an **isolated byte restore of the two stores
fingerprinted by the usage cutover barrier** and inspect a supplied standard
snapshot's integrity. Neither establishes a complete PortOS backup,
a demonstrated database/runtime restore, a live consistency check, or permission
to activate. The [native stage](./USAGE_NATIVE_STAGING.md) stays separate from
legacy accounting. The [barrier](./USAGE_CUTOVER_BARRIER.md) still refuses activation
until a compatible runtime exists. This tool never registers one.

## What is preserved

- The exact bytes of `usage.json`, including reconciliation markers, Codex high-water
  claims, scan watermarks, unknown legacy fields and replay markers.
- The exact bytes of `peer-usage.json`, including forwarded origins, tombstones and
  version metadata. Neither store is normalized, combined with native totals or
  loaded through a service that could write it.
- A private copy of `usage-cutover-barrier.json` and a matching saved response from
  `GET /api/usage/cutover`, as **evidence only**. The raw record preserves retained
  writes, retired epochs and deferred retirements. Status alone is not its backup.
- The verified stage's hash, original source-report hashes, complete participant
  set, capture metadata, code commit, format versions and every copied file's
  SHA-256 and byte length.

The barrier record is **never restored**, even inside the isolated store directory.
Never install an old barrier over a live one: doing so could lose newer retained
writes or lift the fence. The backup retains the record only in its private payload.

The backup contains private accounting and retained-write data. Base64 is an
encoding, **not encryption**. Keep the request, snapshot, stage, backup and restore
directories private. Do not attach them to public issues or PRs. Hashes detect
changes; they do not authenticate a capture or prove account membership.

## Detached inputs only

An authorized operator must separately prepare consistent, detached copies. This
CLI does not acquire a fence, discover a data root, call a local server, contact a
peer, copy provider-native history or connect to PostgreSQL. Do not point it at an
active data directory. The copied barrier and status must both describe a drained
`fenced` state with the same epoch, participants, timestamps, store fingerprints
and retained-write interval/count. This validates the supplied evidence, not the
current state of any machine. A later write or restart requires new live checks.

The snapshot directory must contain these four regular files:

```
usage.json
peer-usage.json
usage-cutover-barrier.json
cutover-status.json
```

All four are required. A missing ledger/peer store, even one whose barrier reports
`missing`, is unsupported in this increment and refuses rehearsal. Missing is not
zero or an empty object. Symlinks, directories, special files, invalid JSON,
non-object JSON, changes during reads and mismatched hashes are refused. A complete
snapshot is limited to 64 MiB; there is no truncation or partial-success fallback.

Prepare an explicit request using SHA-256 of the **original file bytes**, not parsed
or reformatted JSON, and their exact byte lengths:

```json
{
  "version": 1,
  "participantKey": "<32-hex-native-report-participant-key>",
  "capturedAt": "2026-03-02T00:00:00.000Z",
  "codeCommit": "<40-hex-matched-rollback-code-commit>",
  "schemas": { "report": 4, "stage": 1, "barrier": 1, "rehearsal": 1 },
  "files": {
    "usageLedger": { "sha256": "<64-hex-hash>", "bytes": 123 },
    "peerDigests": { "sha256": "<64-hex-hash>", "bytes": 123 },
    "barrierRecord": { "sha256": "<64-hex-hash>", "bytes": 123 },
    "barrierStatus": { "sha256": "<64-hex-hash>", "bytes": 123 }
  }
}
```

`capturedAt` records the detached capture time, at or after the fence. `codeCommit`
is operator-supplied evidence of the matched rollback version, not verification
that this code is installed or has successfully restored these stores. The format
versions above are checked exactly. The legacy stores have no strict exported
whole-store schema: validation is explicitly `exact-bytes-and-json-readability`,
not a claim that the runtime understands every field.

## Back up, rehearse and preflight

Run on the offline working copies, using private output directories:

```bash
node scripts/native-usage-rehearse.js backup stage.json request.json detached-snapshot backups
node scripts/native-usage-rehearse.js restore stage.json backups/native-usage-backup-<hash>.json rehearsals
node scripts/native-usage-rehearse.js preflight stage.json backup-a.json rehearsals/restore-a backup-b.json rehearsals/restore-b backup-c.json rehearsals/restore-c
```

The backup command prints the content-addressed filename. It verifies the native
stage, validates all copied evidence and fingerprints, atomically publishes one
complete JSON bundle without overwriting, and rereads its actual published bytes.
Identical retries and simultaneous publication return the same artifact. A damaged
existing artifact is refused, not repaired. Incomplete temporary files are ignored.

The restore command always creates a **new** `native-usage-restore-*` directory under
the supplied parent, never a caller-selected destination to overwrite. Use the
returned `directoryName` in the preflight command. The directory contains only
`usageLedger.json`, `peerDigests.json` and `receipt.json`, not active PortOS filenames
or a cloned identity. Both reconstructed stores are reread before the receipt is
written, then the complete directory is verified again. Repeating restore creates
another isolated directory with the same receipt. Interrupted directories remain
for diagnosis; incomplete or changed copies cannot pass preflight. New directories
use `0700` and files use `0600` where supported. No runtime is started there.

Preflight requires one backup and matching restore directory for **every** stage
participant, with no missing/duplicate/extra participants, and identical code commit
and migration epoch across them. It verifies every backup against the current supplied
stage, rereads the restored files and receipt, and refuses extra files or changed
bytes. A receipt alone is insufficient. Source revisions or a new account selection
change the stage hash and invalidate previous backup/receipt bindings.

**Exit statuses:** backup/restore success is `0`; invalid inputs or a failed check
are `1`; invalid command syntax is `2`. Even a fully verified byte rehearsal returns
`3` from preflight, with `barrierStoreRehearsalVerified: true`,
`fullRecoveryBackup: false`, `activationReady: false` and explicit hold reasons.
Do not interpret a successful copy or a parseable preflight report as cutover approval.

## Inspect a detached standard snapshot

The next read-only check consumes the existing [standard PortOS backup](./BACKUP.md),
not another full-backup format. Supply the snapshot directory that contains
`manifest.json`, `data/` and `portos-db.sql`, alongside the verified stage and its
matching barrier-store backup:

```bash
node scripts/native-usage-rehearse.js snapshot-preflight stage.json barrier-backup.json detached-standard-snapshot
```

This command performs no copy, restore, database connection, code execution or
runtime discovery. It writes nothing. It verifies:

- The standard manifest's timestamp, file count, confined relative paths and
  SHA-256 values. Windows separators are normalized, duplicate aliases are
  refused, and only the exact `../portos-db.sql` entry may leave `data/`. The
  manifest timestamp must be at or after the bound fence. This checks capture-order
  coherence only; it does not authenticate the clock or prove current live state.
- Every manifested data file and the SQL dump against their actual bytes. Missing
  or extra regular data files refuse the check. Unmanifested OS metadata
  (`.DS_Store`, `.localized`, `Thumbs.db`, `desktop.ini`, `._*`) is counted separately,
  matching the standard manifest's exclusions. Manifested metadata is still hashed.
- A mandatory `instances.json` whose `self.instanceId` hashes to the barrier
  backup's participant key. Identical empty ledgers from different participants
  cannot substitute for this identity check. This checks supplied evidence, not
  capture authenticity; the identity and pairing secrets are never installed.
- The raw `usage.json` and `peer-usage.json` hashes and byte lengths against the
  barrier-store backup. If the snapshot also contains `usage-cutover-barrier.json`,
  its exact bytes must match too. That record remains evidence only; it is never
  installed or used to replace a live spool or retired epochs.
- A mandatory, hashed PostgreSQL dump with the existing dump inspector's completion
  envelope and real top-level definitions for `memories`, `memory_links`,
  `cos_agents`, `ai_connections`, `ai_harness_bindings`, `ai_route_bindings` and
  `schema_migrations`. SQL-looking text in stored values is not a table definition.
- The shape of each preserved current/legacy file-migration ledger. The current
  `migrations.applied.json` wins over `migrations/.applied.json`, as in the normal
  migration runner. Missing migration state stays explicitly absent, never `[]`.

Absent manifests or dumps, `.failed`, `.in-progress` or the standard sibling
in-progress marker refuse. Unlike general-purpose restore, this narrower offline
check does not support symlinks, including directory links or dangling links.
It refuses links and special files rather than following them. Reads use pinned
regular-file descriptors with an original-size-plus-one-byte cap, then recheck
file identity, size and modification time. A second inventory pass checks for
changes during hashing. This is an inspection of detached copies, not an atomic
live snapshot or a lock on another process's writes.

Limits are 100 MiB per manifest/migration/identity JSON file, 100 GiB of total reads,
100,000 manifest entries and 100,000 walked data entries (including directories),
with at most 64 directory levels. Inventory checks and streams have a 15-minute
budget. Every payload is hashed, including potentially large media; a snapshot
that exceeds a budget refuses with no partial integrity verdict. Nothing is
silently skipped or truncated. The byte budget includes manifest rereads.
Keep the snapshots and any saved output private. Output contains fixed inventory
roles, hashes and counts, never arbitrary file paths, SQL, settings, keys or
instance identity contents. Re-running rereads the snapshot, rather than trusting
an earlier report.

The result reports `snapshotIntegrityVerified: true` only for this supplied
snapshot, with each relevant usage/configuration/attribution group marked
`present-in-snapshot` or `absent-from-snapshot`. Groups cover the legacy scan
fallback, Claude history, quotas, image receipts, sync cursors, settings,
providers, instance configuration, private API keys, run metadata/output,
current/rotated lifecycle logs and both migration-ledger locations. Present means
bytes were preserved and checked, not that a runtime schema or historical
completeness was demonstrated. A zero-byte output log is present, not absent.

**Absence from the snapshot is not evidence of absence from the source.** Backup
exclusions, omitted files, external native histories and data already lost before
capture cannot be reconstructed from the manifest. Even an `assetConsistency`
claim of `global` does not settle those questions. The code commit is explicitly
labelled as the barrier backup's operator-supplied evidence; no supplied claim
proves that code ran, that migrations completed or that the database schema
matches it. Table definitions and a dump trailer do not demonstrate restored
rows, database migrations, a successful SQL replay or runtime operation.

Consequently even this command's successful inspection exits **3**, retaining
`fullStoreInventoryVerified: false`, `fullRecoveryBackup: false`,
`activationReady: false` and explicit holds for source inventory/exclusions,
matched code/schema/migrations, database and runtime restore, native-source
preservation and the existing live cutover gates. It does not clear or change the
fleet byte-rehearsal preflight. Invalid inputs exit 1; invalid syntax exits 2.

## Remaining recovery gates

#15031 remains open. The byte rehearsal and snapshot inspection do not prove the complete
source inventory: legacy `usage-interactive-scan.json`, Claude's preserved transcript
history store, quota readings, immutable image receipts, sync cursors, settings,
provider classifications, identity/peer configuration or attribution artifacts.
These may contain data not reconstructible from the staged native report.

Full attribution/configuration also includes PostgreSQL `cos_agents` and the provider
connection/binding graph, run metadata/output and lifecycle logs, and relevant private
configuration. A SQL dump's hash is not proof that a database restore succeeds.
Follow [the full backup contract](./BACKUP.md) and preserve matched code, database
and migration state. Native histories outside PortOS data need their own preservation;
reports contain projections, not copies of provider files. The Codex inventory cache
is regenerable and is not a substitute for those sources.

Before any future cutover, verify that full inventory, a matched-runtime/database
restore, all current participants and their barrier acknowledgments, source freshness,
account scope, billing exclusions and continued refresh. Cover the retained-write
interval from native evidence or explicitly record its gap. Do not replay those old
writes into native partitions or add overlapping legacy/native totals. This CLI
cannot activate, restore live data, lift a barrier, change sync, restart or deploy.
