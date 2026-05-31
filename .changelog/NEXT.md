# Unreleased Changes

## Added

## Changed

- Bumped the bundled slashdo submodule (`lib/slashdo`) to latest `main` (`11cb89c`).

## Fixed

- **[chrome-canary-followups] Custom Chrome setup writes browser config through the shared atomic writer.** The Canary setup script now uses `server/lib/fileUtils.js#atomicWrite` for browser-config updates, so it gets the same temp-file/rename behavior and Windows fallback as the rest of PortOS config persistence.

## Removed
