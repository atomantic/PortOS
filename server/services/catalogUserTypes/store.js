/**
 * Catalog user-defined types — storage backend dispatcher (#1001).
 *
 * User-defined ingredient types used to live in data/settings.json under the
 * `catalogUserTypes` array. As of Phase 4 lead-in (#1001) they live one-row-
 * per-type in PostgreSQL (`catalog_user_types`) so type evolution versions and
 * syncs alongside the catalog data it governs, instead of riding the unrelated
 * settings blob. This module is a thin dispatcher — mirroring CD's local.js and
 * memoryBackend.js — so the two consumers (the `/api/catalog/types` CRUD routes
 * and the catalog federation sync) read/write the slice through ONE contract
 * regardless of backend.
 *
 * The contract is intentionally the same whole-slice shape the settings store
 * had: `readUserTypes()` returns the full array (live entries AND tombstones,
 * verbatim — `setUserCatalogTypes` filters tombstones out of the active
 * registry), and `writeUserTypes(list)` persists the whole array authoritatively
 * (the list IS the desired end state — upsert everything in it, drop any DB row
 * whose id left the list). With ≤64 types that's a couple of round-trips.
 *
 * Backend selection (same posture as the memory + CD backends):
 *   - PostgreSQL (db.js) for normal installs.
 *   - File (settings.json via the settings service) only under
 *     MEMORY_BACKEND=file (escape hatch) or NODE_ENV=test — both UNSUPPORTED for
 *     production. Tests boot without a DB, so they keep exercising the settings
 *     slice exactly as before, and the existing route/sync suites pass unchanged.
 *
 * The first PG-backed call runs a one-time, marker-gated import of any legacy
 * settings.catalogUserTypes slice into the table (migrateCatalogUserTypesToDB),
 * so the boot registry warm — the first caller — sees migrated types.
 */

import { checkHealth, ensureSchema } from '../../lib/db.js';

let backend = null;
let selecting = null;

function isFileBackend() {
  return process.env.MEMORY_BACKEND === 'file' || process.env.NODE_ENV === 'test';
}

// settings.json-backed implementation (escape hatch / tests). Byte-identical to
// the behavior the catalog routes + sync had inline before #1001, so nothing
// observable changes when no Postgres is present.
async function fileBackend() {
  const { getSettings, updateSettings } = await import('../settings.js');
  return {
    name: 'file',
    readUserTypes: async () => {
      const settings = await getSettings();
      return Array.isArray(settings.catalogUserTypes) ? settings.catalogUserTypes : [];
    },
    writeUserTypes: async (list) => {
      await updateSettings({ catalogUserTypes: Array.isArray(list) ? list : [] });
    },
  };
}

async function pgBackend() {
  // Self-sufficient like the CD backend: the boot DB gate fail-fasts a
  // required-but-missing DB, but a sync pull or the early registry warm can call
  // in BEFORE that gate's ensureSchema() runs — so bring the schema up here
  // (idempotent) and run the one-time settings→DB import before first read.
  const health = await checkHealth();
  if (!health.connected) {
    throw new Error('Catalog user types require PostgreSQL — run `npm run setup:db` (dev/test only: set PGMODE=file in .env for the unsupported file backend)');
  }
  await ensureSchema();
  const { migrateCatalogUserTypesToDB } = await import('../../scripts/migrateCatalogUserTypesToDB.js');
  await migrateCatalogUserTypesToDB();
  const db = await import('./db.js');
  return { name: 'postgres', readUserTypes: db.readUserTypes, writeUserTypes: db.writeUserTypes };
}

// Memoize the selection PROMISE (not just the result) so two concurrent first
// calls — e.g. the early boot warm racing a sync pull — don't both import the
// PG module and run the migration twice. (The migration is marker-gated +
// ON CONFLICT idempotent anyway, but memoizing keeps it to one round-trip.)
async function selectBackend() {
  if (backend) return backend;
  if (!selecting) {
    selecting = (isFileBackend() ? fileBackend() : pgBackend())
      .then((b) => { backend = b; return b; })
      .finally(() => { selecting = null; });
  }
  return selecting;
}

/** Active backend name, or null before first call (diagnostics/tests). */
export function getCatalogUserTypesBackendName() {
  return backend?.name ?? null;
}

/** Reset cached backend selection — test seam only. */
export function _resetCatalogUserTypesBackend() {
  backend = null;
  selecting = null;
}

/** Full user-type slice (live + tombstones), verbatim. */
export async function readUserTypes() {
  return (await selectBackend()).readUserTypes();
}

/** Persist the whole user-type slice as the authoritative end state. */
export async function writeUserTypes(list) {
  return (await selectBackend()).writeUserTypes(list);
}
