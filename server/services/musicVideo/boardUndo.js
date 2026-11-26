/**
 * Ephemeral, machine-local undo stack for Music Video board edits (merge, split,
 * delete, reorder, retime, cut-on-lyrics, vary-wipes, add).
 *
 * Kept in memory rather than on the stored project record so board snapshots
 * never bloat the Postgres JSONB row or trigger peer sync. Snapshots capture
 * only the board fields a structural edit can change (`scenes`, `songRevision`,
 * and `productionReview` shot locks/approvals), leaving large review history
 * untouched.
 */

const MAX_ENTRIES_PER_PROJECT = 20;

const stacks = new Map();

function snapshotForUndo(project, label) {
  const productionReview = project?.productionReview || null;
  return {
    label,
    scenes: structuredClone(project?.scenes || []),
    hasSongRevision: Object.hasOwn(project || {}, 'songRevision'),
    songRevision: project?.songRevision !== undefined ? structuredClone(project.songRevision) : undefined,
    hasApprovals: Boolean(productionReview && Object.hasOwn(productionReview, 'approvals')),
    approvals: productionReview?.approvals !== undefined ? structuredClone(productionReview.approvals) : undefined,
    hasShotLocks: Boolean(productionReview && Object.hasOwn(productionReview, 'shotLocks')),
    shotLocks: productionReview?.shotLocks !== undefined ? structuredClone(productionReview.shotLocks) : undefined,
  };
}

/** Record a pre-edit board snapshot for `projectId`, capped at `MAX_ENTRIES_PER_PROJECT`. */
export function recordBoardUndo(projectId, { label, before }) {
  if (!projectId || !before) return;
  const entry = snapshotForUndo(before, label);
  const stack = stacks.get(projectId) || [];
  stack.push(entry);
  if (stack.length > MAX_ENTRIES_PER_PROJECT) stack.splice(0, stack.length - MAX_ENTRIES_PER_PROJECT);
  stacks.set(projectId, stack);
}

/** Summary surfaced on the presented project (`{ count, label }`) or `null` when empty. */
export function peekBoardUndo(projectId) {
  const stack = projectId ? stacks.get(projectId) : null;
  if (!stack?.length) return null;
  return { count: stack.length, label: stack[stack.length - 1].label };
}

/** Pop the most recent undo entry for `projectId`, or `null` when empty. */
export function popBoardUndo(projectId) {
  const stack = projectId ? stacks.get(projectId) : null;
  if (!stack?.length) return null;
  const entry = stack.pop();
  if (!stack.length) stacks.delete(projectId);
  return entry;
}

/** Put a popped entry back on top (used when restoring fails so the snapshot is not lost). */
export function restoreBoardUndoEntry(projectId, entry) {
  if (!projectId || !entry) return;
  const stack = stacks.get(projectId) || [];
  stack.push(entry);
  if (stack.length > MAX_ENTRIES_PER_PROJECT) stack.splice(0, stack.length - MAX_ENTRIES_PER_PROJECT);
  stacks.set(projectId, stack);
}

/** Apply a saved undo entry onto the current stored project record without touching review history. */
export function applyBoardUndoEntry(current, entry) {
  const next = { ...current, scenes: structuredClone(entry.scenes) };
  if (entry.hasSongRevision) next.songRevision = structuredClone(entry.songRevision);
  else delete next.songRevision;
  if (entry.hasApprovals || entry.hasShotLocks || current.productionReview) {
    const productionReview = { ...(current.productionReview || {}) };
    if (entry.hasApprovals) productionReview.approvals = structuredClone(entry.approvals);
    else delete productionReview.approvals;
    if (entry.hasShotLocks) productionReview.shotLocks = structuredClone(entry.shotLocks);
    else delete productionReview.shotLocks;
    next.productionReview = productionReview;
  }
  return next;
}

/** Drop a project's undo stack (called on delete and between tests). */
export function clearBoardUndo(projectId = null) {
  if (projectId) stacks.delete(projectId);
  else stacks.clear();
}
