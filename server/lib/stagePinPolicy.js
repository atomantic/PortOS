/**
 * Run-scoped "ignore per-stage LLM pins" policy.
 *
 * Run-scoped "ignore per-stage LLM pins" switch (AsyncLocalStorage) — `withStagePinsIgnored(ignore,
 * fn)` marks an async subtree, `stagePinsIgnored()` reads it, and
 * `services/stageRunner.js#effectiveStage` enumerates which stage-config fields it strips. Backs
 * Series Autopilot's "use one provider/model for every stage" option.
 *
 * Series Autopilot threads its run provider/model/effort as SOFT defaults
 * (stageRunner's `providerDefault`/`modelDefault`/`effortDefault`) so a
 * deliberate per-stage pin from the Prompts page keeps winning for that stage.
 * That is the right default — but it means "run this whole series on Sol"
 * silently leaves `pipeline-script-verify` (pinned to codex in the shipped
 * stage config) and every other pinned stage on their own provider. Users who
 * want ONE provider/model for an entire run had no way to say so.
 *
 * This module is the switch: `withStagePinsIgnored(true, fn)` marks the whole
 * async subtree of `fn` as "the run's defaults outrank stage pins", and
 * `stagePinsIgnored()` reads it. WHICH fields count as a pin is stageRunner's
 * business, enumerated once in its `effectiveStage` — this module knows only
 * that a run asked for it.
 *
 * Why AsyncLocalStorage rather than another option key: the flag has to reach
 * EVERY leaf LLM call an autopilot run makes, and those calls fan out through a
 * dozen intermediate services (textStages, autoRunner, volumeBeatsRunner,
 * reverseOutline, scriptVerify, editorial checkRunner, arcPlanner, the judges,
 * canon extraction) that each forward a hand-picked subset of option keys under
 * two different naming conventions (`providerDefault` vs `providerIdDefault`) —
 * and some, like `verifyComicScript`, accept only the soft names. Threading one
 * more key through all of them is a dozen edits where a single missed forward
 * is an invisible hole, which is the very failure this feature fixes. An
 * async-context flag has one set site and one read site and cannot be dropped
 * in the middle; it also reaches `resolveStageContext` (prompt budgeting) for
 * free, which no option thread would have.
 *
 * Scope safety: an AsyncLocalStorage store propagates only to async work
 * *created* inside `fn`. A shared queue (the local-LLM concurrency gate) resumes
 * each waiter through a promise the waiter itself created, so it keeps the
 * enqueuer's context — one autopilot run in force mode cannot re-route a
 * concurrent manual stage call.
 *
 * Privacy note: a stage pinned to a local provider so manuscript text never
 * leaves the machine loses that guarantee under this flag, by construction —
 * the user is asking for one provider everywhere. The Autopilot Options copy
 * says so at the checkbox; do not quietly exempt a path here instead.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * Run `fn` with per-stage provider/model/effort pins ignored (when `ignore` is
 * true). Returns whatever `fn` returns — including its promise, so the whole
 * async subtree stays inside the context. A falsy `ignore` calls `fn` directly
 * so the ordinary path never allocates a context.
 */
export function withStagePinsIgnored(ignore, fn) {
  if (ignore !== true) return fn();
  return storage.run(true, fn);
}

/** True when the current async context asked for stage pins to be ignored. */
export function stagePinsIgnored() {
  return storage.getStore() === true;
}
