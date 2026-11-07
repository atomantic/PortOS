# Offline usage barrier-store rehearsal

These #15031 tools validate an **isolated byte restore of the two stores
fingerprinted by the usage cutover barrier** and inspect a supplied standard
snapshot's integrity. An explicit Linux Docker command can also demonstrate a
disposable SQL replay and a code-bound maintenance-schema probe. Detached native-source commands preserve supplied raw histories
and verify retained-provider replay. None establishes a complete PortOS backup, a matched
runtime restore, a live consistency check, or permission to activate. The [native stage](./USAGE_NATIVE_STAGING.md) stays separate from
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
peer or discover provider-native history. The source commands below copy only
explicit detached roots. Only the explicit `sql-restore` command
connects to PostgreSQL, inside its own disposable container. Do not point it at an
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

## Rehearse SQL in a disposable Linux container

On a separate Linux executor with `/usr/bin/docker`, a reachable local daemon at
`unix:///var/run/docker.sock`, and the exact pinned image already present:

```bash
node scripts/native-usage-rehearse.js sql-restore stage.json barrier-backup.json detached-standard-snapshot
```

This is an explicit **SQL-only** rehearsal, not a runtime boot or live restore.
The command first performs the full snapshot inspection above. It then rereads
and spools the SQL through a pinned descriptor into a new private temporary
directory, verifying the original hash and byte length again. The original dump
is never changed. SQL dumps above 256 MiB are refused in this bounded increment.

The image is the same digest-pinned PostgreSQL 17/pgvector image declared by CI.
The command never pulls images, installs tools, discovers `.env`, uses the primary
checkout, or accepts a database URL, Docker context, image, executable or daemon
argument. Host `PG*`, `DOCKER_*`, credentials, home configuration and startup files
are not inherited. Missing prerequisites fail closed; there is no host-database
fallback. Provisioning this executor/image is a separate authorized action.

Each run creates its own container with networking disabled, no published ports,
no host mounts, read-only root, no capabilities, no-new-privileges, one CPU, 64
processes and 1 GiB memory with no additional swap. The image's declared PGDATA
volume is replaced by a 768 MiB private tmpfs, and `/tmp` is a separate 64 MiB
tmpfs. These are intentionally small rehearsal limits, not production sizing.
The workload has a 15-minute budget; cleanup gets its own bounded budget.

PostgreSQL listens only on its private Unix socket and requires SCRAM passwords
for local connections. Random admin/replay passwords exist only for this run.
Server/admin processes use OS uid 999; replay uses uid 65534 and cannot read the
0700 database directory or signal the server. Replay is a separate PostgreSQL
role without superuser, create-role, create-database, replication or row-security
bypass privileges. Only `vector` and `pgcrypto` are preinstalled by the admin.

The existing backup replay scanner omits only extension DROP/COMMENT metadata
and dump-owned psql restriction/version headers. This preserves preinstalled
extensions and lets the caller impose its own random psql restriction key. The
receipt records this transformation and its omitted-range count while retaining
the **original** dump hash. Replay uses `psql -X`, no password prompt,
`ON_ERROR_STOP`, restricted mode and a single transaction with explicit `-f -`
stdin input. Restricted mode permits only `\unrestrict`, which the replay never
issues. The scanner separately refuses all other out-of-data psql commands
before execution. Ambiguous backslashes in ordinary/escape
SQL strings or quoted identifiers are conservatively refused; this increment
does not interpret changes to SQL lexical modes or encodings. COPY data,
dollar-quoted payloads and comments retain their exact bytes. A fixed SQL `SELECT`
after all supplied input must return a fresh random token as an exact output line
under `-At`; it never uses a prohibited `\echo` command or lifts the restriction.
This independently proves the input reached its end. Unrecognized or incompatible
SQL fails rather than broadening privileges or rewriting it.

After commit, fresh sessions verify that all seven required tables are real
ordinary/partitioned tables and can be queried. Only their fixed names and row
counts are reported. A zero count is a measured empty restored table; it is not
proof the original source was empty. No row contents, migration IDs, arbitrary
SQL output, passwords, paths or raw database errors appear in the report. Failures
identify the fixed phase and category (for example, `replay:permission-denied`,
`replay:client-error`, or `replay:division-by-zero`). psql uses SQLSTATE-only error
verbosity; only allowlisted categories are surfaced, never raw diagnostics.

The container is forcibly removed, including any volumes, on success, failure
or a handled interruption. A successful daemon list must then affirm its absence
before any receipt is returned. A cleanup failure is
`sql-rehearsal-cleanup-unverified`, never a restore-success receipt. An uncatchable
process/host termination cannot guarantee cleanup; inspect that isolated
executor before reusing it. Temporary spools are removed when the command exits
normally or handles a failure/interruption.

A successful report still exits **3**. It sets `database.restoreVerified: true`
with `restoreScope: disposable-container-sql-replay`, records the restored row
counts and verified container removal, and clears only the database-replay hold.
`sourceRowCountsMatched`, `schemaAndMigrationsMatched`, matched runtime,
`fullStoreInventoryVerified`, `fullRecoveryBackup` and `activationReady` remain
false. Schema-migration rows were restored and counted, not validated against
code or claimed to have run correctly. This command neither applies migrations
nor starts PortOS, provider integrations, peer sync or any runtime service.

The hosted DB job runs synthetic SQL/COPY and privilege-escape tests against real
PostgreSQL, including actual `pg_dump` output generated with the production flags
from vector/pgcrypto, schema, function and trigger fixtures. It runs these tests
explicitly, outside the test memo, with Docker required. Local unit tests simulate
the Docker transport and do **not** establish actual SQL replay. To run the real
suite on an already provisioned isolated Linux executor, from `server/`:

```bash
PORTOS_NATIVE_SQL_LIVE=1 node node_modules/vitest/vitest.mjs run --configLoader runner ../scripts/native-usage-sql-rehearsal.live.test.js
```

## Preserve and replay detached native sources

These commands preserve raw provider history separately from the standard full
PortOS backup. Supply a verified stage and select **one exact embedded participant
report** using its participant key and content hash. A report is a projection,
not a replacement for the original files.

Prepare a detached directory with these fixed role directories, copying only the
corresponding history root's **contents**, not a home or configuration directory:

- `codexSessions`: Codex `sessions` rollout history.
- `codexArchivedSessions`: Codex `archived_sessions` rollout history.
- `claudeProjects`: Claude `projects` history, including any configured location.
- `grokSessions`: Grok `sessions` history.
- `agyCliConversations`: Antigravity CLI `conversations` SQLite containers.
- `agyLegacyBrain`: Antigravity CLI legacy `brain` history.
- `agyAppConversations`: Antigravity App `conversations` containers.
- `agyIdeConversations`: Antigravity IDE `conversations` containers.

The CLI never discovers these roots, signs in, calls a provider or reads auth or
configuration roots. Do not supply live directories. Preparing consistent copies
and confirming which histories belong to an account remain separate operator
steps. The fixed layout prevents accidentally walking an entire provider home.
Unknown files **inside** a provided history root are preserved too; inspect the
selection privately before copying.

Prepare a separate strict request. All eight roles are mandatory, with one of
`provided`, `absent-from-detached-input`, or `not-supplied/unknown`:

```json
{
  "version": 1,
  "participantKey": "<32-hex-key-from-the-stage>",
  "reportHash": "<64-hex-contentHash-of-the-exact-embedded-report>",
  "roles": {
    "codexSessions": "provided",
    "codexArchivedSessions": "absent-from-detached-input",
    "claudeProjects": "provided",
    "grokSessions": "provided",
    "agyCliConversations": "provided",
    "agyLegacyBrain": "provided",
    "agyAppConversations": "not-supplied/unknown",
    "agyIdeConversations": "not-supplied/unknown"
  }
}
```

Only `provided` role directories may exist at the detached root. Extra top-level
files or directories refuse the operation. An explicitly absent role asserts only
absence from **this detached input**, never absence from the live machine or deleted
history. An unknown role is not an observation of absence. A retained provider
with any required unknown role receives `not-supplied`, never a successful replay
verdict even if the bound report also lacked that source. Antigravity's provider
entry includes CLI, legacy, App and IDE coverage, so all four declarations matter.

```bash
node scripts/native-usage-rehearse.js sources-backup stage.json sources-request.json detached-sources new-source-backup
node scripts/native-usage-rehearse.js sources-restore stage.json new-source-backup new-source-restore
```

The destination's parent must already exist. Each destination must be **new**:
creation is exclusive, directories use `0700`, and files use `0600` where supported.
No overwrite, repair, cleanup or destructive restore is offered. Concurrent calls
for the same target have one owner; a repeat refuses without altering that target.
Use another new destination to retry an interrupted run. Partial directories remain
private with an `.in-progress` marker and cannot be used as complete bundles.

Every regular source file is copied byte-for-byte, including zero-byte, ignored,
opaque, future-format and metadata files. Every directory, including empty ones,
is preserved. Permissions, ownership, timestamps, ACLs and extended attributes are
not restored; private output permissions are intentional. Links (including hard
links), special files, traversal, case aliases and nonportable path spellings
refuse the bundle rather than silently omitting data. A selected input root itself
cannot be a symlink. Its ancestor aliases, such as macOS `/tmp` and `/var`, are
resolved once, then operations use the bound canonical path. Bundle entries never
follow links.

The bundle uses the standard `manifest.json` convention (`generatedAt`,
`fileCount`, and relative-path-to-SHA-256 `files`) over `data/`. Raw files live at
`data/<role>/...`. Two private evidence files are also manifested:

- `data/native-sources.json`: strict role declarations, complete directory list,
  raw-file byte lengths, stage hash, report hash and participant binding.
- `data/participant-report.json`: the exact bound strict report, including its
  Codex account-read evidence. It is not reconstructed from local rollouts.

There is no base64 payload or alternative full-backup format. File descriptors
are pinned, reads are bounded to the initial size plus one byte, and paths, file
identity, size and modification time are rechecked. Inventory and SHA-256 passes
are repeated around copying and replay. A complete synced manifest is published
without overwrite only after data checks, then the in-progress marker is removed.
A crash may leave a marker or partial copy, never a trusted incomplete verdict.
These checks detect changes in detached copies; they are not a live capture lock,
authenticity proof or a guarantee against a concurrently hostile filesystem owner.

Copy/verification limits are 100,000 source files and directories, 64 directory
levels, 100 MiB per JSON evidence file, 100 GiB of **cumulative reads** (including
rechecks), and a 15-minute acceptance budget for the whole command. The input dataset must therefore
be smaller than the read budget. Nothing is silently truncated. Replay accepts
finite report-declared budgets up to the existing capture ceilings: 512 GiB,
64 MiB per line, 5,000,000 entries, 50,000,000 records, 30 minutes and depth 64.
Those declarations stay unchanged in the projection, while the independent
15-minute command deadline and parser memory/record caps still apply. Detached
Claude replay additionally refuses before retaining more than 100,000 unique
identities, matching the report projection bound without changing live defaults.
Exhausting the execution deadline refuses replay even if counters happen to match.
Reader deadlines are cooperative: pending filesystem/SQLite operations are not
forcibly interrupted at the exact deadline, but late completion cannot succeed.

Restore verifies the entire file/directory set and every byte, then runs the
existing Claude, Grok and Antigravity CLI readers with explicit restored roots.
Ambient `HOME`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR` cannot supply missing inputs.
The comparison covers the **entire canonical retained-provider entry**: records,
conflict tombstones, duplicates, streaming resolution, coverage, unknowns, costs
and findings, not merely totals. Empty directories matter to Grok missing-session
coverage and Antigravity legacy-only coverage. App/IDE containers remain opaque;
their bytes are preserved but no speculative decoder is introduced.

If all three retained entries match and none of their roles is unknown, the stage
is rebuilt using those entries plus the **preserved original Codex report entry**
and must match exactly. Codex's authority remains `account/usage/read`; rollout
bytes cannot change its account totals or prove account-history replay. Historical
membership, missing intervals, deleted history and actual spend remain unknown.

Backup exits **3** after verified limited preservation. Restore exits **3** only
when retained replay matches, and **1** on a mismatch or an unknown required role.
Mismatch leaves useful verified restored bytes and a `replay.json` receipt with
`retainedReplayVerified: false`; it does not manufacture a success verdict.
Invalid inputs exit 1, invalid command syntax 2. Output contains only fixed roles,
statuses, hashes, counts and limitations, never filenames, paths, record payloads
or secrets. Keep all bundles and reports private: raw histories may contain prompts
and sensitive data; hashes and filesystem modes are **not encryption**.

Even a successful bundle verifies only supplied detached roots. It permanently
retains `fullStoreInventoryVerified: false`, `fullRecoveryBackup: false`,
`activationReady: false` and the global `native-source-preservation-not-verified`
hold. One supplied bundle does not establish all participants' complete source
inventory, matched runtime/schema recovery or permission for cutover.

## Remaining recovery gates

#15031 remains open. These rehearsals and snapshot inspections do not prove the complete
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

## Bind code and probe the restored maintenance schema

On the same isolated Linux Docker executor, an explicit stronger command uses the
SQL replay above and then the **existing fenced startup diagnostic's schema
query**. It does not start PortOS:

```bash
node scripts/native-usage-rehearse.js schema-restore stage.json barrier-backup.json detached-standard-snapshot
```

The command derives its code root from its executing module, never from the
snapshot, environment, current directory or a supplied checkout argument. The
backup's original `codeCommit` must equal that checkout's actual `HEAD`. A missing
commit, a different checkout, tracked changes or untracked files refuse before
Docker starts. Do not relabel an old backup to make it pass. Use a matching audited
checkout that supplies this command, or take a newly justified detached capture
with the correct original code evidence.

Before and after replay it reads the tracked checkout's actual bytes and verifies
each Git blob, rather than trusting Git's stat cache or `assume-unchanged` flags.
The one supported checkout conversion is UTF-8 LF to CRLF when the committed
attributes explicitly declare `text eol=crlf`, as for `exec.cmd`. The conversion
count and a digest of the actual working bytes are recorded. Local
`.git/info/attributes`, global attributes, clean filters, encoding conversions and
identifier expansion cannot justify a byte mismatch. `/usr/bin/git` must support
`check-attr --source` (Git 2.43 or newer) when this conversion is needed.
It records the commit/tree, hashes of all four committed package lockfiles, and
content hashes of the shipped schema and migration sources. Parent-directory
links, mismatched file modes, changed symlinks and uncommitted migration files
refuse. Tracked symlink **text** is checked without following it. Gitlink object
IDs are bound by the tree, but submodule contents are **not** validated. Ignored
files and installed `node_modules` are not code/dependency installation evidence.
The reported Node version is the diagnostic process's version, not proof of the
backup's original runtime. Source checks allow 100,000 tracked entries, 100 MiB
per regular file, 1 GiB total and five minutes per pass.

The file and database migration inventories use the same filename selectors as
the actual migration runners. The already-hashed current file ledger wins over
the legacy location. Its recorded IDs must exactly equal the shipped file
migration set, and the restored `public.schema_migrations` IDs must exactly equal
the shipped database migration set. Missing ledgers, pending, unknown, duplicate,
malformed or noncanonical IDs refuse. No migration module is imported or run.
Matching IDs are bookkeeping evidence only: neither migration effects nor a
successful earlier execution are established by a ledger.

After SQL commits, the command runs `maintenance-target-v1`, shared with
`verifyDatabaseMaintenanceTarget` in `server/lib/db.js`, in a read-only transaction
with a fixed `pg_catalog` search path. It checks the private scratch database/user,
`public.memories`, `public.memory_links`, the `memories.sync_sequence` column,
`public.catalog_ingredients` and `public.catalog_scraps`. The receipt identifies
this contract, its exact query hash and its narrow scope. The migration inventory
query also runs read-only with row security disabled, refusing rather than
accepting a policy-filtered inventory. No rows, database identities or supplied SQL diagnostics
are printed. The original snapshot and both migration ledgers are never edited.

A successful command exits **3** and adds `schemaProbe.verified: true`,
`databaseMigrationInventoryMatched: true`, and `fileMigrations.inventoryMatched:
true`. The schema probe is **presence/readability of this maintenance contract**,
not a full schema comparison: column types, constraints, triggers, indexes, all
other tables, application store readers, usage normalization, writes and a later
ordinary boot are still unverified. The synthetic integration fixture deliberately
satisfies only this minimal contract; passing it must not be described as an app
restore.

`schemaAndMigrationsMatched`, `appliedStateVerified`, `matchedRuntimeVerified`,
`installedDependenciesVerified`, `fullRecoveryBackup` and `activationReady` remain
**false**. The matched-code/schema/migrations and matched-runtime holds stay in
place. Nothing registers a runtime, installs identity, changes barriers, contacts
a live host, runs migrations, invokes providers, enables jobs or resumes sync.
The required hosted DB workflow exercises this command against real restored
synthetic SQL, including missing-schema and unknown-migration refusal with cleanup.
Transport-only tests are not evidence of an actual PostgreSQL execution.
