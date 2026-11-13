/**
 * The pgvector image the CI DB service and the live restore test run. A digest
 * change is an explicit dependency update: scripts/dbImageDigestPin.test.js
 * holds this, docker-compose.yml and .github/workflows/ci.yml to one digest.
 */
/**
 * The PostgreSQL major every existing Docker volume was initialized with. A new
 * major cannot open an older data directory, so changing it is not a digest
 * refresh: it needs a dump/restore migration path in the same change
 * (docs/STORAGE.md, "PostgreSQL version updates").
 */
export const PINNED_DB_MAJOR = 17;
export const PINNED_DB_IMAGE = 'pgvector/pgvector:pg17@sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd';
