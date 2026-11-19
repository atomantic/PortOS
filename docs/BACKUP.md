# Backup & Restore

PortOS backs up two things together, into a single timestamped snapshot:

1. **Filesystem data** — an rsync mirror of `./data/` (with SHA-256 manifest).
2. **PostgreSQL** — a `pg_dump` logical dump (`portos-db.sql`) written alongside the snapshot.

**Excludes must be anchored.** Every path in `DEFAULT_EXCLUDES` starts with `/`, or rsync matches it at any depth and silently drops user data; `overridable` excludes can be re-enabled per install. See [What is excluded by default](#what-is-excluded-by-default) and [Why every exclude must be anchored](#why-every-exclude-must-be-anchored-with-a-leading-).

Backup configuration, manual runs, snapshot downloads/deletion, and restore/recovery
require operator authority: a verified human or delegated agent session when auth is
on, or a genuine local connection when auth is off. A reachable LAN/tailnet caller
or scoped federation credential cannot export the raw archive or alter recovery
policy. This includes HEAD requests for downloads. Status and snapshot inventory
remain readable under the normal API policy. Scheduled backups continue under the
operator-configured policy without additional confirmation.

Snapshots stay consistent while assets change through a shared publication
admission boundary; its mechanism, deadlines and interrupted-ownership recovery are in
[BACKUP_PUBLICATION_ADMISSION.md](./BACKUP_PUBLICATION_ADMISSION.md#consistency-while-assets-are-changing).
Step-by-step procedures for switching database backends, restoring an older database
snapshot, and restoring individual stores into a running server are in
[BACKUP_RUNBOOKS.md](./BACKUP_RUNBOOKS.md).

## What gets backed up

A backup run (`runBackup` in `server/services/backup.js`) writes to:

```
<destPath>/snapshots/<hostname>/<snapshotId>/
├── data/             # rsync mirror of ./data/ (minus excludes)
├── portos-db.sql     # pg_dump logical dump
├── manifest.json     # SHA-256 of every data/ file AND ../portos-db.sql
└── .failed           # present only when snapshot creation failed
```

- Snapshots are namespaced by `<hostname>` so one shared destination (e.g. an iCloud folder) can host backups from several federated machines without `snapshotId` collisions.
- Snapshot lists include every machine namespace in the destination, plus snapshots written directly under `snapshots/` by PortOS versions from before hostname namespaces. Each row identifies its source, so equal timestamp IDs from different machines remain separate choices. Download, file restore, and database restore keep that source attached through preview and execution. API requests that omit `source` retain the existing behavior and select the current machine; `source: "@legacy"` selects the pre-namespace root.
- The `manifest.json` hashes the SQL dump too (keyed as `../portos-db.sql`, since the dump lives one level above the `data/` tree), so a truncated or corrupt dump is detectable rather than silently trusted.

### What is excluded by default

`DEFAULT_EXCLUDES` (in `backup.js`) skips ephemeral/cache data and large re-downloadable assets — all anchored with a leading `/` (rsync filter syntax). Two tiers:

- **Non-overridable** (`overridable: false`): browser CDP profile, agent worktrees, cached jev training embeddings — caches with no irreplaceable user data; never backed up.
- **Overridable** (`overridable: true`): intermediate LoRA training checkpoints, cloned repos, reference repos, browser downloads, jev training corpora — re-downloadable or rebuildable; the user can disable these built-in exclusion rules from the Backup settings UI via `disabledDefaultExcludes`.

A Music Video [Blender film](./features/music-video-blender.md) is split the same way: its scripts (`data/music-video/<projectId>/blender/src/`), synced shot list and `song.json` are backed up, while `/music-video/*/blender/renders/` (frames, shot videos, stills, cuts and logs, all re-rendered from those scripts) is excluded and overridable.

Rendered frames are the bulk of `renders/` (a long film's final PNG frames run to many gigabytes), and PortOS does not read them again once a shot's video is encoded. They are kept on disk by this rule (`server/services/musicVideo/blender/usage.js`):

- An unfinished render keeps its frames, so the next render of that shot resumes them.
- A finished render keeps its frames until **Clear rendered frames** (the film panel's Settings tab, which also shows what the workspace takes) removes them, or until the shot is rendered again from changed scripts, settings or options, which replaces them.
- A shot that leaves the film loses its frames at the next sync. Its videos and stills stay (the shot may come back) until frames are cleared.

Clearing preserves videos, posters and stills for shots still in the synced film, plus cuts and logs. It deletes the entire render folder of each removed shot, including that shot's videos, posters and stills. Turning the exclusion off backs up every frame still on disk: clear them first unless you mean to.

Deployed LoRA weights in `data/loras/` and their metadata sidecars are included by default, whether trained locally or downloaded. Promoting an earlier checkpoint copies its selected bytes there, so a backup preserves that adapter independently of excluded torch and mflux intermediate checkpoint directories. This deliberately accepts the storage cost of deployed weights. Old `disabledDefaultExcludes` entries for `/loras/*.safetensors` remain harmless; the removed default no longer needs a toggle.

#### jev project heads — excluded bulk, retained artifact

`data/jev/` (#7689) holds three things that are deliberately NOT one tier:

| Path | Tier | Why |
|---|---|---|
| `/jev/embeddings/` | excluded, non-overridable | Frozen-encoder outputs keyed by `(pair, model revision)`. Byte-identical on re-encode, and gigabytes. |
| `/jev/corpora/` | excluded, **overridable** | Rebuildable by `node scripts/jev-corpus.js`. Overridable because the forge moves on, so someone archiving a measured adoption decision may want the exact rows the numbers came from. |
| `data/jev/heads/` | **NOT excluded** | A trained head is a few thousand floats and is **not regenerable once its corpus is stale** — the queries that produced one a month ago return different rows today. It is also the only artifact here an operator made a decision about, on the strength of three measured gold-set scores. |

Everything under `data/jev/` is machine-local (ADR [privacy records machine-local](decisions/2026-08-08-privacy-records-machine-local.md)), so a snapshot that carries a head is the only copy that survives a rebuild. Retaining it costs kilobytes; excluding it would silently discard the decision.

The effective exclude list is computed by the pure `computeEffectiveExcludes()` helper (unit-tested in `server/services/backup.snapshots.test.js`). The scheduled cron handler in `backupScheduler.js` re-reads settings on every run, so `destPath`, `excludePaths`, `disabledDefaultExcludes`, and `enabled` all take effect on the next run without a restart. See [Scheduling & status](#scheduling--status) for how the cron registration itself tracks settings.

#### Why every exclude must be anchored with a leading `/`

`DEFAULT_EXCLUDES` is **rsync filter syntax** — the leading `/` means "relative to the transfer root". Without the anchor, `loras/*.safetensors` also matches any `loras/` directory nested anywhere under `data/`, silently dropping unrelated user data (e.g. `brain/.../loras/`). An unanchored pattern is a data-loss bug, not a style nit.

The same rule applies to **user-entered** Additional Exclude Paths, which is the list that is easy to get wrong: rsync matches a pattern with no leading `/` at *every* level of the tree, so typing `cache/` to skip `data/cache/` also drops `training-runs/*/cache/`, and `raw/` reaches into sprite runs. The failure is silent — the snapshot reports success, it is simply smaller, and the omission surfaces only at restore. So `computeEffectiveExcludes()` **anchors each user pattern on read** (`anchorUserExclude()` / `anchorUserExcludes()` in `server/lib/sharedSchemas.js:161,187`), prepending `/` to anything that is not already anchored and is not deliberately wildcard-led.

- Anchoring happens at read time, never in storage: `settings.json` keeps exactly what you typed, so there is nothing to migrate and nothing is rewritten under you. The Backup tab anchors a pattern as you add it and renders the computed effective list, so the chip you see is the filter that will run.
- **`**/name/` is the explicit way to ask for any-depth matching.** A pattern starting with `*` or `**` is passed through unchanged — that is how you deliberately say "every `cache/` anywhere", rather than getting it by accident.
- Patterns are bounded at the settings boundary (`backupConfigSchema` in `server/lib/backupValidation.js`), and a `..` segment or a NUL byte is rejected rather than sanitized. The 256-character cap is measured on the **anchored** form — the string rsync is handed — so the boundary accepts exactly what `computeEffectiveExcludes()` keeps, and a pattern can never be saved as valid and then silently dropped at run time.

The two `overridable` tiers are enforced, not advisory. A hand-edited `settings.json` that lists a non-overridable path in `disabledDefaultExcludes` is silently dropped server-side; `computeEffectiveExcludes()` enforces both the overridable allow-list and `Array.isArray` guards for hand-edited settings. The Backup tab switches describe default rule state: switching on disables that default exclusion, and switching off re-enables it. The summary counts enabled and disabled default rules, not included files.

Additional Exclude Paths is independent: toggling a default never removes custom patterns, and custom rsync patterns remain accepted even when they overlap defaults. Additional rules still apply when a default is disabled, so deployed LoRA weights can still be omitted by explicit custom patterns: `*.safetensors` or `/lo*/` can still exclude them. `computeEffectiveExcludes()` produces the filter list; rsync alone decides which paths match. The UI does not predict snapshot contents.

## The Postgres dump is mandatory, not optional

`dumpPostgres()` runs `pg_dump --no-owner --no-acl --clean --if-exists`.

| Result | Meaning | Effect on backup |
|---|---|---|
| `{ status: 'ok', sizeBytes, tableCount }` | Dump passed the completeness check | Backup `ok` |
| `{ status: 'failed', reason: 'pg_unreachable' \| 'pg_dump_missing' \| 'version_mismatch' \| 'dump_error' \| 'empty_dump' \| 'inspect_error' \| 'dump_incomplete' \| 'timeout' }` | Postgres is the active backend but the dump failed | Backup **`degraded`** + warning toast |
| `{ status: 'skipped', reason: 'not_configured' }` | The explicit file escape hatch is active — `MEMORY_BACKEND=file` or the backend resolved to `file` (dev/test, unsupported for production) | Backup stays `ok` (benign) |

- Failed dumps are recorded in `data/backup/state.json` and emit `BACKUP_DB_DUMP_FAILED` on both manual and scheduled runs.
- An unreachable production database yields `failed/pg_unreachable`.
- **`--clean --if-exists`** makes the dump replay cleanly into a live, already-initialized PortOS database — the common restore target — instead of erroring on `relation already exists`.
- After a zero exit, backup checks the same completion marker and core tables as restore. Missing either yields `dump_incomplete`. Backup removes rejected SQL before publishing a degraded snapshot. If removal fails, the snapshot is marked failed.
- **`version_mismatch`** means no installed `pg_dump` is new enough for the running server (`pg_dump` aborts when older than the server it dumps — the common Homebrew case where an old `postgresql@NN` keg shadows a newer running server in `PATH`). `dumpPostgres()` reads the server's major version (`getServerMajorVersion()` in `lib/db.js`) and auto-selects the closest `pg_dump` whose major is `>=` the server from the installed Homebrew kegs / Postgres.app bundles. Set `PORTOS_PGDUMP=/path/to/pg_dump` to override the auto-discovered binary (e.g. on Linux/Windows where the keg locations don't apply).

## How restore works

Restore is two independent operations — restoring files and restoring the DB are separate decisions. Both are **dry-run by default** and validate `snapshotId` and an optional source namespace against path traversal before touching anything. Explicit source selections also reject symbolic-link aliases for the snapshots root, source namespace, or selected snapshot before archive or restore reads begin.

**Snapshot source lifetime (#10898).** A consumer that reads snapshot bytes holds a read lease on that snapshot for as long as it reads: a file restore or preview from before its restorability and integrity preflight until rsync's child closes (and, for execution, caches are reconciled); a database restore from its restorability check through dump admission and spooling; a download until the `tar` child closes — including after the client disconnects, since `tar` may still be reading. The lease is released on every exit path: success, refusal, failure, timeout and abort. Deletion needs the snapshot exclusively: explicit deletion of a snapshot in use is refused with `409 SNAPSHOT_IN_USE`, automatic retention skips it (logged, and pruned by a later run), and a reader that arrives while a deletion is in progress is refused with `409 SNAPSHOT_DELETING`. Deletion takes ownership *before* its final existence and in-progress checks, so a deletion that was admitted first cannot race a new reader. Ownership is keyed by the snapshot's canonical path, so aliases — an omitted versus an explicit current-machine source, a symlinked destination, a different letter case on a case-insensitive volume — share one owner. The lease coordinates this server's own requests and scheduled jobs; it is not a lock between machines that share a destination.

A backup run that fails after creating its snapshot directory records a durable `.failed` marker before releasing its `.in-progress` guards. Failed snapshots are never eligible for file or database restore (`SNAPSHOT_FAILED`); they remain downloadable so their partial files can be inspected or recovered manually. If PortOS cannot write the failed marker, it keeps the existing incomplete markers instead, which also block restore.

**Interrupted snapshots (#12618).** A crash, `max_memory_restart` or manual restart can kill a run before either marker path runs. Each `.in-progress` marker therefore carries the writing server process's start id. In the current machine's namespace, a snapshot whose in-progress markers were written by another process (or are the legacy empty markers) and that is not this process's active run is reported as `interrupted`, not `incomplete`: restore and download refuse it with `409 SNAPSHOT_INTERRUPTED`, but it can be deleted. The next `runBackup()` converges each one on disk by writing `.failed` with the reason `interrupted by restart` and removing its in-progress markers; the snapshot stays `interrupted`. A marker whose owner cannot be read, and any snapshot in another machine's namespace, stays `incomplete`, because that run may still be live. Snapshots created by older PortOS versions without a manifest or failure marker retain their legacy behavior because an unmarked historical failure cannot be distinguished reliably from a genuine pre-manifest snapshot.

### Files — `restoreSnapshot()`

Before rsync can read or overwrite live data, PortOS strictly reads `manifest.json`, validates every manifest path and SHA-256 value, and hashes every recorded regular file in the selected restore scope. A missing, unreadable, mismatching, or unrecorded selected file refuses both preview and execution before rsync starts. Selective restore verifies only its literal selected subtree and ignores the separately handled `../portos-db.sql` entry. The same preflight runs again for execution, so changing or adding snapshot bytes after a successful preview cannot bypass verification. Readable symlinks retain the hash behavior used when the manifest was created; dangling symlinks remain outside the regular-file manifest and retain rsync's archive compatibility.

Snapshots from PortOS versions that predate `manifest.json` remain restorable as an explicit compatibility case. Restore responses report `verification.status` as `verified` (with `checkedFiles`) or `unverified` with reason `manifest_absent`; the confirmation panel warns when a legacy restore cannot be verified. An existing manifest that is malformed or unreadable fails closed and is never treated as legacy absence.

After the preflight, rsync copies `<snapshot>/data/` back to `./data/`. Restore always passes `--checksum`, so rsync compares file contents even when the live file has the same size and modification time as the snapshot; equal-content files remain skippable, while differing bytes appear in previews and are restored. This applies to dry-run and live restores, including selective subdirectory restores and legacy snapshots without a manifest. `dryRun: true` (the default) reports what would change without writing; an optional `subdirFilter` limits the restore to one subdirectory.

File restore copies what the snapshot holds and leaves live files the snapshot lacks in place. One consequence is handled explicitly: a snapshot taken before the CoS config moved to its own file (#6182) carries its CoS settings inside `cos/state.json` and has no `cos/config.json`. When such a restore lands that legacy slice, the live `cos/config.json` (newer than the restore point) is moved aside to `cos/config.pre-restore-<timestamp>.json` and the settings are recovered from the restored `state.json`; otherwise the newer file would keep winning every read.

A snapshot taken before the agent records moved into PostgreSQL (#12738) also carries an `agents` map inside `cos/state.json`. A file restore does not bring those records back: agent records are `cos_agents` rows, restored with the database dump, and the CoS runtime ignores (and drops on its next save) an `agents` map it finds in `state.json`.

**Historical file-to-database metadata (#12397, #13931, #16948).** On a PostgreSQL install, full and selective file restores refuse selected legacy metadata with `409 BACKUP_LEGACY_DB_METADATA` before preview or execution starts a transfer. The diagnostic lists the affected domains, which can include universes (record `index.json` and type-level `config.runs`), pipeline issues/series, Story Builder, Writers Room (`folders.json`, `exercises.json`, work `manifest.json`), Creative Director projects, and CoS task queues (`TASKS.md`, `COS-TASKS.md`, and in-tree paths named by the snapshot’s legacy CoS config). These records now live in PostgreSQL. A live domain import marker can suppress re-import after file restore; restoring the older file-migration ledger does not reset that separate marker. Clearing markers is unsafe too: the importers preserve existing rows with `ON CONFLICT DO NOTHING`, so they cannot provide replacement-restore semantics for overlapping IDs. The CoS queue import is tracked in the PostgreSQL migration ledger. Restoring the file ledger leaves the CoS import marked as applied in an upgraded database. Backups do not record the original checkout root, so the compatibility check can map an absolute queue path only when it is under the current install’s data root or the snapshot’s data root. Review legacy CoS configuration during offline conversion if the snapshot came from a different checkout.

New PostgreSQL backups apply these same compatibility rules to the paths already collected in their manifest. A snapshot containing legacy metadata is retained with its SQL dump and reports `degraded`, with `restoreWarning` naming the affected domains and conversion guidance in the run response and saved status. The dashboard and Backup settings show that guidance; retention preserves older snapshots. Converted snapshots and the explicit file-backend escape hatch keep their existing behavior.

Keep the original backup intact. Copy the historical files and restore their matching database dump, when available, into the same disposable offline install running a compatible historical version. Finish staging both before starting the upgrade or running database migrations. For CoS tasks, stage each available legacy queue at the path the isolated install’s CoS config names before database migration 018 runs. Upgrade through the file-to-database transition, then verify the imported records and linked files there. Make a current-format file and PostgreSQL backup from the converted install, then use the normal verified restore workflow. Do not convert against the live database or delete its markers. Current file-primary siblings (such as manuscript reviews, draft Markdown and media assets) and parked `.imported` recovery evidence remain eligible for file restore. Selecting one of those siblings is allowed even if another part of the snapshot contains legacy metadata.

A full restore also installs the snapshot's `migrations.applied.json`, so the next start re-runs every file migration the snapshot predates. A snapshot taken before migrations moved out of `data/` (May 2026) carries that ledger at `migrations/.applied.json` instead; the transfer lands it beside the live `migrations.applied.json`, which the runner would then keep, so a full restore adopts it by hand after the transfer: the live ledger is parked as `migrations.applied.json.pre-restore-<timestamp>` and the restored one takes its place. Preview and result carry `restoredLegacyLedger` (`{ status, parkedAs }`, `pending` in a preview and `adopted` after execution; `unreadable` when the snapshot's legacy ledger does not parse as a list, in which case the live ledger is kept); the widget warns before restore and asks for a restart afterwards. A snapshot that also carries a current-path ledger is left to the transfer. That re-run only upgrades restored files for migrations gated on their input. The store-split migrations (059 for media collections, 200 for the Brain stores) gate on their output, a type index already at schema v1, and file restore leaves the live index in place, so their re-run is a no-op over a restored monolith. Restore therefore converts those stores itself (#12626): when the scope covers a store (full restore, `brain`, `brain/<type>.json`, `media-collections` or `media-collections.json`) and the snapshot carries its monolith (`brain/<type>.json`, `media-collections.json`) without `<store>/index.json`, a successful transfer moves the live `<store>/` directory to `<store>.pre-restore-<timestamp>/` (and a live `.bak-200`/`.bak-059` backup beside it), runs the frozen split migration against the install, and invalidates the Brain caches. The restored records, tombstones included, then load immediately, for folder restores too. A full restore whose snapshot ledger lacks the split migration also lacks the migrations an upgrade ran before it (080/081/190 for the Brain stores, 021/038 for media collections), so it does not run the split alone: after adopting the restored ledger it runs that ledger's pending migrations through the split with the real runner (`runMigrations({ through })`), in order (#12813). It also parks every live Brain type directory the snapshot has no `<type>/index.json` for, because an earlier migration can create the monolith (081 builds `brain/inbox.json` from `inbox_log.jsonl`). The result matches an in-order upgrade of the snapshot, and migrations after the split run on the next start. Preview and result carry `restoredLegacyMigrations` (`{ status, through, names }`, `pending` in a preview and `applied` after execution). Folder restores never replay. A snapshot that has the split layout plus a stray monolith (setup-data re-seeds those after an upgrade) is current and is not converted. A monolith the split would refuse (unparseable, or a malformed records container) is restored as-is and never parks the live store. Preview and result list these stores in `restoredLegacyStores` (`{ store, legacyFile, status, parkedAs }`, with `status` `pending` in a preview and `converted` or `unreadable` after execution); the widget warns before restore and names the parked directory afterwards. A folder restore (`subdirFilter`) keeps the live ledger, so restored files can come back in a shape older than migrations no runner will revisit. Its preview and result therefore carry `ledgerGap`: `{ count, names }` listing the migrations the live ledger records and the snapshot's lacks, or `null` when either ledger is missing or unreadable. A full restore omits the field. The widget warns on a non-empty gap and recommends a full restore, but does not refuse: a folder no migration touched restores correctly. The quota-burn plan is converted on the spot: a restore covering `cos/quota-burn.json` (full, `cos`, or that file) runs any legacy `jobType` steps through the same conversion as migration 359 (`reconcileRestoredQuotaBurnPlan`), reusing each step's deterministic `job-burn-<family>-<step>` custom job, so a repeated restore creates no duplicates.

**Every nonzero rsync exit fails a restore, including 24.** A backup tolerates exit 24 ("some source files vanished") because it reads the live data tree, where a file deleted mid-scan is normal. A restore reads a snapshot that must not change under it, so a vanished source file means live data may now mix restored and older files: preview and execution both reject it. An execution failure is reported as a partial restore — the error says some files may already have been overwritten because file restore is not transactional — and caches (settings, Brain, media index) are reconciled before the error is returned, exactly as for any other failed transfer.

#### Database authority is not restored

`data/database-authority.json` is backed up as cutover evidence but is never installed by a file restore. It records which database backend a completed cutover retired on the machine that ran it, so restoring it from another machine's snapshot (or from an older snapshot after a reverse cutover) would make PortOS refuse its own healthy database with `DATABASE_RETIRED_BACKEND`, including after a restart. Every file restore therefore excludes it, in preview and execution alike, and the integrity preflight ignores it too. The destination's existing file stays byte-for-byte as it was: an absent record stays absent and a damaged one stays fail-closed. The same preservation covers the other machine-local authority and recovery records — `peer-execution/`, `peer-execution-catalog.json`, `peer-execution-grants.json`, `peer-execution-authority.json`, `peer-execution-recovery.jsonl`, `workflow-maintenance/` (the graceful-maintenance journal and abandoned-run receipts) and `backup-admission/` (which snapshots also skip) — so a snapshot's copy is evidence only (see [STORAGE.md](./STORAGE.md)). Other records in the snapshot restore normally. Selecting any of these paths, including `database-authority.json` itself, is refused with `BACKUP_RESTORE_MACHINE_LOCAL` before anything is transferred. This does not touch an active maintenance journal (`database-maintenance/`): its recovery semantics are unchanged, and another machine's cutover endpoints are never imported. To change which backend is authoritative, run a database cutover.

#### Federation identity is kept unless adopted

`data/instances.json` holds this install's federation identity (`self.instanceId`), its peer list and each peer's pair secret. A shared destination lists every machine's snapshots, so installing another machine's file would give two live installs one identity: both would claim the same CoS tasks, sign pushes with the same pair credentials and advance the same per-peer sync cursors (#12596). Before verification, a restore whose scope reaches `instances.json` (a full restore or `subdirFilter: 'instances.json'`) compares the snapshot's `self.instanceId` with the live file's:

- **Same identity, or no live identity** (this machine's own older snapshot, or a never-federated install): the file restores as before.
- **Different identity:** the live file is kept byte-for-byte. It is excluded from the rsync transfer, the manifest selection and the scope inventory exactly like the machine-local records above, so preview and execution agree, and both report `identityPreserved: { liveInstanceId, snapshotInstanceId }`. Every other file restores normally. An unreadable live file counts as an identity (`liveInstanceId: null`), since its owner cannot be known; an unreadable snapshot file reports `snapshotInstanceId: null`.
- **`adoptIdentity: true`** installs the snapshot's file anyway and reports `identityAdopted`. Use it only to replace a retired machine. The restore panel shows the mismatch with an unchecked "Adopt the snapshot's identity — only if the machine that made it is retired" checkbox; toggling it requires a new preview.

Any restore that does not install the snapshot's `instances.json` (including a snapshot that had none when checked) excludes it from the transfer, so bytes that appear later cannot reach the live file. Because the choice is made before verification, execution re-checks it under the identity writer lock immediately before rsync starts; if the live identity changed in between (a first pairing, for example), the restore is refused with `409 BACKUP_RESTORE_IDENTITY_CHANGED` before any file is written. Whenever a restore installs `instances.json`, the memoized instance id is dropped after the transfer (even a partial one), so `getInstanceId()` and peer request headers follow the restored identity without a restart.

### Database — `restorePostgres()`

Replays the snapshot's `portos-db.sql` into the live database via `psql -v ON_ERROR_STOP=1 --single-transaction`, so the **SQL replay is atomic**: a failed replay rolls back.

**Client/server compatibility (#9925).** Preview and execution check the target PostgreSQL major version. A PG17-client dump made from PG16 can be replayed to PG16: the private replay copy omits only the exact top-level `SET transaction_timeout = 0;` header, which [PostgreSQL 17 introduced](https://www.postgresql.org/docs/17/release-17.html). PG17+ targets retain it. COPY rows, quoted functions/strings, comments, and psql `\restrict` / `\unrestrict` commands remain intact. Source bytes, manifest hashes and recovery receipts are unchanged; extension normalization and transactional rollback remain in effect. An unresolvable target major returns `restore_compatibility` with a connectivity/version-check instruction before mutation. This narrow compatibility fix does not make arbitrary newer SQL features portable to older servers.

**Dump admission (#8782).** Because the replay starts by resetting every application table, a dump that parses but stops early would commit an empty database — `ON_ERROR_STOP` cannot see a file that simply ends between complete statements, and historical snapshots carry no checksum to catch it. Before preview or execution perform reset preflight or mutations, PortOS streams the dump once and requires the plain `pg_dump` envelope: the terminal `-- PostgreSQL database dump complete` block as the last content (only the `\unrestrict` line newer `pg_dump` writes may follow it) and the `CREATE TABLE` definitions for `memories` and `memory_links`, which every PortOS dump has contained. Tables introduced later are not required, and a complete dump of empty tables is valid. A header-only or truncated dump is refused as `dump_incomplete`, and a read failure as `dump_unreadable` — never as an empty successful restore. The same streamed read supplies the manifest checksum. For execution it also writes the bytes it checked to an owner-only copy in a fresh `portos-restore-*` directory under the OS temp dir, and `psql` replays that copy rather than the snapshot path, so a dump that changes on the backup media after admission cannot be what gets restored. The copy is removed when the restore finishes, whatever the outcome; staging it needs free temp space about the size of the dump. After replay commits, PortOS forces the current additive schema upgrades and then runs ordered DB migrations using the restored `schema_migrations` ledger. Already-applied migrations are skipped. Success is returned only after both phases finish and peer sync is repaired (below); dry-run performs neither replay nor schema changes.

| Result | Meaning |
|---|---|
| `{ status: 'ok', dryRun, sizeBytes, tableCount }` | Dry-run report, or a successful real restore (which adds `syncCursorsRewound`, the number of peers rewound) |
| `{ status: 'skipped', reason: 'no_dump' }` | No `portos-db.sql` in the snapshot (or 0 bytes) |
| `{ status: 'skipped', reason: 'not_configured' }` | Real restore requested but Postgres is unreachable — refuses to half-restore |
| `{ status: 'failed', reason: 'manifest_unreadable' }` | An existing `manifest.json` is corrupt or unreadable — choose another snapshot or repair the backup media before retrying |
| `{ status: 'failed', reason: 'manifest_mismatch' }` | Snapshot's `portos-db.sql` hash disagrees with `manifest.json` — dump considered untrustworthy |
| `{ status: 'failed', reason: 'dump_unreadable', error }` | `portos-db.sql` could not be read, or its private restore copy could not be written — refused before any reset |
| `{ status: 'failed', reason: 'dump_incomplete', error }` | The dump lacks the `pg_dump` completion marker or a core PortOS table (header-only or truncated) — refused before any reset |
| `{ status: 'failed', reason: 'restore_compatibility', error }` | Target PostgreSQL major cannot be established — repair the version check and retry preview before execution |
| `{ status: 'failed', reason: 'restore_journal', error }` | The recovery journal could not be written — refused before any reset |
| `{ status: 'failed', reason: 'backup_snapshot_busy', error }` | A backup cut is active, or admitted asset publications did not drain — refused before the recovery journal or any reset; retry later |
| `{ status: 'failed', reason: 'database_restore_busy', error }` | Admitted database work did not finish within two minutes. The restore releases the snapshot cut and reopens database admission before returning. Retry after the active queries or transactions finish. |
| `{ status: 'failed', reason: 'restore_error' \| 'timeout', error }` | `psql` replay failed (stderr captured) and was **proven rolled back** from its receipt (below) |
| `{ status: 'failed', reason: 'restore_commit_unknown', error, recovery }` | `psql` did not report success and the receipt could not settle whether the replay committed — recovery pending |
| `{ status: 'failed', reason: 'restore_schema_reconciliation', error, recovery }` | The dump committed, but current schema recovery failed; **not rolled back**, recovery pending |
| `{ status: 'failed', reason: 'restore_catalog_reconciliation', error, recovery }` | The dump committed and the schema recovered, but forced catalog payload migration or universe-tag repair failed — recovery pending |
| `{ status: 'failed', reason: 'restore_sync_resync', error, recovery }` | The dump committed and the schema recovered, but peer sync could not be repaired (below) — recovery pending |
| `{ status: 'failed', reason: 'restore_recovery_release', error, recovery }` | Repair finished but the journal could not be cleared — recovery pending |
| `{ status: 'failed', reason: 'restore_recovery_pending', error, recovery }` | An earlier restore is still awaiting recovery; preview and replay are refused |

**Peer sync repair (#8710).** Memories and the seven Catalog tables federate through per-stream feed positions. A restore breaks both directions: this install's per-peer pull cursors (`data/instances_sync_cursors.json`) still point past rows the restore discarded, and the dump rewinds each `<table>_sync_feed_seq`, so new rows would reuse positions peers have already passed. Inside the maintenance window, the restore records each feed sequence before replay. After reconciliation, it sets each sequence back to at least that value and rewinds every peer's `memorySeq` and `catalogSeqs` to `0`. Brain cursors and snapshot checksums are left alone. The next sync replays each peer's streams through the idempotent last-writer-wins apply paths. A sync already in flight during the restore does not save its pre-restore cursor positions. Dry-run and failed restores change neither cursors nor sequences.

**Committed-restore recovery (#9725).** A replay that commits but whose repair then fails must neither reopen ordinary writes nor be replayed again — the next sequence value would reuse positions peers already passed, inbound cursors would still skip discarded rows, and a repeated restore would also delete anything accepted after the first replay. So, inside the maintenance window and **before** the destructive replay, the restore publishes a durable journal at `data/database-restore-recovery.json` holding a fresh operation id, the admitted dump's SHA-256, the ORIGINAL feed-sequence positions and the pending stage (`replaying`). The `psql` replay appends one `restore_receipts` row for that operation id after the dump, inside the same transaction, and runs with `application_name = portos-restore-<id>`.

- While the journal exists, every ordinary database operation in the server is refused with `503 DATABASE_RESTORE_RECOVERY` (`server/lib/db.js`); only the maintenance context that owns that operation may inspect or repair. The fence survives restart.
- A recovery attempt that hits the database drain deadline returns `409 DATABASE_RESTORE_BUSY`. The existing journal and its fence stay in place. Retry **Resume recovery** after active database work finishes.
- `psql` exit 0 means the replay committed (stage `repairing`). Any other outcome — an SQL error, a timeout kill, a lost connection at `COMMIT` — is settled from the receipt: no live `portos-restore-<id>` session and no receipt is a **proven rollback**, which clears the journal and reopens admission with current rows intact; a receipt is a commit; anything else (a replay session still alive, an unreachable database) stays fenced as `restore_commit_unknown`.
- Repair runs forced schema upgrades, ordered migrations, feed-sequence flooring at the **recorded** positions (never re-read after the replay) and the inbound cursor rewind. All steps are idempotent. Admission reopens only after every step succeeds, the journal is removed, and its parent directory is synced.
- If journal unlink fails, the durable record remains pending. If unlink succeeds but directory sync fails, the journal instance retains the operation and original feed positions in memory: status and ordinary database admission stay pending, and same-operation recovery retries finish directory sync. On a fresh process, a surviving journal invokes idempotent repair; if deletion persisted, completed repair needs no destructive replay. This process-local retry cannot provide stronger crash guarantees than the filesystem.
- **Resume**, never repeat. Settings → Backup shows the pending operation with a **Resume recovery** action (`POST /api/backup/restore-db/recover` with the operation `id`), and `GET /api/backup/status` reports it as `restoreRecovery`. Restarting PortOS resumes it automatically before any route, scheduler or writer loads (`server/start.js`); if recovery still fails, boot is refused with the reason in the server log and the fence stays closed. Recovery never runs the reset or the dump again, and starting another restore is refused (`restore_recovery_pending`) until this one finishes.
- An unreadable or damaged journal fails closed: the database stays fenced and boot is refused. Inspect the file and the logs; do not delete it unless you have established how the restore ended (with the database reachable, `SELECT * FROM restore_receipts WHERE operation_id = '<id>'` answers whether it committed).

Reconciliation can partially apply upgrades; it is separate from the completed replay transaction, which is why it is retried rather than rolled back.

A non-dry-run restore requires a reachable DB first (`checkHealth()`), so a restore never half-applies against a down database.

### Backend export / sync — `POST /api/database/sync`

Separate from snapshot restore: `server/routes/database.js` can copy data **between** the native (port 5432) and Docker (port 5561) Postgres backends. It exports the active backend with `pg_dump`, ensures the target backend has the `portos` role/database/extensions, then imports under `ON_ERROR_STOP=1 --single-transaction`. `POST /api/database/export` produces an on-demand dump under `data/db-dumps/`. These power the Database settings tab's mode-switch/sync flows; they are independent of the rsync snapshot backups above.

## Retention & deletion

A database record deleted from PortOS can still be restored from any snapshot that captured it, including Privacy Vault records, consents and broker cases. Set `backup.retentionCount` per source.

- **New installs default to 30 completed snapshots.** Only newly seeded settings receive that default. Choose 1–365 or Unlimited in Backup settings. An absent or `null` setting means Unlimited, which preserves every completed snapshot.
- **A completed healthy run triggers pruning.** A degraded run keeps older snapshots and reports zero pruned. A prune failure is logged and the backup stays successful.
- **Pruning only affects the current machine's namespace** (`snapshots/<hostname>/`). It preserves active and ordinary failed snapshots, other machines' snapshots and the legacy pre-namespace root. Interrupted snapshots do not count toward the limit. Even with Unlimited, a healthy run removes interrupted snapshots older than the newest completed point (#12618). A snapshot in use by a restore or download is skipped until a later run (see [Snapshot source lifetime](#how-restore-works)).
- **Unreadable or invalid manifests stay outside the count.** Retention shares file restore's structural checks for field, count, path and SHA-256 shape. It orders snapshots by ID, so a future-dated invalid manifest cannot displace a healthy snapshot.
- **PostgreSQL retention uses dump metadata.** A snapshot needs a nonempty regular `portos-db.sql` file, plus a dump entry if it has a manifest. Incompatible legacy metadata also disqualifies a manifested snapshot. These checks do not reread the dump. Excluded snapshots stay available for manual recovery. In explicit file-backend mode, valid manifests and pre-manifest snapshots remain eligible without a dump.
- **`DELETE /api/backup/snapshots/:snapshotId?source=<source>`** (`backup.deleteSnapshot()`) permanently removes exactly the selected source/ID pair, immediately — there is no undo and it is never automatic. It shares `resolveSnapshotPath()`'s path-traversal and symlink guards with restore/download, and refuses a snapshot that is still being written (`SNAPSHOT_INCOMPLETE`) or that a restore or download is still reading (`SNAPSHOT_IN_USE`); unlike restore, a `.failed` or interrupted snapshot **is** deletable. The Backup settings tab's snapshot history exposes this as a per-row delete action behind a confirmation dialog.

## Scheduling & status

- Daily backups are driven by `backupScheduler.js` via the `backup-daily` cron event; `getNextRunTime()` reports the next run.
- **The registration tracks settings — no restart needed.** `syncBackupSchedule()` runs at boot *and* on every settings save (subscribed to `settingsEvents`' `settings:updated`), so enabling backups or setting `destPath` when scheduling was previously inactive registers the cron immediately, editing `cronExpression` re-registers it, and disabling backups (or clearing `destPath`) cancels it. A save that doesn't change the registration inputs (cron expression, timezone, active/inactive) is a no-op — `destPath` and the exclude lists are re-read by the handler per run, so changing them never churns the registration.
- **Boot catch-up requires a complete snapshot.** Once per boot, a missed slot schedules a catch-up after five minutes, unless backup configuration or timezone changed after that slot. `lastRun` records the latest attempt; `lastSuccessfulRun` records the latest complete snapshot and survives later failed or database-degraded attempts. Legacy state without that field counts `lastRun` only when its status is `ok`.
- `GET /api/backup/status` surfaces the persisted state including the last `pgBackup` outcome, so the Backup settings tab shows whether the last DB dump succeeded, its size, and table count.

### Omitted schedule fields

The backup settings slice is stored **sparsely** — an install where the user only ever typed a destination has no `enabled` and no `cronExpression` on disk. `server/lib/backupConfig.js` is the single module that says what those omissions mean, and every consumer resolves through it:

| Stored | Effective |
| --- | --- |
| `enabled` absent | **enabled** — an omitted toggle has never meant "off" on the server, and changing that would silently stop nightly backups on existing installs |
| `cronExpression` absent or blank | `0 0 * * *` (midnight, in the user's timezone) |
| `destPath` absent or blank | **nothing is scheduled**, whatever `enabled` says |
| `retentionCount` absent or `null` | **unlimited** — nothing is pruned. A NEW install ships an explicit `30` in `data/settings.json` (see [Retention & deletion](#retention--deletion)); an existing install's absence is never reinterpreted as that default. |

`GET /api/settings` projects these effective values over the stored slice, so the Backup settings tab renders exactly what the scheduler will do. **The client owns no fallback of its own** — it used to read the same sparse config as "disabled at 02:00" while the scheduler read it as "enabled at midnight", so saving an unrelated preference wrote that misreading back and cancelled a live schedule (#6632). If a settings response ever arrives without a resolved schedule the tab shows a load error instead of a form, rather than saving invented values.

This is **read-time resolution only**: nothing on disk changes, sparse configurations stay valid, and older clients can keep submitting the same partial shape.

## See also

- [Storage Classification Contract](./STORAGE.md) — which data lives in Postgres vs files (and therefore which half of a snapshot captures it).
- [`docs/plans/2026-06-05-verified-pg-backup-design.md`](./plans/2026-06-05-verified-pg-backup-design.md) — design rationale for verified, restorable DB backups.

- [Backup and restore runbooks](./BACKUP_RUNBOOKS.md) — database backend migration, older-snapshot restore, in-server store restores, maintenance admission.
- [Shared backup publication admission](./BACKUP_PUBLICATION_ADMISSION.md) — how snapshots stay consistent while assets change.
