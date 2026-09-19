/**
 * Where a project-specific jev head, its corpora and its cached embeddings live.
 *
 * One definition of each directory, in a leaf, because three separate modules
 * need to agree about them and they disagree silently:
 *
 *   `services/jevHeads.js`   writes and reads the heads
 *   `services/jev.js`        passes the heads directory to the sidecar
 *   `services/backup.js`     excludes two of the three by path
 *
 * Kept OUT of `services/jevHeads.js` so the sidecar lifecycle — the module
 * `jevRouter` defers specifically to keep the pinned model contract out of
 * static import closures — does not have to import the head store (and through
 * it zod) just to spell one directory.
 *
 * Everything under `jevDataDir()` is a derived record of this install's private
 * repository history: machine-local, never federated, never in a status or
 * capability payload. See the ADR
 * [privacy records machine-local](../../docs/decisions/2026-08-08-privacy-records-machine-local.md)
 * and the guard `services/sharing/jevNeverFederates.test.js`.
 *
 * Pure apart from reading the install root: no I/O, no process state.
 */

import { join } from 'path';
import { PATHS } from './paths.js';

/** The one directory every jev artifact lives under. */
export const jevDataDir = () => join(PATHS.data, 'jev');

/** Trained heads — adopted and candidate. Retained in backups: not regenerable. */
export const jevHeadsDir = () => join(jevDataDir(), 'heads');

/** Built training corpora. Rebuildable from the forge, so excluded from backups. */
export const jevCorporaDir = () => join(jevDataDir(), 'corpora');

/** Cached frozen-encoder outputs, per decision. Pure cache, excluded from backups. */
export const jevEmbeddingsDir = () => join(jevDataDir(), 'embeddings');

/**
 * The embedding cache for ONE decision.
 *
 * Per-decision rather than one shared pool, so a training run can prune the
 * keys it did not use without deleting another decision's cache. A flat pool
 * would make that prune unsafe and the cache therefore unbounded.
 */
export const jevDecisionEmbeddingsDir = (decisionId) => join(jevEmbeddingsDir(), decisionId);
