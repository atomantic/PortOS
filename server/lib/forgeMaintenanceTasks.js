/** Queue-compatible screening identity for trusted forge maintenance. */
export const FORGE_MAINTENANCE_VERSION = 1;
export const LEGACY_FORGE_MAINTENANCE_REASON = 'This legacy forge maintenance task has not passed the current author and discussion gates. Run its schedule again to gather fresh screened evidence.';

export const isForgeMaintenanceTask = task => ['pr-watcher', 'issue-reconcile'].includes(task?.metadata?.analysisType);

// TASKS.md stores scalar metadata as text; freshly generated tasks use numbers.
// Accept only the exact current value, without coercing arbitrary input.
export const hasCurrentForgeMaintenanceEvidence = task =>
  task?.metadata?.forgeMaintenanceVersion === FORGE_MAINTENANCE_VERSION
  || task?.metadata?.forgeMaintenanceVersion === String(FORGE_MAINTENANCE_VERSION);
