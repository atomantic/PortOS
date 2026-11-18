/**
 * Goal-fidelity calibration — queue the fix for a detector that was wrong.
 *
 * When the follow-up investigator (`goalFidelityFollowUp.js`) finds the objective WAS
 * delivered, this turns "the detector was wrong, and here is what it could not see" into a
 * task against PortOS's own repo. `lib/goalFidelityCalibration.js` owns the vocabulary,
 * dedup identity and task body; this owns the settings read, the queue write and refusals.
 *
 *  - Queued against PORTOS, never the app whose run produced the finding
 *    (`fileInvestigationTask` defaults to PortOS when no `app` is passed): the judge is
 *    PortOS code, and a PortOS prompt fix in a managed app's queue can't be done.
 *  - Gated on the GATE, not the outward follow-up switches (`fileIssue` / `queueTask`):
 *    a report is one local queue entry from an explicit false-positive report, and a
 *    second opt-in would discard the most valuable signal. Gate off is still a refusal:
 *    with no reviewer there are no verdicts to contest.
 *  - Nothing here can fail a run or request beyond its own result.
 */

import { updateTask } from './cos/cosTaskStore.js';
import { getAgents, updateAgent } from './cos/cosAgentLifecycle.js';
import { getSettings } from './settings.js';
import { fileInvestigationTask } from './investigationTaskProducer.js';
import { SUPERVISED_INVESTIGATION_DELIVERY, investigationOutcome } from '../lib/investigationTasks.js';
import { isPlainObject } from '../lib/objects.js';
import {
  GOAL_FIDELITY_CONTEXT_GAPS,
  buildGoalFidelityCalibrationTask,
  formatGoalFidelityCalibrationSummary,
  goalFidelityCalibrationFingerprint,
  goalFidelityReportIsSubstantive,
  normalizeGoalFidelityContextGap,
} from '../lib/goalFidelityCalibration.js';

/**
 * Is the goal-fidelity gate configured at all? Reads the RAW `enabled` flag, not
 * `resolveGoalFidelityConfig` (which also needs a callable backend): by the time a report
 * arrives the run was already judged, and swapping local models must not drop it.
 */
const gateEnabled = (codeReview) => codeReview?.goalFidelity?.enabled !== false;

/**
 * Record an overturned goal-fidelity finding and queue the calibration.
 *
 * @param {Object} args
 * @param {string} args.gap - which context the reviewer was missing
 *   (`GOAL_FIDELITY_CONTEXT_GAPS`); an unrecognized value normalizes to `other`. The one
 *   refusal is no recognized gap AND no filled-in prose (the unrun template).
 * @param {string} [args.detail] - the investigator's diagnosis, free text.
 * @param {string} [args.evidence] - what proves the objective was delivered.
 * @param {string} [args.fingerprint] - the overturned finding's key, provenance only; the
 *   dedup key is derived from the gap so a caller cannot choose or collide with it.
 * @param {string} [args.taskId] - the task whose run was misjudged; a repeat report for
 *   the same gap unions its run id in (`unionAffectedRun`).
 * @param {string} [args.verdict] - the verdict that was overturned, for the body.
 * @returns {Promise<{queued: boolean, gap: string, fingerprint: string,
 *   taskId?: string, approvalRequired?: boolean, duplicate?: boolean,
 *   reason?: string}>}
 */
export async function reportGoalFidelityFalsePositive({ gap, detail, evidence, fingerprint, taskId, verdict } = {}) {
  const resolvedGap = normalizeGoalFidelityContextGap(gap);
  const calibrationFingerprint = goalFidelityCalibrationFingerprint(resolvedGap);
  // The report block hands the agent a `curl` full of `<…>` placeholders; running it
  // verbatim would queue an `other` calibration whose diagnosis is the template. Refused
  // with an actionable reason rather than 400'd, since the caller is an agent.
  if (!goalFidelityReportIsSubstantive({ gap, detail, evidence })) {
    return report({
      queued: false,
      gap: resolvedGap,
      fingerprint: calibrationFingerprint,
      reason: `the report was still the unfilled template — send a gap from ${GOAL_FIDELITY_CONTEXT_GAPS.join('/')}, and say in 'detail' what the reviewer could not see`,
    });
  }
  const settings = await getSettings().catch(() => null);
  if (!gateEnabled(settings?.codeReview)) {
    return report({
      queued: false,
      gap: resolvedGap,
      fingerprint: calibrationFingerprint,
      reason: 'the goal-fidelity gate is disabled on this install, so no review could have produced this finding',
    });
  }

  const description = buildGoalFidelityCalibrationTask({
    gap: resolvedGap,
    detail,
    evidence,
    findingFingerprint: fingerprint,
    taskId,
    verdict,
  });
  const filed = await fileInvestigationTask({
    fingerprint: calibrationFingerprint,
    description,
    affectedTasks: taskId ? [taskId] : [],
    priority: 'MEDIUM',
    context: `Auto-generated from an overturned goal-fidelity finding (${resolvedGap})`,
    // SUPERVISED, not unattended merge-on-green: this task edits the judge itself (objective
    // assembly, diff window, rubric), and the cheapest "fix" for a false positive is to stop
    // the gate holding runs, which would pass CI and silently disarm it.
  }, { delivery: SUPERVISED_INVESTIGATION_DELIVERY });

  const outcome = investigationOutcome(filed, { subject: 'the calibration task' });
  if (outcome.duplicate) await unionAffectedRun(filed.task, taskId);
  if (outcome.queued) await stampOverturnedRuns(taskId, resolvedGap, outcome.taskId);
  return report({ gap: resolvedGap, fingerprint: calibrationFingerprint, ...outcome });
}

/**
 * Mark every retained run for the reported task without rewriting the reviewer's verdict.
 * Best-effort: the calibration already exists, so a stale run record must not fail the report.
 */
async function stampOverturnedRuns(taskId, gap, calibrationTaskId) {
  if (!taskId || !calibrationTaskId) return;
  const agents = await getAgents().catch((err) => {
    console.error(`❌ goal-fidelity calibration: could not resolve runs for ${taskId}: ${err.message}`);
    return [];
  });
  const matches = agents.filter(agent => (
    agent.taskId === taskId || agent.metadata?.taskId === taskId
  ) && ['fix-first', 'rethink'].includes(agent.result?.goalFidelity?.verdict));
  const at = new Date().toISOString();
  await Promise.all(matches.map((agent) => {
    const result = isPlainObject(agent.result) ? agent.result : {};
    const goalFidelity = isPlainObject(result.goalFidelity) ? result.goalFidelity : {};
    return updateAgent(agent.id, {
      result: {
        ...result,
        goalFidelity: {
          ...goalFidelity,
          overturned: { gap, calibrationTaskId, at },
        },
      },
    }).catch((err) => {
      console.error(`❌ goal-fidelity calibration: could not stamp run ${agent.id}: ${err.message}`);
    });
  }));
}

/**
 * Fold a repeat report's run into the calibration already tracking this gap: `addTask`'s
 * dedup returns the survivor untouched, so without this only the FIRST misjudged run is
 * named and a recurring blind spot looks like a one-off. Metadata AND a body line (the
 * body is what the agent reads). Best-effort.
 */
async function unionAffectedRun(task, taskId) {
  const affected = Array.isArray(task?.metadata?.affectedTasks) ? task.metadata.affectedTasks : [];
  if (!taskId || !task?.id || affected.includes(taskId)) return;
  await updateTask(task.id, {
    description: `${task.description}\n- Also misjudged task \`${taskId}\` (same context gap).`,
    metadata: { affectedTasks: [...affected, taskId] },
  }, 'internal').catch((err) => {
    console.error(`❌ goal-fidelity calibration: could not union ${taskId} into ${task.id}: ${err.message}`);
  });
}

/**
 * Log what happened, then hand the result back unchanged. Counts and identifiers only:
 * the report's prose derives from an untrusted diff and belongs in the task body.
 */
function report(result) {
  console.log(`${result.queued ? '🎯' : '⚠️'} ${formatGoalFidelityCalibrationSummary(result)}`);
  return result;
}
