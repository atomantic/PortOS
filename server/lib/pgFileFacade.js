/**
 * PG/file store-backend facade backbone.
 *
 * PortOS has six near-identical storage dispatchers (pipeline series/issues,
 * story builder, universe builder, catalog user-types, writers room) that each
 * pick between a PostgreSQL backend (normal installs) and a file/escape-hatch
 * backend (MEMORY_BACKEND=file or NODE_ENV=test — both UNSUPPORTED for
 * production). They all reimplemented the same three pieces: the env predicate
 * that chooses the backend, the promise-memoized lazy selection, and the PG
 * bring-up sequence (health check → ensureSchema → one-time migration → import
 * the leaf-I/O `db.js`). This module owns those pieces so no store copies them.
 *
 * What stays in each store: its own `makeFile` / `makePg` backend factories
 * (the file layouts differ genuinely — collectionStore vs settings.json vs a
 * bespoke on-disk JSON format) and its public facade surface.
 *
 * A second family of stores (Creative Director, Music Video, Sprites) dispatches
 * to whole backend MODULES rather than built objects, and hand-rolled the same
 * selector a third time (#2899). `createRecordStoreBackendSelector` below wraps
 * this backbone for that shape.
 */

import { checkHealth, ensureSchema } from './db.js';

/**
 * True when the file/escape-hatch backend should be used instead of PostgreSQL.
 * Dev/test only — see the Storage backend policy in CLAUDE.md.
 */
export function isFileBackend() {
  return process.env.MEMORY_BACKEND === 'file' || process.env.NODE_ENV === 'test';
}

/**
 * Bring the PostgreSQL backend up and build it. Fail-fast on a missing DB (the
 * boot gate may not have run ensureSchema yet — an early warm or a sync pull can
 * call in first), so this is self-sufficient: it health-checks, brings the
 * schema up (idempotent), runs the one-time marker-gated file→DB import, imports
 * the leaf-I/O db module, and hands it to `makePg`.
 *
 * @param {object} opts
 * @param {string} opts.requirement  Error message thrown when the DB is unreachable.
 * @param {() => Promise<void>} [opts.migrate]  One-time file→DB import (optional).
 * @param {() => Promise<object>} opts.loadDb   Dynamic `import('./db.js')`.
 * @param {(db: object) => object} opts.makePg  Build the PG backend from the db module.
 */
export async function resolvePgBackend({ requirement, migrate, loadDb, makePg }) {
  const health = await checkHealth();
  if (!health.connected) throw new Error(requirement);
  await ensureSchema();
  if (migrate) await migrate();
  const db = await loadDb();
  return makePg(db);
}

/**
 * Shared PG/file backend selector. Picks the file backend under the dev/test
 * escape hatch and the PG backend otherwise, memoizing the SELECTION PROMISE
 * (not just the result) so two concurrent first calls — e.g. the boot warm
 * racing a sync pull — don't both import the PG module and run the migration
 * twice. `makeFile` may be sync or async; `makePg` is async (usually wired to
 * `resolvePgBackend`).
 *
 * @param {object} opts
 * @param {() => object|Promise<object>} opts.makeFile  Build the file backend.
 * @param {() => Promise<object>} opts.makePg           Build the PG backend.
 * @param {() => boolean} [opts.isFile]  Escape-hatch predicate (default `isFileBackend`).
 *   Overridden only by stores that use a stronger test-mode signal (see
 *   `createRecordStoreBackendSelector`'s `isTestMode`).
 * @returns {{ getBackend: () => Promise<object>, getBackendName: () => (string|null), reset: () => void }}
 */
export function createPgFileFacade({ makeFile, makePg, isFile = isFileBackend }) {
  let backend = null;
  let selecting = null;
  const getBackend = () => {
    if (backend) return Promise.resolve(backend);
    if (!selecting) {
      selecting = Promise.resolve(isFile() ? makeFile() : makePg())
        .then((b) => { backend = b; return b; })
        .finally(() => { selecting = null; });
    }
    return selecting;
  };
  return {
    getBackend,
    getBackendName: () => backend?.name ?? null,
    reset: () => { backend = null; selecting = null; },
  };
}

/**
 * Memoized backend selector for stores whose backends are whole MODULES
 * (`import('./projectsFile.js')` vs `import('./projectsDB.js')`) rather than
 * objects built from `db.js` — Creative Director, Music Video, Sprites (#2899).
 * Each had hand-rolled the identical dispatcher, and they had already drifted
 * (differing error text, differing test-mode predicate).
 *
 * Same posture as `createPgFileFacade` (do NOT weaken it): the dev/test escape
 * hatch selects the file backend with NO database contact at all; otherwise
 * `resolvePgBackend` health-checks, runs the idempotent `ensureSchema()` (a store
 * may be called before the boot DB gate, e.g. CD's boot recovery scan), runs the
 * optional one-time migration, then loads the PG module.
 *
 * Test-mode detection stays per-store (`isTestMode`) because the stores
 * genuinely differ today: Sprites keys on `isTestRunner()` (`NODE_ENV==='test'`
 * OR `VITEST` — the stronger signal), CD/Music Video on `NODE_ENV==='test'` only
 * via the shared `isFileBackend()`. Unifying on `isTestRunner()` would be a
 * strengthening, but it changes what their existing backend-selection suites
 * observe (vitest always sets `VITEST`), so semantics are preserved exactly here
 * and the unification is left as a separate decision.
 *
 * @param {object} opts
 * @param {string} [opts.label]  Store name used in the default unreachable-DB error.
 * @param {() => Promise<object>} opts.loadFileBackend  Loader for the file backend module.
 * @param {() => Promise<object>} opts.loadDbBackend    Loader for the PostgreSQL backend module.
 * @param {string} [opts.requireDbMessage]  Override for the unreachable-DB error message.
 * @param {() => boolean} [opts.isTestMode]  Test-mode predicate; when omitted the shared
 *   `isFileBackend()` (MEMORY_BACKEND=file OR NODE_ENV=test) is used as-is.
 * @param {() => Promise<void>} [opts.onDbReady]  One-time migration run after `ensureSchema()`
 *   and before the DB backend import (CD's legacy JSON → table import).
 * @returns {{ selectBackend: () => Promise<object>, getBackendName: () => ('file'|'postgres'|null) }}
 */
export function createRecordStoreBackendSelector({
  label,
  loadFileBackend,
  loadDbBackend,
  requireDbMessage,
  isTestMode,
  onDbReady,
} = {}) {
  if (typeof loadFileBackend !== 'function' || typeof loadDbBackend !== 'function') {
    throw new Error('createRecordStoreBackendSelector requires loadFileBackend + loadDbBackend loader functions');
  }

  const requirement = requireDbMessage
    || `${label || 'This store'} requires PostgreSQL — run \`npm run setup:db\` (dev/test only: set MEMORY_BACKEND=file in .env)`;

  let backendName = null;
  const facade = createPgFileFacade({
    isFile: isTestMode
      ? () => process.env.MEMORY_BACKEND === 'file' || isTestMode()
      : isFileBackend,
    makeFile: async () => {
      const mod = await loadFileBackend();
      backendName = 'file';
      return mod;
    },
    makePg: async () => {
      const mod = await resolvePgBackend({
        requirement,
        migrate: onDbReady,
        loadDb: loadDbBackend,
        makePg: (m) => m,
      });
      backendName = 'postgres';
      return mod;
    },
  });

  return {
    selectBackend: facade.getBackend,
    /** Name of the active backend, or null before first selection (diagnostics/tests). */
    getBackendName: () => backendName,
    /**
     * Test seam — drop the memoized selection so a suite can re-select. Mirrors
     * the `_reset<X>Backend()` exports the artists/tracks/albums/authors stores
     * carry, so folding those in later needs no new surface here.
     */
    reset: () => { facade.reset(); backendName = null; },
  };
}
