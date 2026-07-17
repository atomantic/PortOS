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

import { createPgFileFacade, resolvePgBackend } from '../../lib/pgFileFacade.js';

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

// Self-sufficient like the CD backend: the boot DB gate fail-fasts a
// required-but-missing DB, but a sync pull or the early registry warm can call
// in BEFORE that gate's ensureSchema() runs — so resolvePgBackend brings the
// schema up (idempotent) and runs the one-time settings→DB import before first
// read. Backend selection is promise-memoized so two concurrent first calls
// don't both import the PG module / run the migration twice.
const facade = createPgFileFacade({
  makeFile: () => fileBackend(),
  makePg: () => resolvePgBackend({
    requirement: 'Catalog user types require PostgreSQL — run `npm run setup:db` (dev/test only: set PGMODE=file in .env for the unsupported file backend)',
    migrate: async () => {
      const { migrateCatalogUserTypesToDB } = await import('../../scripts/migrateCatalogUserTypesToDB.js');
      await migrateCatalogUserTypesToDB();
    },
    loadDb: () => import('./db.js'),
    makePg: (db) => ({ name: 'postgres', readUserTypes: db.readUserTypes, writeUserTypes: db.writeUserTypes }),
  }),
});

/** Active backend name, or null before first call (diagnostics/tests). */
export function getCatalogUserTypesBackendName() {
  return facade.getBackendName();
}

/** Reset cached backend selection — test seam only. */
export function _resetCatalogUserTypesBackend() {
  facade.reset();
}

/** Full user-type slice (live + tombstones), verbatim. */
export async function readUserTypes() {
  return (await facade.getBackend()).readUserTypes();
}

/** Persist the whole user-type slice as the authoritative end state. */
export async function writeUserTypes(list) {
  return (await facade.getBackend()).writeUserTypes(list);
}
