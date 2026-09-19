/**
 * Goal-fidelity calibration — queue the fix for a detector that was wrong.
 *
 * The follow-up investigator (`goalFidelityFollowUp.js` queues it) is sent to
 * reconcile a fidelity finding. Sometimes it gets there and finds nothing to
 * reconcile: the objective WAS delivered and the reviewer misjudged it. Until
 * now that was where the signal died — the agent shipped nothing, the run
 * record kept a `rethink` nobody could contest, and the same blind spot held
 * the next run of the same shape.
 *
 * This module is the other end of that report. It turns "the detector was
 * wrong, and here is what it could not see" into a task against PortOS's own
 * repo to close that gap. `lib/goalFidelityCalibration.js` owns the vocabulary,
 * the dedup identity and the task body; this owns the settings read, the queue
 * write, and the refusals.
 *
 * THREE things here are deliberate and easy to get backwards:
 *
 *  - The calibration is queued against PORTOS, never the app whose run produced
 *    the finding. `fileInvestigationTask` takes `app` from the caller and
 *    defaults to PortOS when it is absent, so this simply never passes one. The
 *    finding belonged to the managed app; the judge that produced it is PortOS
 *    code, and a PortOS prompt fix sitting in a managed app's queue is work
 *    nothing can do.
 *  - It is gated on the GATE, not on the follow-up switches. `fileIssue` /
 *    `queueTask` decide whether a finding reaches a tracker or an agent — both
 *    outward, both off by default. A calibration report writes one local queue
 *    entry and only ever exists because something explicitly reported a false
 *    positive, so requiring a second opt-in would discard the single most
 *    valuable signal the feature produces from the installs most likely to
 *    produce it. The gate being off is still a refusal: with no reviewer there
 *    are no verdicts, so a report against it describes something that cannot
 *    have happened.
 *  - Nothing here can fail a run or a request beyond its own result. The caller
 *    reports what happened and moves on.
 *
 */

import { updateTask } from './cos.js';
import { getAgents, updateAgent } from './cosAgentLifecycle.js';
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
 * Is the goal-fidelity gate configured at all on this install?
 *
 * Reads the RAW `enabled` flag rather than `resolveGoalFidelityConfig`, which
 * also requires a callable local backend. The backend answers "can we judge a
 * run right now"; by the time a report arrives a run was already judged, and a
 * user who has since swapped local models would otherwise have their report
 * dropped for a reason that has nothing to do with it.
 */
const gateEnabled = (codeReview) => codeReview?.goalFidelity?.enabled !== false;

/**
 * Record an overturned goal-fidelity finding and queue the calibration.
 *
 * @param {Object} args
 * @param {string} args.gap - which context the reviewer was missing
 *   (`GOAL_FIDELITY_CONTEXT_GAPS`); an unrecognized value normalizes to `other`
 *   rather than being refused, because a report with a bad enum still carries a
 *   real diagnosis in its prose. The one refusal is a report with no recognized
 *   gap AND no filled-in prose — the unrun template.
 * @param {string} [args.detail] - the investigator's diagnosis, free text.
 * @param {string} [args.evidence] - what proves the objective was delivered.
 * @param {string} [args.fingerprint] - the overturned finding's own key, kept as
 *   provenance only. Never the dedup key: that is derived from the gap here, so
 *   a caller cannot choose (or collide with) the identity its report files under.
 * @param {string} [args.taskId] - the task whose run was misjudged, recorded on
 *   the calibration as an affected task. A repeat report for the same gap folds
 *   into the open calibration and unions its run id in (`unionAffectedRun`), so
 *   the task names every run the gap cost rather than only the first.
 * @param {string} [args.verdict] - the verdict that was overturned, for the body.
 * @returns {Promise<{queued: boolean, gap: string, fingerprint: string,
 *   taskId?: string, approvalRequired?: boolean, duplicate?: boolean,
 *   reason?: string}>}
 */
export async function reportGoalFidelityFalsePositive({ gap, detail, evidence, fingerprint, taskId, verdict } = {}) {
  const resolvedGap = normalizeGoalFidelityContextGap(gap);
  const calibrationFingerprint = goalFidelityCalibrationFingerprint(resolvedGap);
  // The report block hands the agent a ready-to-run `curl` full of `<…>`
  // placeholders. One run verbatim would queue an `other` calibration whose
  // diagnosis is the template — a task that reads like a report and says
  // nothing, which an agent then spends a run on. Refused with an actionable
  // reason rather than 400'd, since the caller is an agent reading the body.
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
    // SUPERVISED rather than the unattended merge-on-green default, and the
    // reason is specific to what this task edits: the judge itself. Every other
    // auto-filed investigation fixes one failure. A calibration rewrites the
    // objective assembly, the diff window, or the rubric that every FUTURE run
    // is judged against — and the cheapest way to stop a false positive
    // recurring is to stop the gate holding runs at all. That change would pass
    // CI, look like a fix, and silently disarm the gate for good.
  }, { delivery: SUPERVISED_INVESTIGATION_DELIVERY });

  const outcome = investigationOutcome(filed, { subject: 'the calibration task' });
  if (outcome.duplicate) await unionAffectedRun(filed.task, taskId);
  if (outcome.queued) await stampOverturnedRuns(taskId, resolvedGap, outcome.taskId);
  return report({ gap: resolvedGap, fingerprint: calibrationFingerprint, ...outcome });
}

/**
 * Mark every retained run for the reported task without rewriting the reviewer's
 * verdict. A task can have more than one agent attempt, and each card needs to
 * stop presenting the disproved finding as current.
 *
 * Best-effort like the calibration-task union below: the calibration already
 * exists at this point, so a stale/missing run record must not turn a successful
 * report into an HTTP failure.
 */
async function stampOverturnedRuns(taskId, gap, calibrationTaskId) {
  if (!taskId || !calibrationTaskId) return;
  const agents = await getAgents().catch((err) => {
    console.error(`❌ goal-fidelity calibration: could not resolve runs for ${taskId}: ${err.message}`);
    return [];
  });
  const matches = agents.filter(agent => agent.taskId === taskId || agent.metadata?.taskId === taskId);
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
 * Fold a repeat report's run into the calibration that already tracks this gap.
 *
 * `addTask`'s dedup returns the surviving task untouched — only the
 * agent-failure producer carries a union of its own — so without this the
 * calibration names the FIRST misjudged run and no other, however many times
 * the gap fired. That count is exactly the evidence the task body tells the
 * agent to size the fix by ("every run the gap cost"), so losing it makes a
 * recurring blind spot look like a one-off.
 *
 * Same shape as the agent-failure producer's union: metadata AND a line in the
 * body, because the body is what the agent reads. Best-effort — a calibration
 * that is queued but missing one run id is worth more than a failed report.
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
 * Log what happened, then hand the result back unchanged.
 *
 * The route answers a reporting AGENT, so without this the only record that a
 * calibration was queued — or refused — lives in an HTTP response nobody reads.
 * Counts and identifiers only: the report's prose is model-authored text derived
 * from an untrusted diff and belongs in the task body, not a log line.
 */
function report(result) {
  console.log(`${result.queued ? '🎯' : '⚠️'} ${formatGoalFidelityCalibrationSummary(result)}`);
  return result;
}
