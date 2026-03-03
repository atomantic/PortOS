# Unreleased Changes

## Added

- PostgreSQL + pgvector backend for the memory system with HNSW vector search, tsvector full-text search replacing BM25, and auto-fallback to file-based JSON when Docker is unavailable
- Federation sync endpoint (`GET/POST /api/memory/sync`) for incremental memory replication between PortOS instances via sync_sequence
- Data migration script (`server/scripts/migrateMemoryToPg.js`) to move existing JSON memories into PostgreSQL
- `pg_dump` integration in backup service for database snapshots alongside rsync
- `setup-db.js` script integrated into setup, start, dev, and update flows — gracefully skips if Docker is not available
- `docker-compose.yml` for PostgreSQL + pgvector container on port 5561
- `GET /api/memory/backend/status` endpoint to check active backend and DB health

## Changed

## Fixed

- Fix peer probes failing due to wrong port (5554 instead of 5555): update `handleAnnounce` to sync port from peer announcements, fix AddPeerForm fallback port

## Removed
