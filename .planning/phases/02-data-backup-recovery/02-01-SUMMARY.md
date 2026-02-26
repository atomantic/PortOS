---
phase: 02-data-backup-recovery
plan: "01"
subsystem: backup
tags: [backup, rsync, scheduler, api, validation]
dependency_graph:
  requires:
    - server/services/eventScheduler.js
    - server/services/settings.js
    - server/lib/fileUtils.js
    - server/lib/errorHandler.js
    - server/lib/validation.js
  provides:
    - server/services/backup.js
    - server/services/backupScheduler.js
    - server/routes/backup.js
  affects:
    - server/index.js
    - server/lib/validation.js
    - client/src/services/api.js
tech_stack:
  added:
    - rsync (system binary, /usr/bin/rsync)
    - Node.js crypto.createHash (SHA-256)
    - Node.js fs.createReadStream (streaming hash for large files)
  patterns:
    - Rsync incremental backup with itemize-changes and exit code 24 tolerance
    - SHA-256 file manifest with size-based streaming threshold (512KB)
    - eventScheduler cron integration (mirroring brainScheduler pattern)
    - asyncHandler + validateRequest route pattern
key_files:
  created:
    - server/services/backup.js
    - server/services/backupScheduler.js
    - server/routes/backup.js
  modified:
    - server/lib/validation.js
    - server/index.js
    - client/src/services/api.js
decisions:
  - "Used fs.createReadStream (not fs/promises) for streaming hash — createReadStream is only available on the synchronous fs module"
  - "Exit code 24 accepted as success — rsync code 24 means files vanished mid-transfer, normal for active systems"
  - "startBackupScheduler is async (reads settings) and called with .catch() in index.js to match other async inits"
metrics:
  duration: 135s
  completed: 2026-02-26
  tasks_completed: 2
  files_created: 3
  files_modified: 3
---

# Phase 02 Plan 01: Backup Engine and API Summary

**One-liner:** Rsync-based incremental backup engine with SHA-256 manifests, daily cron scheduling via eventScheduler, and a complete REST + client API.

## What Was Built

A complete backup infrastructure for PortOS data:

1. **`server/services/backup.js`** — Core backup engine with 7 exports:
   - `runBackup(destPath, io)` — spawns rsync to copy `data/` to a timestamped snapshot directory, generates manifest, saves state
   - `generateManifest(snapshotDataDir, manifestPath)` — walks snapshot files, hashes each (streaming for 512KB+), writes `manifest.json`
   - `listSnapshots(destPath)` — reads snapshot directories, returns metadata sorted newest-first
   - `restoreSnapshot(destPath, snapshotId, { dryRun, subdirFilter })` — reverse rsync from snapshot back to live data
   - `getState()` / `saveState(patch)` — persist backup state to `data/backup/state.json`
   - `getNextRunTime()` — delegates to eventScheduler's `getEvent('backup-daily')`

2. **`server/services/backupScheduler.js`** — Reads settings, conditionally registers `backup-daily` cron with eventScheduler. Skips if disabled or no destPath configured.

3. **`server/routes/backup.js`** — 4 REST endpoints:
   - `GET /api/backup/status` — state + destPath + nextRun
   - `POST /api/backup/run` — trigger immediate backup
   - `GET /api/backup/snapshots` — list snapshots
   - `POST /api/backup/restore` — restore with dryRun support

4. **`server/lib/validation.js`** — Added `backupConfigSchema` and `restoreRequestSchema` Zod schemas.

5. **`server/index.js`** — Routes mounted at `/api/backup`; `startBackupScheduler()` called after `startBrainScheduler()`.

6. **`client/src/services/api.js`** — Added `getBackupStatus`, `triggerBackup`, `getBackupSnapshots`, `restoreBackup`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed `createReadStream` import from wrong module**
- **Found during:** Task 1 verification
- **Issue:** `createReadStream` is not exported by `fs/promises`; initial code imported it from there
- **Fix:** Split import — `createReadStream` from `'fs'`, file stat/read functions from `'fs/promises'`
- **Files modified:** `server/services/backup.js`
- **Commit:** 8a01c2b (fixed inline before committing)

## Commits

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Backup service and scheduler | 8a01c2b | server/services/backup.js, server/services/backupScheduler.js |
| 2 | Routes, validation, server wiring, client API | 523ffd7 | server/routes/backup.js, server/lib/validation.js, server/index.js, client/src/services/api.js |

## Verification Results

- backup.js imports without errors: exports generateManifest, getNextRunTime, getState, listSnapshots, restoreSnapshot, runBackup, saveState
- backupScheduler.js imports without errors: exports startBackupScheduler, stopBackupScheduler
- All 42 server test files pass (1192 tests) — no regressions
- validation.js contains backupConfigSchema and restoreRequestSchema (2 schema exports)
- server/index.js mounts /api/backup and calls startBackupScheduler()
- client/src/services/api.js exports all 4 backup API functions

## Self-Check: PASSED
