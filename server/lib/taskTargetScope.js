/**
 * Target-scope vocabulary for scheduled task types: does a type act on ONE
 * managed app, on the whole install, or on either?
 *
 * Lives in `lib/` (pure data + two predicates, no imports) because three tiers
 * need the same answer and only one of them is a service:
 *   - `services/taskScheduleRegistry.js` re-exports these, so the on-demand
 *     request gate and the global generator keep one target-scope contract;
 *   - `lib/quotaBurnTaskRef.js` resolves a burn step's reference against it;
 *   - `lib/quotaBurnValidation.js` rejects a reference whose scope is wrong
 *     BEFORE it reaches disk.
 *
 * The last two are `server/lib` modules, which may not import upward into
 * `server/services` (see `lib/layering.test.js`), so the vocabulary belongs
 * here and the registry keeps re-exporting it for its existing callers.
 */

/**
 * Task types whose "Run Now" with NO app is the REAL run — they sweep every
 * managed app in one dispatch rather than acting on one. Surfaced per task on
 * `getScheduleStatus()` so the schedule UI can offer an "All apps" entry
 * instead of forcing every run through the app picker (which would make the
 * install-wide lane unreachable on any install that has apps).
 */
export const INSTALL_WIDE_TASK_TYPES = new Set(['repo-sync', 'user-action-review', 'model-comparison-refresh']);

// Task types that only make sense when pointed at a managed app. Keeping this
// alongside the install-wide registry gives both the on-demand request gate
// and the global generator one target-scope contract; neither has to infer
// scope from a task name or from which generator happened to receive a call.
export const MANAGED_APP_TARGET_TASK_TYPES = new Set(['private-security-assessment', 'pr-reviewer', 'issue-watcher', 'pr-watcher', 'issue-reconcile']);

export function requiresManagedAppTarget(taskType) {
  return MANAGED_APP_TARGET_TASK_TYPES.has(taskType);
}

/**
 * Task types PortOS executes ITSELF through a programmatic handler
 * (`services/scheduledHandlers/`) — no agent, no CoS task, no spawn slot.
 *
 * Written out rather than derived from `SCHEDULED_HANDLER_MODULES` on purpose:
 * the registry that re-exports this is reached by a large share of the server
 * suite, so it must not pay an import to learn two strings (server/AGENTS.md,
 * "Import scoping"). `taskScheduleRegistry.programmatic.test.js` asserts this
 * list matches the handler registry exactly, so the two cannot drift. It lives
 * here rather than in the registry because `requiresInstallWideTarget` below
 * needs it, and `lib` may not import upward into `services`.
 */
export const PROGRAMMATIC_SCHEDULED_TASK_TYPES = Object.freeze([
  'universe-bible-describe',
  'universe-bible-images',
]);
const PROGRAMMATIC_SCHEDULED_TASK_TYPE_SET = new Set(PROGRAMMATIC_SCHEDULED_TASK_TYPES);

export const isProgrammaticScheduledTaskType = (taskType) =>
  PROGRAMMATIC_SCHEDULED_TASK_TYPE_SET.has(taskType);

// Task types that must NOT be pointed at a managed app. Unlike repo-sync, model
// research has no meaningful per-app variant: its catalog and API live in the
// PortOS install, never another app's checkout. The programmatic bible handlers
// are the same shape for a different reason — a universe is PortOS's own record,
// not any repo's — so an appId on their request is a caller bug, not a scope.
const INSTALL_WIDE_ONLY_TASK_TYPES = new Set([
  'model-comparison-refresh',
  ...PROGRAMMATIC_SCHEDULED_TASK_TYPES,
]);

export function requiresInstallWideTarget(taskType) {
  return INSTALL_WIDE_ONLY_TASK_TYPES.has(taskType);
}
