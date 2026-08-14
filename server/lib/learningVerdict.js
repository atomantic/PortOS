/**
 * Learning verdict sentinels (issue #4107)
 *
 * The success-criteria verdict a completed agent run carries on
 * `result.validationPassed` has THREE distinct meanings, and the repo's
 * sentinel rule ("never let absent/failed collapse into valid") applies to all
 * of them:
 *
 *   - `true` / `false` — a machine-checkable criterion was DECLARED and was met
 *     / missed (#2344). Task-learning records the run and lets this verdict
 *     override the runner's exit code.
 *   - `null` — NO criterion was declared for this task shape (interactive/user
 *     tasks, pipeline + media jobs, coordinator types that never commit).
 *     Task-learning records the run and falls back to the exit code.
 *   - `SKIP_LEARNING_VERDICT` — nothing evaluated the run AND it must not be
 *     recorded at all. Neither of the two answers above is honest here: `false`
 *     would blame the model for something it did not do (and poison the #2329
 *     failure-signature window with a non-failure), while `null` would bank the
 *     exit code as a free success for the task type. Emitted when a
 *     programmatic-I/O output hook bails BEFORE it ever looks at the agent's
 *     output — e.g. the task's app was deleted mid-run (`no-app` /
 *     `app-not-found`); see `resolveProgrammaticIoVerdict` in
 *     `services/agentFinalization.js`.
 *
 * A JSON-safe STRING rather than a Symbol, because the verdict is persisted
 * onto the agent record and read back later by the learning backfill. Every
 * pre-existing consumer already narrows with `typeof v === 'boolean'`, so an
 * install running older code degrades the sentinel to `null` — i.e. to exactly
 * the pre-#4107 behavior — instead of misreading it as a failure. That keeps a
 * record written by a newer peer safe for an older reader.
 *
 * Pure and dependency-free so both the finalize path
 * (`services/agentFinalization.js`) and the learning writer
 * (`services/taskLearning/metrics.js`) can import it without touching the agent
 * module import cycle those two sit on either side of.
 */

/** The "nothing evaluated this run — do not record it" verdict. */
export const SKIP_LEARNING_VERDICT = 'skip-learning';

/**
 * True iff `verdict` is the skip sentinel. Strict equality on purpose: an
 * unrecognized string (a future sentinel from a newer peer) is NOT a skip, so it
 * falls through to `toValidationVerdict`'s `null` and gets the recorded,
 * exit-code-fallback treatment rather than silently vanishing from the metrics.
 */
export function isSkipLearningVerdict(verdict) {
  return verdict === SKIP_LEARNING_VERDICT;
}

/**
 * Narrow a raw persisted verdict to the two-value validation contract
 * (`true` / `false` / `null`) every downstream telemetry consumer expects.
 * Anything that is not an explicit boolean — absent, malformed, or the skip
 * sentinel — becomes `null`, so "not evaluated" can never masquerade as
 * "declared and missed".
 */
export function toValidationVerdict(verdict) {
  return typeof verdict === 'boolean' ? verdict : null;
}
