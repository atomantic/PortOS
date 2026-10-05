/**
 * Music Video "needs you" notifications (#10156).
 *
 * The board only reacts to the project it has open, so a scheduled or
 * autonomous run that parks (or a production run / auto-review that stops on a
 * limit) used to sit unnoticed for days. This subscribes to the same
 * `musicVideoEvents` the socket bridge forwards and raises ONE PortOS
 * notification per parked state, deep-linked to the project and stage:
 *
 * - `autonomous`  → awaiting-approval, needs-human, failed, completed
 * - `production`  → limit-reached, needs-human, blocked, needs-replan
 *                   (skipped when an autonomous run owns it — its own
 *                   needs-human notification covers the same stop)
 * - `auto-review` → limit-reached, needs-human
 *                   (skipped when a production run owns it)
 *
 * No provider calls: it only reads events and writes notifications. Started
 * from boot (`initMusicVideoAttentionNotifier`), never by import side effect,
 * so a test that loads the services never writes the real notification store.
 */

import { musicVideoEvents } from './events.js';
import { AUTONOMOUS_ATTENTION_STATUSES, autonomousAttentionLink, describeAutonomousWait } from '../../lib/musicVideoAutonomous.js';

const PRODUCTION_STOPS = new Set(['limit-reached', 'needs-human', 'blocked', 'needs-replan']);
const AUTO_REVIEW_STOPS = new Set(['limit-reached', 'needs-human']);
const MAX_REMEMBERED = 500;

const STOP_LABEL = { 'limit-reached': 'hit its limit', 'needs-human': 'needs you', blocked: 'is blocked', 'needs-replan': 'needs a new plan' };

// A run emits on every step, so the same parked state arrives repeatedly; one
// notification per (run, status, checkpoint) is enough. Bounded, process-local.
const raised = new Set();
const firstTime = (key) => {
  if (raised.has(key)) return false;
  raised.add(key);
  if (raised.size > MAX_REMEMBERED) raised.delete(raised.values().next().value);
  return true;
};

/** The notification a stopped event warrants, or null. Pure — exported for the tests. */
export function attentionNotificationFor(kind, { projectId, run, project } = {}) {
  if (!projectId || !run?.id) return null;
  const name = project?.name || 'Music video';
  const base = `/music-video/${encodeURIComponent(projectId)}`;
  if (kind === 'autonomous') {
    if (!AUTONOMOUS_ATTENTION_STATUSES.includes(run.status)) return null;
    const done = run.status === 'completed';
    return {
      key: `autonomous:${run.id}:${run.status}:${run.awaiting || run.stage || ''}`,
      title: done ? 'Music video finished' : 'Music video needs you',
      description: done ? `"${name}" finished — review it before publishing` : describeAutonomousWait(name, run),
      priority: done ? 'low' : 'high',
      link: autonomousAttentionLink(projectId, run),
      metadata: { projectId, runId: run.id, status: run.status, source: 'autonomous' },
    };
  }
  if (kind === 'production') {
    if (!PRODUCTION_STOPS.has(run.status)) return null;
    // An autonomous run waiting on this production reports the stop itself.
    if (project?.autonomousRun?.output?.productionRunId === run.id) return null;
    return {
      key: `production:${run.id}:${run.status}`,
      title: 'Music video production stopped',
      description: `"${name}" production ${STOP_LABEL[run.status]}${run.stopReason || run.error ? `: ${String(run.stopReason || run.error).slice(0, 200)}` : ''}`,
      priority: 'high',
      link: `${base}/produce`,
      metadata: { projectId, runId: run.id, status: run.status, source: 'production' },
    };
  }
  if (kind === 'auto-review') {
    if (!AUTO_REVIEW_STOPS.has(run.status) || run.productionRunId) return null;
    return {
      key: `auto-review:${run.id}:${run.status}`,
      title: 'Music video auto-review stopped',
      description: `"${name}" auto-review ${STOP_LABEL[run.status]}${run.stopReason ? `: ${String(run.stopReason).slice(0, 200)}` : ''}`,
      priority: 'high',
      link: `${base}/review`,
      metadata: { projectId, runId: run.id, status: run.status, source: 'auto-review' },
    };
  }
  return null;
}

async function raise(kind, event) {
  const note = attentionNotificationFor(kind, event);
  if (!note || !firstTime(note.key)) return;
  const { addNotification, NOTIFICATION_TYPES } = await import('../notifications.js');
  const { key: _key, ...fields } = note;
  await addNotification({ type: NOTIFICATION_TYPES.MUSIC_VIDEO_ATTENTION, ...fields });
}

let started = false;

/** Subscribe once. Idempotent. */
export function initMusicVideoAttentionNotifier() {
  if (started) return;
  started = true;
  for (const kind of ['autonomous', 'production', 'auto-review']) {
    musicVideoEvents.on(kind, (event) => {
      raise(kind, event).catch((err) => console.error(`❌ Music video notification failed: ${err.message}`));
    });
  }
}

export function __resetAttentionNotifierForTests() {
  raised.clear();
}
