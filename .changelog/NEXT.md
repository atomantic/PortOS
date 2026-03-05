# Unreleased Changes

## Added

- Sync status indicators on Instances page showing brain and memory sync progress per peer
- Self card displays local brain/memory sequence numbers
- Each peer card shows cursor position vs remote max with synced/behind indicators
- New `/api/instances/sync-status` endpoint exposes local sync sequences for peer probing
- Probe now fetches remote peer's sync sequences to enable bidirectional sync awareness

## Changed

## Fixed

- setup-data script now copies missing files (not just directories) from data.sample to data, fixing broken updates where new config files like stage-config.json were never propagated to existing installs
- Git remote branches list no longer shows phantom "origin" branch from bare symbolic refs
- portos-server now inherits PATH from parent process so git commands don't fail with ENOENT when spawned via PM2

## Removed
