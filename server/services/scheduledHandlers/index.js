/**
 * Programmatic scheduled-task handlers: work PortOS performs ITSELF (no agent, no CoS task).
 * Each module exports:
 *   countPending({ params, job, family })            → { count, detail, context? }
 *   run({ params, job, family, context, force })     → { dispatched, summary?, reason?, detail? }
 *
 * `countPending` is side-effect free and makes NO AI provider call (AGENTS.md: no
 * cold-bootstrap LLM calls); its opaque `context` goes back to `run`, which must work
 * with `context: undefined`. `run` alone may spend and reports `dispatched: false` with a
 * `reason` when it declines, so a quota caller does not charge its dispatch cap.
 * A present `family` (Quota Burn via `quotaBurnInvoke.js`) pins work to that subscription
 * (`providerPick.js`); absent means an ordinary scheduled run. Modules are lazy-imported
 * so probing types does not load the universe store and media queue.
 */

/**
 * Task type → module import thunk. The TASK-TYPE list lives in `taskScheduleRegistry.js`
 * (`PROGRAMMATIC_SCHEDULED_TASK_TYPES`), not derived from these keys, so that widely
 * imported registry takes no import (server/AGENTS.md "Import scoping");
 * `taskScheduleRegistry.programmatic.test.js` asserts the two agree.
 */
export const SCHEDULED_HANDLER_MODULES = {
  'development-watchdog': () => import('./developmentWatchdog.js'),
  'music-video-autopilot': () => import('./musicVideoAutopilot.js'),
  'universe-bible-describe': () => import('./universeBibleDescribe.js'),
  'universe-bible-images': () => import('./universeBibleImages.js'),
};

// `Object.hasOwn`: an inherited key like 'constructor' must not resolve to a module.
const load = async (taskType) =>
  (typeof taskType === 'string' && Object.hasOwn(SCHEDULED_HANDLER_MODULES, taskType)
    ? SCHEDULED_HANDLER_MODULES[taskType]()
    : null);

/** Pending-work probe for one handler. Never throws: failures report zero pending with the error as detail. */
export async function countScheduledHandlerPending({ taskType, params, job, family } = {}) {
  // Lazy init and synchronous handler throws share the rejected-promise boundary.
  return load(taskType)
    .then((mod) => mod
      ? mod.countPending({ params, job, family })
      : { count: 0, detail: `unknown scheduled handler: ${taskType}` })
    .catch((err) => ({ count: 0, detail: `probe failed: ${err.message}` }));
}

/** Run one handler; a throw becomes a non-dispatch so failed work never charges a quota window's cap. */
export async function runScheduledHandler({ taskType, params, job, family, context, force = false } = {}) {
  return load(taskType)
    .then((mod) => mod
      ? mod.run({ params, job, family, context, force })
      : { dispatched: false, reason: `unknown scheduled handler: ${taskType}` })
    .catch((err) => ({ dispatched: false, reason: `handler failed: ${err.message}` }));
}
