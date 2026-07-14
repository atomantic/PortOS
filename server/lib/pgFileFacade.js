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
 * @returns {{ getBackend: () => Promise<object>, getBackendName: () => (string|null), reset: () => void }}
 */
export function createPgFileFacade({ makeFile, makePg }) {
  let backend = null;
  let selecting = null;
  const getBackend = () => {
    if (backend) return Promise.resolve(backend);
    if (!selecting) {
      selecting = Promise.resolve(isFileBackend() ? makeFile() : makePg())
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
