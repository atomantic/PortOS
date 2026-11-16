/**
 * PG/file store-backend facade backbone: shared backend selection and PostgreSQL bring-up for the storage dispatchers.
 *
 * PG/file store-backend facade backbone. Six near-identical storage dispatchers (pipeline series/issues, story builder, universe builder, catalog user-types, writers room) each pick between PostgreSQL (normal installs)
 * and a file/escape-hatch backend (MEMORY_BACKEND=file or isTestRunner(); UNSUPPORTED for production), and each reimplemented the env predicate, the promise-memoized lazy selection and the PG bring-up (health check →
 * ensureSchema → one-time migration → import the leaf-I/O `db.js`). This module owns those so no store copies them; each store keeps its `makeFile` / `makePg` factories (file layouts genuinely differ) and facade surface.
 * Stores dispatching to whole backend MODULES (Creative Director, Music Video, Sprites) hand-rolled it a third time (#2899); `createRecordStoreBackendSelector` wraps this backbone for that shape.
 */

import { checkHealth, ensureSchema } from './db.js';
import { isTestRunner } from './runtimeEnv.js';

/** Setup advice appended to every store's "requires PostgreSQL" error. PortOS has no dotenv loader (a `.env` `MEMORY_BACKEND` line reaches no process) and the launcher (`ecosystem.config.cjs`) sets it only from `PGMODE=file`, so that is the setting to name. */
export const POSTGRES_SETUP_HINT = 'run `npm run setup:db` (dev/test only: set PGMODE=file in .env; the launcher maps it to MEMORY_BACKEND=file for the unsupported file backend)';

/** True when the file/escape-hatch backend should be used instead of PostgreSQL (dev/test only; see AGENTS.md Storage backend). Call this rather than re-spelling it, so a suite forces a backend by stubbing this predicate instead of `isTestRunner()` (db.js's guards key on that). */
export function isFileBackend() {
  return process.env.MEMORY_BACKEND === 'file' || isTestRunner();
}

/**
 * Bring the PostgreSQL backend up and build it. Fail-fast on a missing DB; self-sufficient (an early warm or sync pull can call before the boot gate ran ensureSchema): health-check, idempotent schema bring-up,
 * the marker-gated one-time file→DB import, import the leaf-I/O db module, hand it to `makePg`.
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
 * Shared PG/file backend selector: the file backend under the dev/test escape hatch, else PG, memoizing the SELECTION PROMISE (not just the result) so concurrent first calls (boot warm vs sync pull) don't import the PG
 * module and run the migration twice. `makeFile` may be sync or async; `makePg` is async (usually `resolvePgBackend`).
 *
 * @param {object} opts
 * @param {() => object|Promise<object>} opts.makeFile  Build the file backend.
 * @param {() => Promise<object>} opts.makePg           Build the PG backend.
 * @param {() => boolean} [opts.isFile]  Escape-hatch predicate (default `isFileBackend`); overridden only by stores using a stronger test-mode signal (`createRecordStoreBackendSelector`'s `isTestMode`).
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
 * Memoized backend selector for stores whose backends are whole MODULES (`import('./projectsFile.js')` vs `import('./projectsDB.js')`): Creative Director, Music Video, Sprites (#2899), Artists, Tracks, Albums, Authors (#2909),
 * which had hand-rolled drifting dispatchers. Same posture as `createPgFileFacade` (do NOT weaken): the escape hatch selects the file backend with NO database contact; otherwise `resolvePgBackend` health-checks, runs the idempotent
 * `ensureSchema()` (a store may be called before the boot DB gate), runs the optional migration, then loads the PG module. The default escape hatch is `isFileBackend()` (`MEMORY_BACKEND=file` or `isTestRunner()`); a store may pass
 * `isTestMode` to replace the test signal (the file hatch is still OR-ed in). Vitest always sets `VITEST`, so a suite wanting Postgres must clear it (changing `NODE_ENV` is not enough).
 *
 * @param {object} opts
 * @param {string} [opts.label]  Store name used in the default unreachable-DB error.
 * @param {() => Promise<object>} opts.loadFileBackend  Loader for the file backend module.
 * @param {() => Promise<object>} opts.loadDbBackend    Loader for the PostgreSQL backend module.
 * @param {string} [opts.requireDbMessage]  Override for the unreachable-DB error message.
 * @param {() => boolean} [opts.isTestMode]  Test-mode predicate; when omitted the shared
 *   `isFileBackend()` (`MEMORY_BACKEND=file` OR `isTestRunner()`) is used as-is.
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
    || `${label || 'This store'} requires PostgreSQL — ${POSTGRES_SETUP_HINT}`;

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
    /** Name of the active backend, or null before first selection. */
    getBackendName: () => backendName,
    /** Test seam: drop the memoized selection so a suite can re-select (backs the `_reset<X>Backend()` exports). */
    reset: () => { facade.reset(); backendName = null; },
  };
}
