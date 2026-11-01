/**
 * The one place a pipeline stage's execution settings land on a task's
 * metadata. Task creation (stage 0), the agent-completion hand-off (stage 1+)
 * and the pr-reviewer security preflight (its synthetic stage 0 -> stage 1)
 * all apply a stage the same way; a policy added here reaches all three.
 */
import { PIPELINE_STAGE_BEHAVIOR_FLAGS } from './cosValidation.js';
import { PR_COMPLETIONS } from './prDisposition.js';

/**
 * Apply `stage`'s provider/model/effort pins, `executionOptions` and behavior
 * flags to `metadata`, mutating it in place.
 *
 * - model / provider / effort are SET-only: a stage without its own pin keeps
 *   whatever `metadata` already carries (task-level pin or the prior stage's).
 * - `executionOptions` belong to a provider. With `clearInheritedExecutionOptions`
 *   a stage that pins a provider drops the inherited ones first; the stage's own
 *   `executionOptions` are then copied. Task creation passes false: nothing is
 *   inherited yet, and a task-level option set stays beside stage 0's pin.
 * - A behavior flag resolves stage value, else `false` for a read-only stage,
 *   else the run's `taskDefaults`.
 * - A run whose task defaults require draft delivery keeps it on every stage,
 *   including read-only ones whose output could otherwise publish a merged
 *   snapshot.
 *
 * `readOnly` itself is left to the caller: creation only sets it when the stage
 * declares it, while a hand-off always resets it.
 */
export function applyStageExecution(metadata, stage, { taskDefaults = {}, clearInheritedExecutionOptions = false } = {}) {
  if (stage.model) metadata.model = stage.model;
  if (stage.providerId) {
    metadata.provider = stage.providerId;
    metadata.providerId = stage.providerId;
    if (clearInheritedExecutionOptions) delete metadata.executionOptions;
  }
  if (stage.executionOptions !== undefined) metadata.executionOptions = stage.executionOptions;
  if (stage.effort) metadata.effort = stage.effort;

  const stageReadOnly = stage.readOnly ?? false;
  for (const flag of PIPELINE_STAGE_BEHAVIOR_FLAGS) {
    if (flag === 'prCompletion' && taskDefaults.prCompletion === PR_COMPLETIONS.DRAFT) {
      metadata.prCompletion = PR_COMPLETIONS.DRAFT;
    } else if (flag in stage) {
      metadata[flag] = stage[flag];
    } else if (stageReadOnly) {
      metadata[flag] = false;
    } else if (flag in taskDefaults) {
      metadata[flag] = taskDefaults[flag];
    }
  }
  return metadata;
}
