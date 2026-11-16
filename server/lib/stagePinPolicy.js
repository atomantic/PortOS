/**
 * Run-scoped "ignore per-stage LLM pins" switch (AsyncLocalStorage).
 *
 * `withStagePinsIgnored(ignore, fn)` marks an async subtree, `stagePinsIgnored()` reads it, and `services/stageRunner.js#effectiveStage` enumerates which stage-config fields it strips. Backs Series Autopilot's "use one provider/model for every stage" option.
 * Autopilot threads its run provider/model/effort as SOFT defaults (`providerDefault`/`modelDefault`/`effortDefault`) so a deliberate per-stage pin keeps winning; that meant "run this series on Sol" silently left `pipeline-script-verify` (pinned to codex) and every other pinned stage on its own provider.
 * Why AsyncLocalStorage, not another option key: the flag must reach EVERY leaf LLM call, which fan out through a dozen services (textStages, autoRunner, volumeBeatsRunner, reverseOutline, scriptVerify, editorial checkRunner, arcPlanner, judges, canon extraction) forwarding hand-picked option subsets under two naming conventions
 * (`providerDefault` vs `providerIdDefault`; `verifyComicScript` accepts only the soft names), so one missed forward is an invisible hole. A context flag has one set site and one read site, can't be dropped midway, and reaches `resolveStageContext` (prompt budgeting) for free.
 * Scope safety: the store propagates only to async work *created* inside `fn`; a shared queue (the local-LLM concurrency gate) resumes each waiter through the waiter's own promise and keeps the enqueuer's context, so a force-mode run can't re-route a concurrent manual stage call.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** Run `fn` with per-stage provider/model/effort pins ignored (when `ignore` is true). Returns whatever `fn` returns, including its promise, so the async subtree stays in the context; a falsy `ignore` calls `fn` directly (no context allocation). */
export function withStagePinsIgnored(ignore, fn) {
  if (ignore !== true) return fn();
  return storage.run(true, fn);
}

export function stagePinsIgnored() {
  return storage.getStore() === true;
}
