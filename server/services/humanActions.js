/**
 * Human action plans — scheduled steps only the person can take.
 *
 * Each step is written as a Brain thread tagged `human-action` (and
 * `plan:<planKey>`), so it lands in Review Hub › Actions on its day and in the
 * Open Threads widget with no new UI. The step's instructions and its
 * ready-to-paste content live in the thread's next action + notes; the
 * reminder clock (`humanActionReminders.js`) notifies when it comes due.
 *
 * Planning the same `planKey` again replaces that plan's steps that are still
 * open, and leaves the ones the person already finished alone.
 */

import * as brainStorage from './brainStorage.js';
import {
  HUMAN_ACTION_SOURCE,
  humanActionPlanTag,
  humanActionThreadFields,
  isHumanActionThread,
} from '../lib/humanActions.js';
import { isTerminalThreadStatus } from '../lib/brainThreads.js';

// One write at a time per plan: two overlapping requests for the same plan (an
// agent retry) would otherwise both archive the same open steps and both
// create a full set, doubling every step and reminder.
const planTails = new Map();

/**
 * Write a validated plan (see `humanActionPlanSchema`) as Brain threads.
 * Returns `{ planKey, created: [thread], replaced: number }`.
 */
export function scheduleHumanActionPlan(plan) {
  const previous = planTails.get(plan.planKey) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => writePlan(plan));
  const tail = run.catch(() => {});
  planTails.set(plan.planKey, tail);
  tail.then(() => { if (planTails.get(plan.planKey) === tail) planTails.delete(plan.planKey); });
  return run;
}

async function writePlan(plan) {
  const tag = humanActionPlanTag(plan.planKey);
  const existing = (await brainStorage.getThreads()) || [];
  const stale = existing.filter((thread) => isHumanActionThread(thread)
    && thread.tags.includes(tag)
    && !isTerminalThreadStatus(thread.status));
  // Archive rather than delete: a replaced step stays in History, so nothing
  // the person was looking at vanishes without a trace.
  const closedAt = new Date().toISOString();
  for (const thread of stale) {
    await brainStorage.updateWith('threads', thread.id, (fresh) => (isTerminalThreadStatus(fresh.status)
      ? null
      : { status: 'archived', closedAt }));
  }
  const steps = [...plan.steps].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const created = [];
  for (const step of steps) {
    created.push(await brainStorage.createThread({
      ...humanActionThreadFields(step, plan),
      source: HUMAN_ACTION_SOURCE,
      externalState: 'unknown',
      closedAt: null,
    }));
  }
  console.log(`🗓️ Human action plan "${plan.title}": ${created.length} step(s) scheduled, ${stale.length} replaced`);
  return { planKey: plan.planKey, created, replaced: stale.length };
}

/** Human action threads, soonest due first. `includeDone` adds finished ones. */
export async function listHumanActions({ planKey = null, includeDone = false } = {}) {
  const threads = (await brainStorage.getThreads()) || [];
  const tag = planKey ? humanActionPlanTag(planKey) : null;
  return threads
    .filter((thread) => isHumanActionThread(thread)
      && (!tag || thread.tags.includes(tag))
      && (includeDone || !isTerminalThreadStatus(thread.status)))
    .sort((a, b) => (Date.parse(a.dueAt) || Infinity) - (Date.parse(b.dueAt) || Infinity));
}
