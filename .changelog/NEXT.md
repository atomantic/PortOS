# Unreleased Changes

## Added

## Changed

## Fixed

- `app-improve-` task IDs were getting `task-` prefix added by `taskParser.js`, causing `updateTask` lookups to fail — tasks were never marked in_progress or completed after agent runs
- Recovered `app-improve-` agents after server restart now correctly infer `taskType: 'internal'` instead of `'user'`
- Extracted `hasKnownPrefix()` and `isInternalTaskId()` helpers to eliminate prefix check drift across 8 locations

## Removed
