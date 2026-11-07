/**
 * The pgvector image the CI DB service and the live restore test run. A digest
 * change is an explicit dependency update: scripts/dbImageDigestPin.test.js
 * holds this, docker-compose.yml and .github/workflows/ci.yml to one digest.
 */
export const PINNED_DB_IMAGE = 'pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d';
