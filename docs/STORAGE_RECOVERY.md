# Storage Recovery Procedures

Operator recovery procedures for PortOS storage. The storage classes and the new-store checklist live in [STORAGE.md](./STORAGE.md); backend cutover lifecycle and recovery live in [DATABASE_MAINTENANCE.md](./DATABASE_MAINTENANCE.md). Each store's classification is recorded in its module header.

## Workflow maintenance journal

Graceful maintenance uses `data/workflow-maintenance/state.json` as a **file-primary,
machine-local runtime journal**. It must fence both the API and standalone CoS runner
before either can use PostgreSQL or start work. Its bounded live-operation set and
operator hold are not app records and never federate. Data snapshots copy the
`workflow-maintenance/` subtree as evidence, but no restore ever installs it (see
`scripts/reconcile-maintenance-reservations.mjs` for reservation recovery).
The schema is versioned; an absent file starts Normal, while corrupt/future state or
an interrupted transaction fails closed. Replacement uses exclusive directory locking,
file/directory fsync and atomic rename. No seed or DB migration is required.

Normally readiness follows release of every admitted agent, persistent-mind turn,
provider run, media render (including its browser/export preparation), and scheduled
shell/script after final saving and cleanup. An inactive legacy reservation can also
be dispositioned as described below; that records unknown output rather than a
successful save. This includes federated jobs dispatched
by this instance, through remote completion and verified local publication; a peer
being unreachable is not completion. New peer dispatch stays held. A held restart
retains unresolved remote ownership without replaying an unknown submission.
Idle daemons, queued work, independently
operated browser sessions and unrelated host apps do not count. Maintenance never
cancels work, replays a paid submission, or enables a previously disabled policy.
Resume removes the identified hold only; a stale request cannot remove a later hold.

The same journal also has one optional exclusive-maintenance ownership slot and
one last settlement receipt. They fence admission/resume before the DB is usable,
bind the current operation to its hold and verified evidence, and survive restart.
They are coordinator authority, **not a parallel execution audit/replay ledger**:
the last receipt is bounded recovery evidence, not permanent request consumption.
The peer execution ledger remains receiver-local `db-primary` (`server/services/peerExecutionLedger.js`).
Neither a missing verifier nor timeout/restart releases an in-flight owner.
Older strict journal readers reject the added fields and fail closed; reverting
to one cannot resume a claimed hold. Old unclaimed v1 journals still read normally.

Operation age or a dead PID is not proof of saved output. On restart, the journal keeps
unresolved ownership; runner survivors reconnect to their existing operation. A lost
worker or failed save can be recovered through its owning service; inactive legacy
admission can also receive an explicit unknown-output disposition. An interrupted
journal transaction needs its own recovery. There is no age-based force-Ready/expiry
button. Resuming an unresolved hold permits new work but does not
certify the old work finished. Do not delete this journal to claim readiness; preserve it
with the related run/job records for recovery. A backup restored on another installation
therefore starts conservatively if it contains a hold or outstanding operations.

On server boot, and again when orphaned agents are swept, a settled `Output publication`
reservation whose admitting pid is dead is marked unsettled and given an uncertainty
stamp. That does not release it. A live pid is left untouched, and an already-unsettled
stamp is not rotated. A dead-owner `cli-run` is released only when that run's metadata
already has an end time, which is published before the reservation is finished. A
dead-owner `mind-turn` is released only when the persisted mind record has no active
turn, including after restart recovery of an orphaned turn. A dead-owner `provider`
reservation names a caller label, not a run, so it is left in place. Other kinds are
not inferred from a dead pid alone. While an update is waiting, a separate idle
reconciler checks current activity, runner ownership, known agent PIDs and the
journal before recording an automatic unknown-output disposition for inactive
ordinary reservations. It does not infer that the historical output was saved.

Publication admission keeps a maintenance reservation while waiting for a backup
cut. A boundary-owned callback-start check retires a refused admission without
claiming any output was saved; failures after callback entry remain unresolved.
Legacy generic `Output publication` reservations lack destination/batch identity.
They cannot be swept as finished work. A dead admitting process is recorded as
uncertainty, not deleted. After explicit operator disposition of
inspected evidence, use `scripts/reconcile-maintenance-reservations.mjs` to
retire the unsettled reservation. This does not certify a complete
transcript, clear transcript warnings, or change the original task outcome.

### Interrupted maintenance transactions

An interrupted journal write stays fail-closed across restarts. Settings → General
→ Graceful maintenance reports `interrupted-transaction` and the lock time,
`unreadable-journal` for damaged/incompatible state, or `process-uncertain` when
this process could not confirm a write. The first transaction failure logs its
original error code and message; repeated refusals do not flood that diagnostic.

Inspect the logs and resolve disk-space or I/O problems first. From the install
directory, stop both PM2 apps and any standalone processes using this journal:

```bash
pm2 stop portos-server portos-cos
node scripts/recover-maintenance-transaction.mjs --confirm "Inspected interrupted transaction and resolved disk problem"
pm2 start portos-server portos-cos
```

Use your actual recovery reason. From a reviewed isolated checkout, set
`PORTOS_DATA_ROOT` to the install root (the parent of `data/`). The command refuses
live/transitioning PM2 ownership, an unreadable PM2 inventory, an invalid/future
`state.json`, or linked/non-regular journal evidence. Restore compatible code or
recover damaged journal data separately before retrying; never delete valid
operations or replace damaged state with an empty journal to bypass this check.

Recovery preserves the original state, `transaction/`, every `pending-*.json`,
and a receipt recording the operator reason, lock mtime, pending sizes, original
state hash and retained hold under `data/workflow-maintenance/recovered-<timestamp>-<id>/`.
It publishes a **Transaction recovery** hold before moving the lock when no hold
exists; an existing hold and every operation/exclusive owner remain intact.
A failed repair retains admission fencing and evidence; after addressing its
cause, repeat the confirmed command. The runtime `transaction/` lock never expires
or gets removed by PID. Recovery commands serialize through a separate `recovery/`
fence with an atomically published owner. A proven dead recovery PID permits a
retry to preserve that fence under `recovery-interrupted-<id>/` and continue.
Unknown ownership or an interrupted `.transition` remains closed: keep both apps
stopped, stop every recovery command, inspect and preserve the whole `recovery/`
directory under a unique sibling name, then repeat the confirmed command. Never
remove the runtime `transaction/` evidence. Starting both apps clears their in-memory uncertainty, but does
not clear the hold or certify that unresolved work finished.

After restarting, refresh maintenance status. A **Transaction recovery** hold
keeps new work fenced while you review the remaining blockers. To use the
operator disposition command, choose **Resume previous policies**, immediately
begin a normal operator hold, and wait for any work admitted during the hand-off
to finish. Inspect and reconcile under the new hold, then resume again when
ready. If recovery preserved a normal operator hold, use that hold directly.
With no unresolved operations the hold is Ready. Otherwise it is Draining.
Recovery archives stay in the same backed-up, machine-local subtree:
snapshots retain them as evidence and restores preserve the current subtree
byte-for-byte, including archives, rather than installing a snapshot's authority.

When the maintenance journal volume has less than 1 GiB available to PortOS,
the banner warns about low disk space and admission pauses new agent starts.
An unreadable free-space check also pauses starts and displays its own warning.
Existing agents remain eligible to finish and settle. The banner updates as the volume recovers
and PortOS rechecks its queue under the existing policies. The free-space check
checks headroom at admission time, so a separate writer can still fill the
volume afterward.

### Inactive reservations while updating

When an update is waiting, PortOS automatically checks current activity and
recorded process identities. If ordinary reservations have inactive owners, it
retains their exact records in a durable `automatically-abandoned` receipt with
output completeness `unknown`, then lets the waiting updater try admission
again. A journal revision check fences the activity snapshot; the updater takes
its hold under the same lock as new admissions. A racing job therefore either
becomes a blocker or is refused after the update takes the hold. Unknown activity,
live owners, unsupported reservation kinds, and active maintenance owners wait.
This does not retire release-candidate publication ownership, change job
outcomes, or establish whether an untracked detached historical child exited.
Agent and runner reservations require a positively identified ordinary task;
release-related and unclassifiable owners remain. Workspace and process-table
checks are best effort for legacy children, and any inspection limitations are
recorded in the receipt.
An older producer that does not use the admission journal cannot be fenced by
that journal: the updater checks for observable legacy processes, but cannot
atomically prevent such a producer from starting after the process snapshot.
Automatic reservation disposition and remote status checks run in the server.
If it is offline, stale journal reservations or a retained remote request can
keep a direct update waiting until the service is available to reconcile them.
Windows cannot scope a relative PowerShell updater by working directory with the
built-in probes, so an observed relative updater is allowed to finish first.
If a completed accelerator claim cannot be removed promptly, its adjacent
`.completed.json` marker records the finished claim token and PID, not output
success. A marker for another token cannot retire the current claim, and a
handed-off child still blocks while it is live.
Before another local accelerator job starts, existing trainer control files are
checked against the live process table, including PID reuse and zombie state;
the historical controls themselves are not removed by this check. An unavailable
process inventory refuses the new job until the check can run.
Accelerator claims require same-directory hard links in the data directory; a
filesystem or permissions that do not support them cause
`HEAVY_CLAIM_LINK_UNSUPPORTED`. Use a data filesystem that permits hard links
to run local accelerator jobs.

### Operator disposition of inactive reservations

An operator can retire inactive admission bookkeeping when old work has no
recoverable completion receipt. This records **operator-disposed**, with output
completeness **unknown**; it does not change the job or agent outcome, delete
outputs, or retire a release candidate. Release-candidate publication and
ownership checks remain separate.

First enter a normal operator maintenance hold in Settings → General → Graceful
maintenance. This supersedes and cancels a direct update that is still waiting;
queued work remains queued. Wait for running work to finish. From the install
checkout, or a reviewed checkout with its own dependencies, run:

```bash
umask 077
node scripts/reconcile-maintenance-reservations.mjs inspect --install-root /absolute/path/to/PortOS --reason "Reviewed inactive work" > /tmp/portos-reservation-request.json
# Review the request; remove entries from operations to select a smaller set.
node scripts/reconcile-maintenance-reservations.mjs reconcile /tmp/portos-reservation-request.json --install-root /absolute/path/to/PortOS --confirm-disposition
```

The inspection and disposition each query the running install's activity and
runner, bind the response to that install's hold, and refuse running or
unreadable work. They check the recorded owner PIDs, the exact reservation
contents, and the journal revision again before removal. Keep the request file
private: it contains resource identifiers. The default API origin is the local
HTTP mirror at `127.0.0.1:5553`; use `--api-origin http://127.0.0.1:5555` when
the API is HTTP without the mirror. If the install uses a custom local runner,
pass its configured origin with `--runner-origin`. Credentials follow
`scripts/portos-api.js`; they are sent only to the local API, not the runner.

The journal retains a durable receipt containing each original reservation, the
local operator and reason. This acknowledges uncertain output and detached child
status. A dead-owner `runner` reservation is eligible when the running install
can identify its completed agent as ordinary work and process checks find no
survivor. Live, missing, unclassifiable and release-related owners stay in place,
as do separate agent, update, harness, exclusive-maintenance and release ownership
records. After reviewing the remaining blockers, resume the hold and retry the
update. Leave the journal files in place.

### Unsettled generic output publications

Use `scripts/reconcile-maintenance-reservations.mjs` (see above) after journal
transaction recovery, with a normal maintenance hold in place. It never steals
an interrupted transaction lock, resumes a hold, or settles an exclusive
maintenance owner. Run from the install checkout. From a reviewed isolated
checkout, append `--install-root <absolute-install-root>` (the parent of `data/`)
to each command. This explicit target does not depend on the inherited
`PORTOS_DATA_ROOT` pin, which worktree code deliberately ignores.

Generic reservations contain no parent, destination, run, or batch identity. The
operator must trace the owning workflow and explain how its records relate to
the **selected** reservation; never assign evidence merely by PID or age. Diagnose
lists admitted owner IDs and their source modules from `backupAssetOwners.js`.
Relevant examples:

| Owner | Evidence to inspect |
|---|---|
| `toolkit-recording-publication`, `runtime-recording-publication-tails`, `agent-run-recording-publication` | Matching run metadata, output, retained agent spools (`output.txt` / `raw.txt`), and durable failure/warning records. Trace recording creation, spool writes and finalization; terminal metadata alone does not prove a complete transcript. |
| `cos-agent-archive-and-index-publication` | Agent/archive identity, archive/index records, retained output and the publication failure. |
| `media-job-completion`, `image-generation-completion-tails`, `generated-video-shared-finalizer` | Exact job/run identity, sidecars/history or inspected database-record evidence, and output integrity or the durable publication failure. A provider completion alone does not prove local publication. |

Other admitted owners require the same record-plus-output/failure inspection of
their listed source modules. If the relationship cannot be established, keep the
reservation and recover through its owning service. For DB-primary records, save
a bounded, private inspection artifact with exact record identity under `data/`;
do not copy credentials or a whole database into an evidence file. Preserve large
media separately and use its owning service's integrity/failure evidence here.

Example `evidence-spec.json` (invented paths; replace every explanation after
actually inspecting the records):

```json
{
  "ownerId": "toolkit-recording-publication",
  "binding": "Describe the exact run identity and evidence linking its interrupted publication to the selected reservation.",
  "reason": "Explain the inspected failure and why this specific uncertainty is being acknowledged.",
  "files": [
    { "path": "runs/example-run/metadata.json", "role": "record", "note": "Describe the inspected run identity and unchanged outcome." },
    { "path": "runs/example-run/publication-failure.txt", "role": "failure", "note": "Describe the inspected publication failure and retained output limitations." }
  ]
}
```

Evidence uses distinct ordinary data-relative files, without symlinks or journal
files: a nonempty owner `record` plus nonempty `output` or `failure`, at most
16 files / 16 MiB total. The request binds SHA-256 hashes and lengths, inspection
notes, owner, relationship, reason, exact hold, original operation and uncertainty
stamp. Preserve both evidence files and the inspected request. Empty output,
process exit and elapsed time never establish saving. A live or unproved admitting
process refuses disposition; process exit is only a prerequisite, never evidence
of completeness.

Reconciliation rechecks evidence under the journal transaction lock, fsyncs a
no-replace `data/workflow-maintenance/publication-<operation-id>-<stamp>.json`
receipt, then retires only that exact owner. Repeating the **same** request reuses
the matching receipt, including a receipt-first interruption after normal journal
recovery. A missing owner cannot mint a receipt. Stale holds/operations/stamps,
missing/changed evidence, incompatible receipts, exclusive ownership, and failed
receipt persistence retain ownership. Refusals name the next inspection/recovery
step; never edit the request's hashes to bypass them. The hold and every other
operation remain; run/task outcomes and transcript warnings stay unchanged.
`acknowledged-uncertainty` with `outputCompleteness: "unknown"` records an operator
disposition, **not** successful saving. These machine-local receipts share the
backup/restore exclusions described below; they
have no seed, migration, federation or automatic expiry.

### Machine-local maintenance receipts

Manual reservation reconciliation uses `node scripts/reconcile-maintenance-reservations.mjs`
(`inspect` / `reconcile`). Its receipts and the journal are machine-local and never
federated or restored: a data snapshot copies the `workflow-maintenance/` subtree, but
every file restore (full or scoped, preview and execution) preserves this machine's copy
byte-for-byte and refuses an explicit selection with `BACKUP_RESTORE_MACHINE_LOCAL`,
because installing another snapshot's journal or receipts would replace local authority.
Historical `abandoned-<run-id>.json` receipts from the retired single-agent command
remain under the same exclusion. To use a receipt as an investigation artifact elsewhere,
copy it out of the snapshot or the live data directory separately.


## Retrying incomplete legacy creative imports

The Series, Pipeline Issues, Story Builder, Universe and Writers Room file-to-DB
importers withhold their domain completion marker while a source is malformed,
unreadable, invalid, or cannot be parked. Healthy rows remain available in
PostgreSQL. Repair the affected canonical JSON from a backup, resolve filesystem
errors, then restart: the next import retries without replacing existing DB rows.
Whole-directory imports keep their canonical directory until verification
completes. Writers Room prose and Series manuscript-review siblings stay in place.
A pre-existing recovery copy is preserved; if it prevents parking a repaired
canonical file, archive that older copy separately before retrying.

An older release may already have stamped a premature marker. Do **not** clear
all migration markers or move entire historical directories back into service:
that can resurrect records intentionally deleted since migration. Instead, run
this explicit recovery command from the install checkout with its normal database
connection configuration (after database setup has completed):

```bash
# Read-only inventory of canonical and parked recovery sources and DB presence.
node server/scripts/recoverLegacyImports.js

# Preview only the IDs you intend to restore.
node server/scripts/recoverLegacyImports.js --id series:ser-example --id issue:iss-example

# Apply that exact selection after checking the preview.
node server/scripts/recoverLegacyImports.js --id series:ser-example --id issue:iss-example --apply
```

No arguments means **dry-run**. The command reports `missing`, `exists`,
`invalid-source`, `invalid-record`, or `not-found`; application reports `inserted`
for newly restored rows. It inspects both canonical sources and `.imported`
recovery copies, preferring a valid canonical record when the same ID appears in
both. Fix invalid sources before applying a selection. It never changes source
files or migration markers, and every insert retains `ON CONFLICT DO NOTHING` so
existing rows, including soft-deleted rows and newer edits, remain authoritative.

Selection kinds are `series`, `issue`, `story`, `universe`, `run`, `work`, `draft`,
`folder`, and `exercise`, each followed by `:` and the original record ID.
Selection is per database row: selecting a Writers Room work does **not** select
its historical drafts; include each wanted `draft:<id>` explicitly. Likewise,
select required parent records (for example a series for an issue) separately.
Recovery is never run automatically at boot. Keep a backup while verifying the
restored records in the UI; this command cannot recover artifacts already pruned
from disk, so those must first be restored from a backup.
## Catalog generated-column rewrite

Catalog schema v2 expanded `catalog_ingredients.search_tsv`, a stored generated column, to index `physicalDescription`. PostgreSQL cannot alter a stored generation expression in place, so the compatibility path drops and re-adds the column on an upgrading v1 install. Adding it back computes the value for every existing ingredient and holds an `ACCESS EXCLUSIVE` lock on `catalog_ingredients` for the rewrite; the following GIN index recreation adds its own write-blocking build window. Reads and writes that reach this table from another still-running PortOS process wait behind those locks.

PortOS deliberately accepts this **one-time, boot-time maintenance window** instead of carrying a second shadow column, trigger, batched-backfill checkpoint, and recovery protocol indefinitely. The expression check in both schema sources makes the path bounded by state: fresh installs add the column to an empty table, v2 installs skip the rewrite, and only a pre-v2 catalog pays the row-proportional cost. `ensureSchema()` completes before the new server reports ready, so it never exposes a partially upgraded catalog.

For an install with an unusually large pre-v2 catalog, treat the update as planned maintenance:

1. Take a normal PortOS backup before updating.
2. Stop other PortOS processes that can use the same PostgreSQL database; federated peers use their own databases and upgrade independently.
3. Run the normal update during a low-use window and allow startup to finish without interruption. There is no safe universal duration estimate: row count, payload size, disk speed, and PostgreSQL settings all affect the rewrite.
4. Wait for the `Database schema upgrades applied` startup log before resuming use. If startup is interrupted, rerun the normal startup; the expression gate and `IF NOT EXISTS` statements safely converge on the v2 shape.

## Codex image usage backfill

Historical import is explicit and never runs at boot. From the repository root:

```sh
node scripts/backfill-codex-image-usage.js --data-dir <install>/data --report <private-plan.json>
node scripts/backfill-codex-image-usage.js --data-dir <install>/data --apply <private-plan.json> --journal <private-journal.json>
```

Review the dry-run coverage before applying. The importer reads only PortOS
image sidecars and completed queue metadata, excludes known derived copies,
groups multiple outputs per session, and uses saved original timestamps rather
than filesystem mtimes. It never reads provider sessions. Unattributed sidecars,
unsaved/failed calls, unavailable token/cost/allowance data and historical
execution-machine provenance remain unknown. A changed inventory requires a new
dry run. The plan and journal must use new paths; existing files are never
replaced. Neither operation mutates `usage.json`, sidecars or queue history.

Before writing receipts, apply saves a journal with a unique batch ID. Every
inserted receipt carries that `backfillBatch`; pre-existing/live receipts retain
their original bytes. An interrupted batch can be rerun with a new journal path
and the same plan when the source inventory is unchanged. For recovery, retain
the journal and move only receipts whose `backfillBatch` matches that journal to
a private archive outside the ledger, verifying preservation before removal.
This also identifies additions made before a crash prevented the final journal
update. Never restore an old `usage.json` over newer usage to undo this import.
No migration or seed is required: this is a new optional ledger, absent until a
live completion or an explicit import publishes its first receipt.
