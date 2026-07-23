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

import { createRecordStoreBackendSelector } from '../../lib/pgFileFacade.js';
import { emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers } from '../sharing/recordEvents.js';

export {
  NAME_MAX,
  WRITING_STYLE_MAX,
  BIO_MAX,
  PHYSICAL_DESCRIPTION_MAX,
  HEADSHOT_STYLE_MAX,
  HEADSHOT_IMAGE_URL_MAX,
  AUTHOR_ID_RE,
  headshotImageFilename,
} from './logic.js';

// Shared dispatcher (#2909). The boot DB gate fail-fasts a required-but-missing
// DB, but a route can call in before that gate runs ensureSchema() — the selector
// runs it (idempotently) on the PG path, so the authors table is created on first
// use either way.
const { selectBackend, getBackendName, reset } = createRecordStoreBackendSelector({
  label: 'Authors',
  loadFileBackend: () => import('./file.js'),
  loadDbBackend: () => import('./db.js'),
  requireDbMessage: 'Authors require PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file in .env for the unsupported file backend)',
});

/** Name of the active backend, or null before first call (for diagnostics/tests). */
export function getAuthorsBackendName() {
  return getBackendName();
}

/** Test seam — drop the memoized backend so a suite can re-select. */
export function _resetAuthorsBackend() {
  reset();
}

export async function listAuthors(options = {}) {
  return (await selectBackend()).listAuthors(options);
}

export async function listAuthorIds(options = {}) {
  return (await selectBackend()).listAuthorIds(options);
}

export async function getAuthor(id, options = {}) {
  return (await selectBackend()).getAuthor(id, options);
}

// Announce a newly-created author to the per-record peer-sync pipeline: emit the
// 'updated' event so any existing subscription pushes it, AND auto-subscribe
// every authors-enabled peer so brand-new authors (and their later tombstones)
// propagate. Routed through the recordEvents subscription adapter (a no-op until
// peerSync registers it at boot) so the authors store doesn't import peerSync —
// peerSync statically imports mergeAuthorsFromSync from here, so importing it
// back would close a load-order cycle. Call ONLY when a brand-new record was
// persisted, never on an idempotent hit, or every render would re-announce.
function announceNewAuthor(id) {
  emitRecordUpdated('author', id);
  autoSubscribeRecordToAllPeers('author', id).catch(() => {});
}

export async function createAuthor(input) {
  const author = await (await selectBackend()).createAuthor(input);
  announceNewAuthor(author.id);
  return author;
}

export async function updateAuthor(id, patch) {
  const next = await (await selectBackend()).updateAuthor(id, patch);
  // A standalone author reaches peers only via its per-record subscription —
  // without this emit an edit never propagates after the initial subscribe.
  emitRecordUpdated('author', next.id);
  return next;
}

export async function deleteAuthor(id) {
  const result = await (await selectBackend()).deleteAuthor(id);
  // Soft-delete tombstone — push the deletion to subscribed peers immediately
  // (deleteUniverse/deleteSeries emit `deleted`, not `updated`; peerSync's
  // delete listener reads the record with includeDeleted and pushes the tombstone).
  emitRecordDeleted('author', result.id);
  return result;
}

/** Merge an incoming batch of author records from a peer (LWW, tombstone-aware). */
export async function mergeAuthorsFromSync(remoteAuthors, options = {}) {
  return (await selectBackend()).mergeAuthorsFromSync(remoteAuthors, options);
}

/** Hard-remove author tombstones older than the cutoff (called by tombstone GC). */
export async function pruneTombstonedAuthors(olderThanMs) {
  return (await selectBackend()).pruneTombstonedAuthors(olderThanMs);
}
