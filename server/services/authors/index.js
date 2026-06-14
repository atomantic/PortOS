/**
 * Author personas — storage backend dispatcher.
 *
 * Authors are `db-primary` (PostgreSQL `authors` table). This thin dispatcher
 * mirrors creativeDirector/local.js: select the backend lazily on first call
 * so route imports + tests work regardless of boot ordering.
 *
 *   - PostgreSQL (db.js) for normal installs.
 *   - File (file.js) only via MEMORY_BACKEND=file (escape hatch) or
 *     NODE_ENV=test — both UNSUPPORTED for production. Tests boot without a DB,
 *     so they exercise the file backend and need no Postgres.
 *
 * There is no legacy file→DB import: authors are a brand-new store, so the PG
 * path only needs the (idempotent) ensureSchema() that creates the table.
 */

import { checkHealth, ensureSchema } from '../../lib/db.js';

export {
  NAME_MAX,
  WRITING_STYLE_MAX,
  BIO_MAX,
  PHYSICAL_DESCRIPTION_MAX,
  HEADSHOT_STYLE_MAX,
  HEADSHOT_IMAGE_URL_MAX,
  AUTHOR_ID_RE,
} from './logic.js';

let backend = null;
let backendName = null;

async function selectBackend() {
  if (backend) return backend;
  if (process.env.MEMORY_BACKEND === 'file' || process.env.NODE_ENV === 'test') {
    backend = await import('./file.js');
    backendName = 'file';
    return backend;
  }
  // The boot DB gate fail-fasts a required-but-missing DB, but a route can call
  // in before that gate runs ensureSchema(), so bring the schema up here
  // (idempotent) — the authors table is created on first use either way.
  const health = await checkHealth();
  if (!health.connected) {
    throw new Error('Authors require PostgreSQL — run `npm run setup:db` (dev/test only: set PGMODE=file in .env for the unsupported file backend)');
  }
  await ensureSchema();
  backend = await import('./db.js');
  backendName = 'postgres';
  return backend;
}

/** Name of the active backend, or null before first call (for diagnostics/tests). */
export function getAuthorsBackendName() {
  return backendName;
}

/** Test seam — drop the memoized backend so a suite can re-select. */
export function _resetAuthorsBackend() {
  backend = null;
  backendName = null;
}

export async function listAuthors(options = {}) {
  return (await selectBackend()).listAuthors(options);
}

export async function getAuthor(id) {
  return (await selectBackend()).getAuthor(id);
}

export async function createAuthor(input) {
  return (await selectBackend()).createAuthor(input);
}

export async function updateAuthor(id, patch) {
  return (await selectBackend()).updateAuthor(id, patch);
}

export async function deleteAuthor(id) {
  return (await selectBackend()).deleteAuthor(id);
}
