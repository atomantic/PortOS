# Unreleased Changes

## Added

- PostgreSQL status in system health details endpoint (`/api/system/health/details`) with warnings when DB is disconnected or schema missing
- Backend status banners on CoS Memory and Brain Memory pages showing file-fallback warning with retry button
- `getMemoryBackendStatus` API client helper
- Brain→Memory bridge: mirrors brain captures (projects, ideas, admin, journal, digests, reviews, people) into CoS memory system with embeddings for semantic search by agents
- Source filter toggle (All/CoS/Brain) and source badges on Memory tab
- `appId` filtering on memory list and search APIs
- Migration script for existing brain data (`server/scripts/migrateBrainToMemories.js`)

## Changed

- `setup-db.js` now shows platform-specific Docker install/start instructions and prompts to continue when Docker is unavailable (TTY only; CI/piped scripts keep silent behavior)
- Setup scripts now show `npm start` as the primary production command alongside `npm run pm2:start`

## Fixed

## Removed
