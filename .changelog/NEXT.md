# Unreleased Changes

## Added

- PostgreSQL status in system health details endpoint (`/api/system/health/details`) with warnings when DB is disconnected or schema missing
- Backend status banners on CoS Memory and Brain Memory pages showing file-fallback warning with retry button
- `getMemoryBackendStatus` API client helper

## Changed

- `setup-db.js` now shows platform-specific Docker install/start instructions and prompts to continue when Docker is unavailable (TTY only; CI/piped scripts keep silent behavior)

## Fixed

## Removed
