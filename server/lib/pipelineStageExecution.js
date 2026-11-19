/**
 * The one place a pipeline stage's execution settings land on a task's metadata.
 *
 * `applyStageExecution(metadata, stage, { taskDefaults, clearInheritedExecutionOptions })` applies model/provider/effort pins, `executionOptions` and behavior flags (read-only default, task-default fallback, draft-delivery guard). Shared by task creation (stage 0), the agent-completion hand-off (stage 1+) and the pr-reviewer security preflight (#14388), so a policy added here reaches all three.
 */
import { PIPELINE_STAGE_BEHAVIOR_FLAGS } from './cos/cosTaskMetadata.js';
import { PR_COMPLETIONS } from './prDisposition.js';

/**
 * Apply `stage`'s provider/model/effort pins, `executionOptions` and behavior flags to `metadata`, mutating it in place.
 * - model / provider / effort are SET-only: a stage without its own pin keeps what `metadata` carries (task-level pin or prior stage's).
 * - `executionOptions` belong to a provider: with `clearInheritedExecutionOptions` a stage pinning a provider drops inherited ones first, then copies its own (task creation passes false: nothing is inherited yet, and a task-level option set stays beside stage 0's pin).
 * - A behavior flag resolves stage value, else `false` for a read-only stage, else the run's `taskDefaults`; a run whose task defaults require draft delivery keeps it on every stage, including read-only ones whose output could publish a merged snapshot.
 * `readOnly` itself is left to the caller: creation sets it only when the stage declares it, a hand-off always resets it.
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
