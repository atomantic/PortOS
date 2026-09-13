/**
 * The task card for the programmatic phase of a user-triggered run.
 *
 * Pressing "Run Now" on a scheduled task, or "Review this PR" on an app's
 * PRs/MRs tab, queues an on-demand request. Nothing appeared on the Tasks page
 * until an agent task existed — which, for pr-reviewer, is after the whole
 * deterministic preflight has run (list the external PRs, screen every diff
 * through the model-abuse guard). The click therefore read as a no-op: the
 * button said "queued" and the page it linked to was empty.
 *
 * So a card is written the moment the request is queued, and the preflight
 * reports into it as it goes. The card is a normal internal task carrying
 * `metadata.preflight` (shape owned by lib/preflightPlan.js), which is what the
 * Tasks page renders as a live step list and what tells the PR row which run
 * its button started.
 *
 * Two properties keep it from becoming a fake agent task:
 *
 *   - It is created `in_progress`, never `pending`, so no spawn engine can
 *     admit it — a card has no prompt and no agent, and never will.
 *   - `metadata.preflight` marks it for the orphan sweep, which finishes a
 *     stale card as `interrupted` instead of requeueing it onto an agent
 *     (cos.js#resetOrphanedTasks).
 *
 * Every write here is best-effort: a card is UI, and losing one must never
 * take down the run it describes.
 */

import { applyPreflightStep, createPreflightState, finalizePreflight, preflightHeadline } from '../lib/preflightPlan.js';
import { addTask, getTaskById, updateTask } from './cosTaskStore.js';
import { isUserOriginRequest } from './taskScheduleConstants.js';

/**
 * How long a card may sit `in_progress` before the orphan sweep calls it
 * interrupted. Generous on purpose: a pr-reviewer security scan over a busy
 * repo is minutes of real model work, and reaping a live preflight would make
 * the card lie in the one direction that matters.
 */
export const PREFLIGHT_CARD_STALE_MS = 15 * 60 * 1000;

export const preflightCardId = (requestId) => `preflight-${requestId}`;

export const isPreflightCard = (task) => Boolean(task?.metadata?.preflight?.requestId);

function cardDescription(preflight) {
  const target = preflight.targetPullRequest ? ` #${preflight.targetPullRequest}` : '';
  const scope = preflight.appName ? ` for ${preflight.appName}` : '';
  return `Preparing ${preflight.taskType}${scope}${target}: ${preflightHeadline(preflight)}`;
}

/**
 * Create the card for a queued on-demand request. Callers address the card by
 * `preflightCardId(requestId)` rather than by a return value: the drain re-enters
 * this on a later cycle for a request still waiting on a slot, and `addTask`
 * rejects the repeat as a duplicate id — so a request keeps ONE card, and every
 * report and close site can derive the id without threading one around.
 */
export async function startPreflightCard({ requestId, taskType, appId = null, appName = null, targetPullRequest = null } = {}) {
  if (!requestId || !taskType) return;
  const preflight = createPreflightState({ requestId, taskType, appId, appName, targetPullRequest });
  const id = preflightCardId(requestId);
  await addTask({
    id,
    status: 'in_progress',
    priority: 'HIGH',
    priorityValue: 3,
    taskType: 'internal',
    description: cardDescription(preflight),
    metadata: {
      ...(preflight.appId ? { app: preflight.appId } : {}),
      ...(preflight.appName ? { appName: preflight.appName } : {}),
      analysisType: taskType,
      ...(targetPullRequest ? { targetPullRequest } : {}),
      preflight,
    },
  }, 'internal', { raw: true, suppressDequeue: true }).catch((err) => {
    console.error(`❌ Could not open a preflight card for ${taskType}: ${err.message}`);
  });
}

async function writePreflight(cardId, next) {
  if (!next) return null;
  return updateTask(cardId, {
    description: cardDescription(next),
    metadata: { preflight: next },
  }, 'internal', { suppressDequeue: true }).catch((err) => {
    console.error(`❌ Could not update preflight card ${cardId}: ${err.message}`);
    return null;
  });
}

async function readPreflight(cardId) {
  if (!cardId) return null;
  const task = await getTaskById(cardId).catch(() => null);
  return task?.metadata?.preflight || null;
}

/**
 * Report one programmatic step. Unknown step keys and already-finished cards
 * are no-ops that write nothing — see `applyPreflightStep`.
 */
export async function reportPreflightStep(cardId, key, { status = 'active', detail = null } = {}) {
  const preflight = await readPreflight(cardId);
  if (!preflight) return;
  const next = applyPreflightStep(preflight, key, { status, detail });
  if (next === preflight) return;
  await writePreflight(cardId, next);
}

/**
 * A reporter bound to one card, for code that must not import the task store —
 * `runPrReviewerSecurityPreflight` takes one of these so the pipeline contract
 * stays testable without a task file. Returns a no-op when there is no card, so
 * call sites never branch on it.
 */
export function preflightReporter(cardId) {
  if (!cardId) return () => Promise.resolve();
  return (key, options) => reportPreflightStep(cardId, key, options);
}

/**
 * Close the card out. `outcome` is one of 'handed-off' | 'nothing-to-do' |
 * 'failed' | 'interrupted' (lib/preflightPlan.js).
 *
 * `preflightFailure` is stamped alongside for a failed outcome because the PR
 * row reads that key to paint its "review failed" state — the same contract the
 * standalone failure task used before the card existed.
 */
export async function finishPreflightCard(cardId, options = {}) {
  const preflight = await readPreflight(cardId);
  if (!preflight) return null;
  return closeReadPreflight(cardId, preflight, options);
}

/**
 * The close itself, against a preflight the caller has ALREADY read — so a
 * caller that advanced a step first persists the step and the close as one
 * write rather than re-reading the card it just wrote.
 */
async function closeReadPreflight(cardId, preflight, { outcome, reason = null, note = null, resultTaskId = null } = {}) {
  const next = finalizePreflight(preflight, { outcome, reason, note, resultTaskId });
  // `finalizePreflight` returns the same object for an already-closed card, and
  // a second close is expected: the drain closes generically after a path that
  // already closed with the specific reason. Writing again would only re-stamp
  // the task and re-emit `tasks:changed`.
  if (next === preflight) return null;
  return updateTask(cardId, {
    status: 'completed',
    description: cardDescription(next),
    metadata: {
      preflight: next,
      ...(outcome === 'failed' ? { preflightFailure: reason, note } : {}),
      ...(resultTaskId ? { preflightResultTaskId: resultTaskId } : {}),
      completedAt: new Date().toISOString(),
    },
  }, 'internal', { suppressDequeue: true }).catch((err) => {
    console.error(`❌ Could not close preflight card ${cardId}: ${err.message}`);
    return null;
  });
}

/**
 * Close a card once the spawn decision on whatever its preflight produced is
 * final. `resultTaskId` names the task that will run, or is null when the run
 * produced none — a gate skipped it, or the spawn tier declined it.
 *
 * THE reason this is one helper: every engine that serves a user's on-demand
 * request reaches this same point, and each used to spell it out for itself.
 * The idle-review path that STEALS a queued request
 * (cosTaskGenerator#generateManagedAppImprovementTask) spelled out nothing at
 * all, so a card opened by a human's "Run" sat at "Waiting for a free task
 * slot" — with its own agent visibly already working — until the orphan sweep
 * mislabelled it `interrupted` (PREFLIGHT_CARD_STALE_MS later). Marking
 * `dispatch` and closing `handed-off` in ONE place is what stops the engines
 * drifting into telling different stories about the same run.
 *
 * One read-modify-write, not two: the step and the close land in the same
 * persisted card, so the Tasks page never renders the frame in between.
 */
export async function finishPreflightDispatch(cardId, resultTaskId = null) {
  const preflight = await readPreflight(cardId);
  if (!preflight) return null;
  return resultTaskId
    ? closeReadPreflight(cardId, applyPreflightStep(preflight, 'dispatch'), { outcome: 'handed-off', resultTaskId })
    : closeReadPreflight(cardId, preflight, { outcome: 'nothing-to-do' });
}

/**
 * The card id for a request, or null when the request is not a human's Run.
 *
 * Derived rather than stamped on the request (see `startPreflightCard`), and
 * one export rather than the ternary at each engine: "only a USER origin is
 * carded" is a policy the card owner decides, and it has to match the gate
 * `startPreflightCard` is called behind or an engine reports into a card that
 * was never opened.
 */
export const cardIdForRequest = (request) =>
  (isUserOriginRequest(request) ? preflightCardId(request.id) : null);

/**
 * Record a terminal preflight outcome whether or not a card was ever opened.
 *
 * A run that failed its preflight needs a durable record for the user and for
 * the PR row's `preflightFailure` contract — but only a HUMAN's Run opens a card
 * up front, so an automated cadence run reaching the same failure has nothing to
 * close. Minting the card in its terminal state here keeps that one event to ONE
 * shape: before this, the generator wrote a separate standalone task for the
 * uncarded case, so the same failure looked like two different records depending
 * on who triggered it, and two writers had to agree on the same metadata keys.
 */
export async function recordPreflightOutcome({
  requestId, taskType, appId = null, appName = null, targetPullRequest = null,
  outcome, reason = null, note = null,
} = {}) {
  if (!requestId || !taskType) return null;
  const cardId = preflightCardId(requestId);
  const closed = await finishPreflightCard(cardId, { outcome, reason, note });
  if (closed) return closed;

  const preflight = finalizePreflight(
    createPreflightState({ requestId, taskType, appId, appName, targetPullRequest }),
    { outcome, reason, note },
  );
  return addTask({
    id: cardId,
    status: 'completed',
    priority: 'MEDIUM',
    priorityValue: 2,
    taskType: 'internal',
    description: cardDescription(preflight),
    metadata: {
      ...(appId ? { app: appId } : {}),
      ...(appName ? { appName } : {}),
      analysisType: taskType,
      ...(targetPullRequest ? { targetPullRequest } : {}),
      preflight,
      ...(outcome === 'failed' ? { preflightFailure: reason, note } : {}),
      completedAt: new Date().toISOString(),
    },
  }, 'internal', { raw: true, suppressDequeue: true }).catch((err) => {
    console.error(`❌ Could not record the preflight outcome for ${taskType}: ${err.message}`);
    return null;
  });
}

/**
 * Has this card been sitting unfinished long enough that the process running it
 * is certainly gone? Read by the orphan sweep, which must distinguish a live
 * multi-minute security scan from a card stranded by a restart.
 */
export function isStalePreflightCard(task, now = Date.now()) {
  const preflight = task?.metadata?.preflight;
  if (!preflight) return false;
  const stamp = Date.parse(preflight.updatedAt || preflight.startedAt || '');
  return !Number.isFinite(stamp) || (now - stamp) > PREFLIGHT_CARD_STALE_MS;
}
