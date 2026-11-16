/**
 * Where a project-specific jev head, its corpora and cached embeddings live under `data/jev/`.
 *
 * Machine-local and never federated (ADR privacy-records-machine-local); one definition shared by the head store,
 * `services/jev.js` and `services/backup.js`.
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

/** Per-decision, so a training run can prune its unused keys without deleting another decision's cache. */
export const jevDecisionEmbeddingsDir = (decisionId) => join(jevEmbeddingsDir(), decisionId);
