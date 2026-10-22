/**
 * Retired scheduled task names → their current names. Dependency-free so the
 * browser-safe task-type classifier (taskTypeBucket.js) can use it without
 * pulling in scheduledTaskTypes.js's validation imports.
 *
 * Each rename ships a migration that moves persisted schedule state (408, 417);
 * this map covers what a migration cannot reach — queued/archived tasks carrying
 * the old name and the prompt-integrity history that follows the renamed key.
 */
export const TASK_TYPE_RENAMES = Object.freeze({ 'react-lifecycle': 'ui-lifecycle', 'release-check': 'do-release' });
export const currentTaskTypeName = (taskType) => TASK_TYPE_RENAMES[taskType] || taskType;
