/**
 * Investigation-task producer — the one place a failure-driven task is filed.
 *
 * Four producers file "something broke, go find out why" tasks: an agent failure
 * (`agentErrorAnalysis.js`), an AI-provider failure and an uncaught crash
 * (`autoFixer.js`), and repeated agent orphaning (`agentManagement.js`). They all
 * have to agree on the same three things, and when each hand-assembled them they
 * did not:
 *
 *  - the APPROVAL verdict — unattended by default, held only on a failure loop;
 *  - the MARKERS (`isInvestigation`, `investigationFingerprint`, `affectedTasks`,
 *    `approvalReason`) that the dedup scan, the reaper, the meta-cascade guard,
 *    and the auto-retry all read;
 *  - the STORM COUNTER, which is only a real signal if every producer both reads
 *    it and contributes to it.
 *
 * Before this module, three of the four wrote no fingerprint at all — so
 * `repeat-fingerprint` could never fire for them — and only one pushed a
 * creation stamp, so `failure-storm` counted a quarter of the storm.
 *
 * Goes through the `cos.js` facade for its task I/O, matching the producers it
 * was extracted from — every one of them already imports `cos.js`, so this adds
 * no module edge, and `cos.js` imports nothing from here. (The RETRY side,
 * `investigationRetry.js`, must use `cosTaskStore` directly instead: `cos.js`
 * subscribes to it, so the facade would close a load-time cycle there.)
 */

import { addTask, getAllTasks } from './cos.js';
import {
  INVESTIGATION_CIRCUIT_MAX_CREATIONS,
  INVESTIGATION_CIRCUIT_WINDOW_MS,
  INVESTIGATION_TASK_DELIVERY,
  UNATTENDED_APPROVAL_VERDICT,
  resolveInvestigationApproval,
} from '../lib/investigationTasks.js';

let investigationCreationStamps = []; // ms timestamps, newest-last

/**
 * How many investigation creations are still inside the rolling circuit window.
 * Prunes aged-out stamps as a side effect, so the circuit auto-closes without a
 * manual reset. The count (not just a boolean "open?") is what callers need: at
 * the cap the task is suppressed entirely, and below the cap a non-zero count is
 * the `failure-storm` loop signal that holds it for a human.
 */
export function recentInvestigationCreations(now = Date.now()) {
  investigationCreationStamps = investigationCreationStamps.filter(t => now - t < INVESTIGATION_CIRCUIT_WINDOW_MS);
  return investigationCreationStamps.length;
}

/** Is the circuit OPEN — i.e. should this producer suppress the task entirely? */
export function investigationCircuitOpen(now = Date.now()) {
  return recentInvestigationCreations(now) >= INVESTIGATION_CIRCUIT_MAX_CREATIONS;
}

/**
 * Record a genuine creation against the shared circuit. Producers call this after
 * `addTask` actually mints a task — a description-level dedup returning an
 * existing task is not a new creation and must not count.
 */
export function noteInvestigationFiled(now = Date.now()) {
  investigationCreationStamps.push(now);
}

/** Test hook — the stamp list is module state, so suites reset it between cases. */
export function __resetInvestigationCircuit() {
  investigationCreationStamps = [];
}

/** Every task across both queues, flattened. */
export async function readAllTasksFlat() {
  const { user, cos } = await getAllTasks();
  return [...(user?.tasks || []), ...(cos?.tasks || [])];
}

/**
 * The approval verdict for a new investigation, read against the live backlog.
 * The async half of the pure `resolveInvestigationApproval`.
 *
 * FAILS OPEN: a policy read that throws must not put the diagnosis back behind a
 * human — that is the stall this whole mechanism exists to remove. Callers get
 * the unattended verdict and file the task.
 *
 * @param {string} fingerprint the failure's `category:kind:scope` dedup key
 * @param {{ now?: number, tasks?: object[] }} [opts] `tasks` lets a caller that
 *   already read the backlog (the agent-failure producer does, for its dedup
 *   scan) skip a second read of both task files.
 */
export async function resolveAutoInvestigationApproval(fingerprint, { now = Date.now(), tasks } = {}) {
  const backlog = tasks || await readAllTasksFlat().catch(() => null);
  if (!backlog) return UNATTENDED_APPROVAL_VERDICT;
  return resolveInvestigationApproval({
    fingerprint,
    tasks: backlog,
    recentCreations: recentInvestigationCreations(now),
    now
  });
}

/**
 * File an investigation task with the shared verdict + markers, and record it
 * against the circuit.
 *
 * For the producers whose failure has no per-task dedup of its own (the provider,
 * crash, and orphan paths — each already guarded upstream by its own dedupe and
 * circuit breaker). The agent-failure producer keeps its own creation path: it
 * carries a durable fingerprint dedup that must union a repeat failure into the
 * SURVIVING investigation rather than file a new one, plus a serialization tail
 * closing the TOCTOU between the scan and the write.
 *
 * A held task gets the "why this is held for you" prose appended as a section, so
 * the user reading the queue does not have to infer why this one stopped for them.
 *
 * Deliberately does NOT hard-suppress on `investigationCircuitOpen`. Its callers
 * already bound their own fan-out (autoFixer's per-resource dedupe + circuit; the
 * orphan path's own retry budget), and one of them — manual error recovery — is a
 * user clicking "investigate this"; silently dropping that because unrelated
 * failures filled the window is worse than filing it. The shared counter still
 * drives the softer `failure-storm` response: hold it for a human rather than
 * spend an unattended agent on a symptom.
 *
 * @param {{ fingerprint: string, description: string, affectedTasks?: string[] }} args
 *   plus any further `addTask` fields (priority, context, diagnostics)
 * @returns {Promise<{ task: object|null, approvalRequired: boolean, loopReason: string|null }>}
 */
export async function fileInvestigationTask({ fingerprint, description, affectedTasks = [], ...extra } = {}, { now = Date.now() } = {}) {
  const verdict = await resolveAutoInvestigationApproval(fingerprint, { now });
  const body = verdict.loopProse
    ? `${description}\n\n## Why this is held for you\n${verdict.loopProse}`
    : description;

  const task = await addTask({
    ...extra,
    ...INVESTIGATION_TASK_DELIVERY,
    description: body,
    approvalRequired: verdict.approvalRequired,
    approvalReason: verdict.approvalReason,
    // The markers the shared machinery reads: the dedup scan and the loop policy
    // (fingerprint), the meta-cascade guard and the reaper (isInvestigation), and
    // the auto-retry that revives the blocked work (affectedTasks).
    isInvestigation: true,
    investigationFingerprint: fingerprint,
    ...(affectedTasks.length > 0 && { affectedTasks })
  }, 'internal');

  if (!task?.duplicate) noteInvestigationFiled(now);
  return { task, approvalRequired: verdict.approvalRequired, loopReason: verdict.loopReason };
}
