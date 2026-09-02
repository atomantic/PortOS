import { sanitizeSoftDeleteFields } from './syncWire.js';

/**
 * Field-shape-agnostic project normalization shared by every project domain.
 */
export function sanitizeProjectForSync(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt;
  const { deleted, deletedAt } = sanitizeSoftDeleteFields(raw);
  return { ...raw, createdAt, updatedAt, deleted, deletedAt };
}

/**
 * Apply a sync batch without performing persistence or conflict-journal I/O.
 * The returned change records tell a backend exactly which side effects to run.
 */
export function applySyncMerge({ byId, remoteProjects, source, kind, mergeProjectRecord: mergeRecord }) {
  const mergedById = new Map(byId);
  const changes = [];
  if (!Array.isArray(remoteProjects)) return { byId: mergedById, changes };

  for (const remote of remoteProjects) {
    const local = mergedById.get(remote?.id) || null;
    const { next, inserted, remoteWins, changed } = mergeRecord(local, remote);
    if (!next || (!inserted && (!remoteWins || !changed))) continue;
    mergedById.set(next.id, next);
    changes.push({ kind, id: next.id, local, remote: next, source, inserted });
  }

  return { byId: mergedById, changes };
}

/** Select expired tombstones without mutating the supplied project array. */
export function selectExpiredTombstones(all, olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { survivors: [...all], prunedIds: [] };
  const survivors = [];
  const prunedIds = [];
  for (const project of all) {
    const deletedAtMs = project?.deleted ? Date.parse(project.deletedAt || '') : NaN;
    if (project?.deleted && Number.isFinite(deletedAtMs) && deletedAtMs < olderThanMs) {
      prunedIds.push(project.id);
    } else {
      survivors.push(project);
    }
  }
  return { survivors, prunedIds };
}

/** Bind the record kind once for a project store factory. */
export function makeSyncKind(kind) {
  return {
    applySyncMerge: (options) => applySyncMerge({ ...options, kind }),
    selectExpiredTombstones,
  };
}
