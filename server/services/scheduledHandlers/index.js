/**
 * Programmatic scheduled-task handlers.
 *
 * A handler is one unit of work PortOS performs ITSELF — no agent is spawned,
 * no CoS task is queued, and no spawn slot is consumed. Each module exports:
 *
 *   countPending({ params, job, family })            → { count, detail, context? }
 *   run({ params, job, family, context, force })     → { dispatched, summary?, reason?, detail? }
 *
 * `countPending` must be side-effect free — the Quota Burn config page calls it
 * for every configured job on every load, and the Schedule page may probe a
 * handler to show its backlog. It writes nothing, enqueues nothing, and makes NO
 * AI provider call (AGENTS.md: no cold-bootstrap LLM calls). It may return an
 * opaque `context` (whatever it already computed) which the caller hands straight
 * back to `run`, so a probe that scanned every universe bible doesn't make `run`
 * repeat the scan. `run` must still work with `context: undefined` — the manual
 * "Run Now" path and Quota Burn's force path both call it without a probe.
 *
 * `run` is the only thing that may spend, and reports `dispatched: false` with a
 * `reason` when it declines (nothing to do, misconfigured target) so a quota
 * caller does NOT charge its window's dispatch cap for work that never happened.
 *
 * ONE implementation serves both invocation paths:
 *
 *   - The ordinary scheduled-task manual path (CoS → Schedule → Run Now) drains
 *     an on-demand request for the task type and calls `runScheduledHandler`
 *     with the task's saved `taskMetadata` as its params and NO `family`.
 *   - Quota Burn's runner reaches the same modules through
 *     `quotaBurnJobs/index.js`, passing the burning `family` so the work stays
 *     pinned to that subscription (see `providerPick.js` /
 *     `universeBibleImages.resolveRenderMode`).
 *
 * `family` is therefore the discriminator between the two: present means "a burn
 * is spending THIS family's window, never another's", absent means "an ordinary
 * scheduled run — resolve the provider/backend the way any other task does".
 *
 * Modules are lazy-imported: `universeBibleImages` pulls the whole universe
 * store + media job queue and `universeBibleDescribe` the expand services, so
 * listing the registered types (or probing a type that isn't registered) must
 * not load either.
 */

/**
 * Task type → module import thunk. The single registration point.
 *
 * The matching TASK-TYPE list lives in `taskScheduleRegistry.js`
 * (`PROGRAMMATIC_SCHEDULED_TASK_TYPES`) rather than being derived from these
 * keys, because that registry is reached by a large share of the server suite
 * and must not take on an import for a two-string list (server/AGENTS.md,
 * "Import scoping"). `taskScheduleRegistry.programmatic.test.js` asserts the two
 * agree, so the split cannot drift.
 */
export const SCHEDULED_HANDLER_MODULES = {
  'universe-bible-describe': () => import('./universeBibleDescribe.js'),
  'universe-bible-images': () => import('./universeBibleImages.js'),
};

// `Object.hasOwn`, not a truthiness check, so an inherited key like
// 'constructor' can't resolve to a module.
const load = async (taskType) =>
  (typeof taskType === 'string' && Object.hasOwn(SCHEDULED_HANDLER_MODULES, taskType)
    ? SCHEDULED_HANDLER_MODULES[taskType]()
    : null);

/**
 * Pending-work probe for one handler. Never throws: a handler whose backing
 * store is unavailable reports zero pending with the error as its detail, so one
 * broken handler can't wedge a burn family's whole plan or blank a status page.
 */
export async function countScheduledHandlerPending({ taskType, params, job, family } = {}) {
  const mod = await load(taskType);
  if (!mod) return { count: 0, detail: `unknown scheduled handler: ${taskType}` };
  return mod.countPending({ params, job, family })
    .catch((err) => ({ count: 0, detail: `probe failed: ${err.message}` }));
}

/**
 * Run one handler. Throws are converted to a non-dispatch: the caller treats it
 * as "this handler declined", moves on, and logs the reason — work that failed
 * to start must not charge a quota window's cap.
 */
export async function runScheduledHandler({ taskType, params, job, family, context, force = false } = {}) {
  const mod = await load(taskType);
  if (!mod) return { dispatched: false, reason: `unknown scheduled handler: ${taskType}` };
  return mod.run({ params, job, family, context, force })
    .catch((err) => ({ dispatched: false, reason: `handler failed: ${err.message}` }));
}
