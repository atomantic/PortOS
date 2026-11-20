/**
 * Target-scope vocabulary for scheduled task types: does a type act on ONE managed app, the whole install, or either?
 *
 * (`INSTALL_WIDE_TASK_TYPES`, `MANAGED_APP_TARGET_TASK_TYPES`, `PROGRAMMATIC_SCHEDULED_TASK_TYPES`, `isProgrammaticScheduledTaskType`, `requiresManagedAppTarget`, `requiresInstallWideTarget`.)
 *
 * Pure data + two predicates in `lib/` because three tiers need one answer and only one is a service: `services/taskScheduleRegistry.js` re-exports it (the on-demand request gate and global generator keep one contract), `lib/quotaBurnTaskRef.js` resolves a burn step's reference against it, and `lib/quotaBurnValidation.js` rejects a wrong-scope reference BEFORE it reaches disk;
 * `server/lib` can't import upward into `server/services` (`server/test/guards/modules/libLayering.test.js`).
 */

/** Task types whose "Run Now" with NO app is the REAL run (they sweep every managed app in one dispatch). Surfaced per task on `getScheduleStatus()` so the schedule UI can offer an "All apps" entry instead of forcing the app picker (which would make the install-wide lane unreachable on any install with apps). */
export const INSTALL_WIDE_TASK_TYPES = new Set(['repo-sync', 'user-action-review', 'model-comparison-refresh', 'error-log-triage']);

// Task types that only make sense pointed at a managed app; beside the install-wide registry so the on-demand request gate and global generator share one target-scope contract rather than inferring from a task name or generator.
export const MANAGED_APP_TARGET_TASK_TYPES = new Set(['private-security-assessment', 'pr-reviewer', 'issue-watcher', 'pr-watcher', 'issue-reconcile', 'branch-reconcile']);

export function requiresManagedAppTarget(taskType) {
  return MANAGED_APP_TARGET_TASK_TYPES.has(taskType);
}

/**
 * Task types PortOS executes ITSELF through a programmatic handler (`services/scheduledHandlers/`): no agent, CoS task or spawn slot. Written out, not derived from `SCHEDULED_HANDLER_MODULES`: the re-exporting registry is reached by much of the server suite and must not pay an import for two strings (server/AGENTS.md "Import scoping");
 * `taskScheduleRegistry.programmatic.test.js` asserts it matches the handler registry. Here, not in the registry, because `requiresInstallWideTarget` needs it and `lib` can't import upward.
 */
export const PROGRAMMATIC_SCHEDULED_TASK_TYPES = Object.freeze([
  'development-watchdog',
  'music-video-autopilot',
  'universe-bible-describe',
  'universe-bible-images',
]);
const PROGRAMMATIC_SCHEDULED_TASK_TYPE_SET = new Set(PROGRAMMATIC_SCHEDULED_TASK_TYPES);

export const isProgrammaticScheduledTaskType = (taskType) =>
  PROGRAMMATIC_SCHEDULED_TASK_TYPE_SET.has(taskType);

// Task types that must NOT be pointed at a managed app: model research has no per-app variant (its catalog and API live in the PortOS install), and the programmatic bible handlers act on a universe (PortOS's own record, not a repo's), so an appId on their request is a caller bug.
const INSTALL_WIDE_ONLY_TASK_TYPES = new Set([
  'model-comparison-refresh',
  // Triage reads PortOS's own PM2 logs, which belong to no managed app.
  'error-log-triage',
  ...PROGRAMMATIC_SCHEDULED_TASK_TYPES,
]);

export function requiresInstallWideTarget(taskType) {
  return INSTALL_WIDE_ONLY_TASK_TYPES.has(taskType);
}
