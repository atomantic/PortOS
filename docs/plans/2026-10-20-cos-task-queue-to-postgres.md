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

## What shipped

Step one was an interim completed-task archive (`cos_task_archive`). Once hand
editing was ruled out, keeping a second table beside the Markdown files made no
sense, so the end state replaced it: ONE table, no files.

- `cos_tasks` (one row per task, key `(source, task_id COLLATE "C")`) and
  `cos_task_lists` (a per-queue write version).
- A task is stored in its **stored form**: the old Markdown round-trip's
  normalization (`lib/cosTaskRows.js#storedForm`). Many consumers handle scalar
  metadata read back as strings; storing anything else would have changed their
  behavior as a side effect. Typed metadata is a separate cleanup.
- `position` is a fractional tie-break inside a status+priority, so insertion
  anywhere is a midpoint and a reorder rewrites only the moved rows
  (`assignPositions`, longest-increasing-run).
- Callers read the **working set**: open tasks, completed in the last 3 days, and
  the newest 100 completed. Older history is reached by id and by paged
  `view=completed`; nothing loads it wholesale. No sweep is needed, because the
  working set is a query, not a file that has to be trimmed.
- The store's cache is validated by the queue version (one single-row read) and
  updated in place by its own writes. A save is `planListSave`: diff the list
  against the stored working set, write only changed rows in one transaction.
- Concurrent writers are still serialized by the CoS state lock; the win is that
  a write is a few rows instead of the whole file, and no reader parses anything.
- The file watcher and its routes, socket forwards, client listeners and config
  keys are gone. It was not running on installs that start the CoS at boot, and
  the store's own `tasks:changed` event was always the real signal.

## Upgrading existing installs

Data standards are updated by migration, not carried as runtime fallbacks:

- **018** imports the Markdown files (at the location the install's CoS config
  named, else the defaults), folds in `cos_task_archive` and drops it, verifies
  every parsed task landed as a row, and bumps the queue versions. It is
  input-gated and ships no seed.
- **019**, which runs only after 018 has committed, renames each file to
  `<name>.imported` (the recovery copy) and drops the retired config keys.
- `data.reference/` no longer ships the two files.

Rolling back to a release that reads the Markdown files finds no files; restore
them from `*.imported` first.

## Follow-ups (not in this change)

- Agent status and activity still contend on `data/cos/state.json` (one 4 MB
  file, one lock). Moving it is a separate design.
- True per-row concurrency (dropping the state lock around task writes) now
  becomes possible and is a separate change.
- Typed metadata (stop round-tripping scalars through strings) would let the
  `isTruthyMeta`-style helpers retire.

## Verification

- `lib/cosTaskRows.test.js`: stored form, working-set rule, position assignment,
  save planning. `services/_cosTaskRepositoryContract.js` runs the same
  assertions against the in-memory backend and, in `npm run test:db`, PostgreSQL.
- `services/cosTaskStore.test.js`: cache behavior (hit, in-place update, version
  reload, cold-read coalescing, overlapping read and write), views, unique ids,
  history older than the working set, peer merge, and the interleaved-writer races.
- Migrations 018/019: unit tests over real fixture files, plus a real-PostgreSQL
  test (CI) that imports a 230-task queue with awkward text, folds the archive
  table, and checks every task byte-for-byte.
- After deployment: `data/*.md` are gone (kept as `*.imported`), the queues read
  the same, and `readTaskFile` clone volume and server RSS stay low.
