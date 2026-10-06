/**
 * Human action reminders — one notification when a scheduled step comes due.
 *
 * Arms a one-shot `eventScheduler` timer per open `human-action` thread, re-arms
 * on every thread write (a moved due time, a finished step, a peer-sync apply)
 * and fires `ACTION_DUE` through the normal notification store, which fans out
 * to the bell, Telegram forwarding and voice. The thread records the due time it
 * was reminded for (`remindedFor`), so a restart never repeats a reminder and a
 * step that came due while the server was down is caught up at boot.
 *
 * Only the machine that created a step reminds for it: threads federate to the
 * user's other machines, and each one pinging for the same step would be noise.
 *
 * Deterministic: no provider calls. Started from boot, never by import side
 * effect, so a test that loads the services never writes the notification store.
 */

import * as brainStorage from './brainStorage.js';
import { brainEvents } from './brainStorage.js';
import * as eventScheduler from './eventScheduler.js';
import { addNotification, NOTIFICATION_TYPES } from './notifications.js';
import { humanActionReminderDecision } from '../lib/humanActions.js';

const EVENT_PREFIX = 'human-action-due:';

// threadId → the dueAt its armed timer is for, so a write that leaves the due
// time alone doesn't cancel and re-arm (and re-log) the same timer.
const armed = new Map();
let instanceId = null;
let reconcileTail = Promise.resolve();
let started = false;

const threadLink = (id) => `/brain/threads?thread=${encodeURIComponent(id)}`;

function disarm(id) {
  armed.delete(id);
  eventScheduler.cancel(`${EVENT_PREFIX}${id}`);
}

/** Send the reminder for one thread if it is still due and not yet reminded. */
async function fireHumanActionReminder(threadId, deps = {}) {
  const storage = deps.storage || brainStorage;
  const notify = deps.addNotification || addNotification;
  const now = deps.now ? deps.now() : Date.now();
  armed.delete(threadId);
  let reminded = null;
  // Stamp first, under the record's write queue, so two fires (a timer and a
  // boot catch-up) can't both notify.
  await storage.updateWith('threads', threadId, (fresh) => {
    if (humanActionReminderDecision(fresh, now)?.fire !== true) return null;
    reminded = fresh;
    return { remindedFor: fresh.dueAt };
  });
  if (!reminded) return false;
  await notify({
    type: NOTIFICATION_TYPES.ACTION_DUE,
    title: `Time to: ${reminded.title}`,
    description: reminded.nextAction || 'Open the step for its instructions.',
    priority: ['high', 'urgent'].includes(reminded.priority) ? 'high' : 'medium',
    link: threadLink(threadId),
    metadata: { threadId, dueAt: reminded.dueAt },
  });
  console.log(`⏰ Human action due: ${reminded.title}`);
  return true;
}

/** Arm, re-arm, disarm or fire for every human action thread this machine created. */
async function reconcileHumanActionReminders(deps = {}) {
  const storage = deps.storage || brainStorage;
  const scheduler = deps.scheduler || eventScheduler;
  const now = deps.now ? deps.now() : Date.now();
  const origin = deps.instanceId ?? instanceId;
  const threads = (await storage.getThreads()) || [];
  const keep = new Set();
  const dueNow = [];
  for (const thread of threads) {
    if (origin && thread.originInstanceId && thread.originInstanceId !== origin) continue;
    const decision = humanActionReminderDecision(thread, now);
    if (!decision) continue;
    if (decision.fire) { dueNow.push(thread.id); continue; }
    keep.add(thread.id);
    if (armed.get(thread.id) === thread.dueAt) continue;
    armed.set(thread.id, thread.dueAt);
    scheduler.schedule({
      id: `${EVENT_PREFIX}${thread.id}`,
      type: 'once',
      delayMs: decision.delayMs,
      metadata: { description: `Reminder: ${thread.title}`, threadId: thread.id },
      handler: () => fireHumanActionReminder(thread.id, deps).catch((err) => {
        console.error(`❌ Human action reminder failed for ${thread.id}: ${err.message}`);
      }),
    });
  }
  for (const id of [...armed.keys()]) {
    if (!keep.has(id)) {
      armed.delete(id);
      scheduler.cancel(`${EVENT_PREFIX}${id}`);
    }
  }
  for (const id of dueNow) await fireHumanActionReminder(id, deps);
  return { armed: keep.size, fired: dueNow.length };
}

// Writes arrive in bursts (a whole plan at once), so chain reconciles: each one
// reads the freshest records after the previous one settles.
function queueReconcile() {
  reconcileTail = reconcileTail
    .then(() => reconcileHumanActionReminders())
    .catch((err) => console.error(`❌ Human action reminders could not reconcile: ${err.message}`));
  return reconcileTail;
}

const onThreadEvent = () => { queueReconcile(); };
const onRecordChanged = ({ type } = {}) => { if (type === 'threads') queueReconcile(); };

export async function initHumanActionReminders() {
  if (started) return;
  started = true;
  const { getInstanceId } = await import('./instanceIdentity.js');
  instanceId = await getInstanceId().catch(() => null);
  brainEvents.on('threads:upserted', onThreadEvent);
  brainEvents.on('threads:deleted', onThreadEvent);
  brainEvents.on('record:changed', onRecordChanged);
  const { armed: count, fired } = await queueReconcile() || {};
  console.log(`⏰ Human action reminders ready${count ? ` (${count} armed)` : ''}${fired ? `, ${fired} caught up` : ''}`);
}

function stopHumanActionReminders() {
  brainEvents.off('threads:upserted', onThreadEvent);
  brainEvents.off('threads:deleted', onThreadEvent);
  brainEvents.off('record:changed', onRecordChanged);
  for (const id of [...armed.keys()]) disarm(id);
  started = false;
}

// Test hooks: the clock with injected storage, scheduler and time.
export {
  fireHumanActionReminder as _fireHumanActionReminder,
  reconcileHumanActionReminders as _reconcileHumanActionReminders,
  stopHumanActionReminders as _stopHumanActionReminders,
};
