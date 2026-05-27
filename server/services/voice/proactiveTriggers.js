// Wire proactive CoS speech to real subsystem events.
//
// `speakProactive` (proactiveSpeech.js) is the delivery primitive — it knows
// how to suppress for quiet hours / disabled voice and push a line over the
// `voice:speak` socket event. This module decides WHEN the CoS speaks first,
// by subscribing to three live event sources and turning select events into
// spoken lines:
//
//   1. errorEvents 'error'        — only `severity: 'critical'` (the rest are
//                                    routine 4xx/5xx the user shouldn't hear).
//   2. cosEvents   'task:ready'   — a new task became spawnable.
//   3. notificationEvents 'added' — only high/critical priority notifications.
//
// Each source has its OWN rate-limit bucket so a burst from one source can't
// starve another, and a storm within a source can't talk over the user. The
// rate-limit is applied BEFORE `speakProactive` (so we skip the config read +
// synthesis cost on a throttled event) and the bucket only advances on a line
// that actually went out — a quiet-hours/disabled suppression doesn't consume
// the budget.
//
// EventEmitter does NOT await async listeners: a rejection from the synthesis
// path inside `speakProactive` would surface as an unhandled rejection
// (process-killing on Node ≥15). Listeners here stay synchronous and call the
// async `dispatch` fire-and-forget; the single `.catch` on that call site
// (`fire`) is the rejection boundary. `dispatch` itself uses only try/finally
// (to release a rate-limit reservation), so a synthesis rejection propagates
// out to that `.catch` rather than being swallowed.

import { errorEvents } from '../../lib/errorHandler.js';
import { cosEvents } from '../cosEvents.js';
import { notificationEvents } from '../notifications.js';
import { speakProactive as defaultSpeak } from './proactiveSpeech.js';
import { getVoiceConfig } from './config.js';

// Per-source minimum interval between spoken lines (ms). Tuned for an opt-in
// assistant: critical errors are rare so a wide spacing is fine; tasks and
// notifications can cluster, so a one-minute floor keeps them from chattering.
export const RATE_LIMIT_MS = {
  error: 90_000,
  'task:ready': 60_000,
  notification: 60_000,
  // NOTE: there is intentionally NO 'task-complete' entry. Completions of
  // voice-dispatched tasks are solicited (the user asked for each one), so a
  // drop-based throttle would silently lose the second of two tasks finishing
  // close together. Instead the wiring serializes completion lines onto a
  // queue (see taskCompleteTail) so they are spoken one after another without
  // dropping or overlapping.
};

// Spoken lines should be short — synthesis is capped at MAX_PROACTIVE_TEXT_LEN
// upstream, but for the ear a sentence or two is plenty. Trim long source text.
const SPEECH_CLIP_LEN = 240;

const clip = (text) => {
  const s = (text || '').toString().trim().replace(/\s+/g, ' ');
  return s.length > SPEECH_CLIP_LEN ? `${s.slice(0, SPEECH_CLIP_LEN - 1)}…` : s;
};

// Pure rate-limit predicate — given a source, its last-spoken timestamp, and
// "now", may it speak? Unknown sources have no limit. Exported for unit tests.
export const allowBySource = (source, lastSpokenAt, now, limits = RATE_LIMIT_MS) => {
  const limit = limits[source];
  if (!limit) return true;
  if (lastSpokenAt == null) return true;
  return now - lastSpokenAt >= limit;
};

// High-severity notification gate — only `high` / `critical` get spoken.
export const isHighPriorityNotification = (priority) =>
  priority === 'high' || priority === 'critical';

// --- Pure formatters: event payload → spoken line (or '' to skip) ---

export const formatErrorLine = (error) => {
  if (error?.severity !== 'critical') return '';
  const msg = clip(error.message);
  return msg ? `Heads up. A critical error just occurred. ${msg}` : '';
};

export const formatTaskLine = (task) => {
  const label = clip(task?.title || task?.description);
  return label ? `A new task is ready: ${label}.` : '';
};

export const formatNotificationLine = (notification) => {
  if (!isHighPriorityNotification(notification?.priority)) return '';
  const title = clip(notification?.title);
  if (!title) return '';
  const description = clip(notification?.description);
  return description ? `${title}. ${description}` : title;
};

// Truthy check mirroring isTruthyMeta — task metadata round-trips through
// TASKS.md, so `voiceDispatch: true` comes back as the STRING 'true'. Kept
// inline so this module stays decoupled from the agent-state helpers.
const isMetaTrue = (v) => v === true || v === 'true';

// Completion of a voice-dispatched coding task, keyed off the task's TERMINAL
// status (completed / blocked) rather than per-agent-attempt — so a task that
// retries doesn't announce on every attempt, and a user-cancelled task is
// suppressed by the caller. The PR URL is NOT spoken — it isn't created until
// cleanup runs after completion, and a GitHub URL is poor speech anyway; the
// user reviews the PR visually. Uses the first line of the description so a
// multi-line task spec doesn't get read out.
export const formatTaskCompletionLine = (task) => {
  if (!task) return '';
  const desc = clip((task.description || '').split('\n')[0]);
  const success = task.status === 'completed';
  if (!desc) {
    return success
      ? 'Your coding task is done.'
      : "Heads up — a coding task you dispatched didn't finish cleanly.";
  }
  return success
    ? `Your coding task is done: ${desc}.`
    : `Heads up — the coding task "${desc}" didn't finish cleanly.`;
};

/**
 * Subscribe proactive speech to live event sources.
 *
 * @param {object}   opts
 * @param {object}   opts.io     Socket.IO server (passed to speakProactive).
 * @param {Function} [opts.speak] Override the delivery primitive (tests).
 * @param {object}   [opts.limits] Override per-source rate limits (tests).
 * @returns {Function} unwire — removes the listeners (boot wires once; tests
 *                     and hot-reload use this to avoid double-wiring).
 */
export const wireProactiveTriggers = ({ io, speak = defaultSpeak, limits = RATE_LIMIT_MS } = {}) => {
  if (!io) {
    console.warn('🔕 voice: proactive triggers not wired (no io)');
    return () => {};
  }

  // Per-source last-spoken timestamps live in this closure so each wiring gets
  // isolated state and a rewire starts fresh.
  const lastSpokenAt = new Map();

  // Speak one line, advancing the source's rate-limit bucket. The slot is
  // reserved BEFORE awaiting `speak`: synthesis is async, so a same-tick burst
  // of same-source events (an error storm) would otherwise all read the stale
  // timestamp, pass the gate, and start concurrent syntheses — defeating the
  // per-source limit exactly when it matters. The reservation stands on a line
  // that goes out; on suppression/failure/throw we roll it back (unless a later
  // event already claimed the slot) so the budget isn't spent on a non-line.
  // try/finally only — a synthesis rejection still propagates to the caller's
  // catch.
  const dispatch = async (source, text, priority, { solicited = false } = {}) => {
    if (!text) return;
    const now = Date.now();
    if (!allowBySource(source, lastSpokenAt.get(source), now, limits)) return;
    const previous = lastSpokenAt.get(source) ?? null;
    lastSpokenAt.set(source, now);
    let ok = false;
    try {
      const result = await speak({ io, text, priority, source, solicited });
      ok = !!result?.ok;
    } finally {
      if (!ok && lastSpokenAt.get(source) === now) lastSpokenAt.set(source, previous);
    }
  };

  // EventEmitter doesn't await async listeners, so a rejected dispatch would
  // surface as a process-killing unhandled rejection. The synchronous listeners
  // call dispatch fire-and-forget with this single explicit catch as the error
  // boundary — never let a TTS failure escape.
  const fire = (source, text, priority) => {
    dispatch(source, text, priority).catch((err) =>
      console.error(`🔕 voice: proactive ${source} trigger failed: ${err?.message || err}`),
    );
  };

  const onError = (error) => fire('error', formatErrorLine(error), 'high');
  const onTaskReady = (task) => fire('task:ready', formatTaskLine(task), 'normal');
  const onNotification = (notification) => fire('notification', formatNotificationLine(notification), 'high');

  // Announce completion of a coding task the user dispatched by voice. Keyed
  // off the TERMINAL task status (tasks:changed → updated → completed/blocked)
  // rather than agent:completed, so a task that retries on a transient failure
  // announces once (at its terminal outcome), not on every attempt. Gated on
  // cheap synchronous checks first (action / terminal status / voiceDispatch)
  // before the config read. A user-cancelled task lands as blocked with
  // blockedCategory 'user-terminated' — suppress it (the user stopped it on
  // purpose; "didn't finish cleanly" would be wrong). Solicited: bypasses
  // proactive-enabled but not voice-disabled / quiet hours.
  //
  // Completions are SERIALIZED onto this tail promise rather than going
  // through the per-source rate limit: each completion is solicited, so a
  // drop-based throttle would silently lose the second of two tasks that
  // finish close together. Chaining makes two near-simultaneous completions
  // speak one after the other (no drop, no overlapping audio).
  let taskCompleteTail = Promise.resolve();
  const onTaskUpdated = (evt) => {
    if (evt?.action !== 'updated') return;
    const task = evt.task;
    const status = task?.status;
    if (status !== 'completed' && status !== 'blocked') return;
    if (!isMetaTrue(task.metadata?.voiceDispatch)) return;
    if (status === 'blocked' && task.metadata?.blockedCategory === 'user-terminated') return;
    taskCompleteTail = taskCompleteTail.then(async () => {
      const cfg = await getVoiceConfig();
      if (cfg?.llm?.codeAgent?.announceOnComplete === false) return;
      const priority = status === 'completed' ? 'normal' : 'high';
      await dispatch('task-complete', formatTaskCompletionLine(task), priority, { solicited: true });
    }).catch((err) =>
      console.error(`🔕 voice: proactive task-complete trigger failed: ${err?.message || err}`),
    );
  };

  errorEvents.on('error', onError);
  cosEvents.on('task:ready', onTaskReady);
  cosEvents.on('tasks:changed', onTaskUpdated);
  notificationEvents.on('added', onNotification);

  console.log('🔔 voice: proactive triggers wired (error/task:ready/tasks:changed/notification)');

  return () => {
    errorEvents.off('error', onError);
    cosEvents.off('task:ready', onTaskReady);
    cosEvents.off('tasks:changed', onTaskUpdated);
    notificationEvents.off('added', onNotification);
  };
};
