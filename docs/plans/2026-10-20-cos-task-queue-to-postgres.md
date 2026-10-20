# CoS task queue to PostgreSQL

Approved 2026-10-20. Supersedes the "file-primary because direct editing and
watchers are supported inputs" position in `docs/STORAGE.md`.

## Context

`data/TASKS.md` and `data/COS-TASKS.md` reached ~33 MB and ~29 MB on a busy
install (~3,100 tasks, nearly all completed, none ever pruned). The bulk is the
`prompt` field: a finished task keeps its full slashdo command text (one entry is
2.3 MB, several are ~500 KB). Every full-queue read (`getAllTasks`, `getCosTasks`)
clones that parse tree, ~100 MB per clone, and a cold parse of both files holds
~430 MB resident. That was a measured driver of `portos-server` reaching PM2's
4 GiB RSS ceiling and restarting mid-agent-spawn (97 logged restarts, 12 in one
day). Agent status and activity also contend on a single `withStateLock` queue
that rewrites whole files.

The only reason the queues stayed file-primary was that hand-editing the Markdown
and watcher-driven updates were supported inputs. The owner has retired that
contract: nobody needs to edit these files by hand. With it gone, nothing about
the data fits a file better than a table, and the repo already requires every
install and federated peer to run PostgreSQL.

## Step one: completed-task archive (this change)

- Table `cos_task_archive (source, task_id, description, completed_at, archived_at,
  task jsonb)`, key `(source, task_id COLLATE "C")`. `COLLATE "C"` matches the
  JavaScript code-unit order every consumer already uses for newest-id-first paging.
- `archiveCompletedTasks()` in the 15-minute CoS health check moves a completed
  task out of the file when it is at least 3 days past its stamp (undated = oldest)
  AND beyond the newest 100 completed per queue, at most 300 per queue per tick.
  Archive write first (idempotent), then the file rewrite, all under the same
  state lock as every task write: a crash leaves a duplicate, never a loss.
- Reads fall through when the file misses: completed-history pages (merged across
  file window and archive, file copy wins), `completedCount`, a selected archived
  task in the queue view, `getTaskById`/`findTaskWithSource`, `deleteTask`.
- Consumers audited for old-completed reads: `screenshotsGc` ignores terminal tasks;
  the PR-reviewer-failure lookup only needs a recent marker; `character.syncTaskXP`
  would lose XP for a task archived before a sync, so it also reads archived
  summaries (id + description, no prompt bodies).
- Federation: the archive is machine-local. Peers advertise and merge only their
  own files; `mergePeerTasks` drops an incoming completed task this machine already
  archived so a peer cannot resurrect it.
- No migration or seed. The table is additive; the first sweeps drain the existing
  backlog (300 per queue per tick, ~90 minutes for a ~1,600-task queue). Backup is
  the Postgres dump.

## Step two: the open queue (next)

- Per-row storage for open tasks, replacing whole-file read-modify-write: concurrent
  agents update their own row instead of queueing on one file.
- Writers emit `tasks:*` events at the write; `taskWatcher.js` (chokidar over both
  files, snapshot diffing) and the file-stamp parse cache go away.
- `mergePeerTasks` / `buildCosTasksPayload` keep their claim-aware per-task LWW
  semantics over rows.
- Migration imports both configured Markdown sources without losing task metadata
  or order, retains a recovery copy of each file, and gates on the presence of the
  input (the files), never on the absence of the output.
- The Markdown files become a one-time import input only.

## Verification

- Store tests cover the sweep (age floor, newest-N floor, oldest-first under the
  limit, idempotence, crash between archive and rewrite), the fall-through reads,
  delete, and the no-resurrection merge; each was checked to fail with its behavior
  removed. The file backend is covered in `cosTaskArchive.test.js`, the Postgres
  backend in `cosTaskArchive.db.test.js` (`npm run test:db`).
- After deployment: `data/TASKS.md` / `COS-TASKS.md` shrink to the open queue plus
  the recent window; steady-state server RSS and the `readTaskFile` clone volume
  drop; the Tasks page still pages through full history.
