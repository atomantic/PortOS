// Pure, deterministic helpers for CyberCity's CoS task-queue silhouette (roadmap 2.2):
// a warehouse east of downtown whose stacked crates track the depth of the Chief-of-
// Staff task queue. Crates accumulate as tasks queue up and clear as they complete; an
// in-progress task lights the warehouse, a blocked task tints it amber. No three.js /
// React imports so the topology is unit-testable (mirrors cityBackupVault.js).

import { tallyByKey } from './cityDistrictLayout';

export const TASK_QUEUE = {
  position: [34, 0, -10], // east of the building grid, mirroring the backup vault to the west
  maxCrates: 8, // visible-crate cap; beyond this the warehouse reads as "overflow"
  crateSize: 1.5,
  crateGap: 0.18,
  warehouseWidth: 6,
  warehouseHeight: 4,
};

// Warehouse lighting color per queue "mood". Reuses the PortOS Tailwind tokens so the
// silhouette speaks the same visual language as the rest of the UI.
const STATE_COLORS = {
  idle: '#475569', // slate — empty queue, nothing waiting
  queued: '#3b82f6', // port-accent — pending work piling up
  active: '#22c55e', // port-success — an agent is working a task
  blocked: '#f59e0b', // port-warning — a task needs attention
};

// Tally CoS tasks by status. Tolerates a missing/non-array input (returns all-zero) and
// buckets unrecognized statuses under `other` so the counts always sum to the input length.
const KNOWN_TASK_STATUSES = ['pending', 'in_progress', 'blocked', 'completed'];
const taskStatusKey = (t) => (KNOWN_TASK_STATUSES.includes(t?.status) ? t.status : 'other');
export function countByStatus(tasks) {
  return tallyByKey(tasks, taskStatusKey, [...KNOWN_TASK_STATUSES, 'other']);
}

// Overall queue mood for the warehouse lighting, in priority order: a blocked task is the
// loudest signal, then active work, then a non-empty backlog, then idle.
export function queueState(counts) {
  if (counts?.blocked > 0) return 'blocked';
  if (counts?.in_progress > 0) return 'active';
  if (counts?.pending > 0) return 'queued';
  return 'idle';
}

export function queueColor(state) {
  return STATE_COLORS[state] || STATE_COLORS.idle;
}

// Full derived view-model for the component: counts + warehouse state/color + a crate
// layout. The crate stack height tracks pending (queued) work — the depth of the queue —
// capped at maxCrates with an `overflow` flag when more is waiting than crates shown.
export function computeTaskQueue(tasks, opts = {}) {
  const maxCrates = opts.maxCrates ?? TASK_QUEUE.maxCrates;
  const counts = countByStatus(tasks);
  const state = queueState(counts);
  const crateCount = Math.min(counts.pending, maxCrates);
  const crates = [];
  for (let i = 0; i < crateCount; i++) {
    crates.push({
      index: i,
      y: TASK_QUEUE.crateSize / 2 + i * (TASK_QUEUE.crateSize + TASK_QUEUE.crateGap),
    });
  }
  return {
    position: TASK_QUEUE.position,
    pending: counts.pending,
    inProgress: counts.in_progress,
    blocked: counts.blocked,
    total: counts.pending + counts.in_progress + counts.blocked,
    state,
    color: queueColor(state),
    crateCount,
    crates,
    overflow: counts.pending > maxCrates,
    active: counts.in_progress > 0,
    hasBlocked: counts.blocked > 0,
  };
}
