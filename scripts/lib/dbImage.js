/**
 * The pgvector image the CI DB service and the live restore test run. A digest
 * change is an explicit dependency update: scripts/dbImageDigestPin.test.js
 * holds this, docker-compose.yml and .github/workflows/ci.yml to one digest.
 */
export const PINNED_DB_IMAGE = 'pgvector/pgvector:pg17@sha256:7d0a41464797aeb9862dfdc0bbf1526b82cfd324cdd8036df19e3545f4a9ccb8';
