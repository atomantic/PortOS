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

// A task label is one topical phrase, not a sentence or two — a much tighter
// budget than a free-form error/notification line. Keeps the spoken title from
// running past the topic into the prompt body even after scaffolding is stripped.
const TASK_LABEL_CLIP_LEN = 90;

const clip = (text, max = SPEECH_CLIP_LEN) => {
  const s = (text || '').toString().trim().replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// Reduce a task to a short, topical spoken label. A CoS task's `description` is
// the raw agent prompt — for a swarm/claim run it leads with the `# ⚡ SWARM
// MODE — …` block, and the concrete claim/plan prompts open their first line
// with a `[Claim Issue: App]` tag. Reading that verbatim makes the voice agent
// recite prompt scaffolding ("SWARM MODE — claim and ship up to 3 independent
// issues in parallel. This run operates in slashdo …") instead of naming the
// topic. This helper strips that scaffolding down to the underlying topic.
//
// `cleanTaskTopicLine` peels, in order: a leading markdown heading (`# `), a
// leading run of emoji / symbol characters (the swarm block opens with `⚡`), a
// leading `[Tag: App]` bracket label, `**bold**` markers, and the `SWARM MODE —`
// label — so `# ⚡ SWARM MODE — claim and ship up to 3 …` reads as "claim and
// ship up to 3 …" and `[Claim Issue: PortOS] Claim and ship the next open GitHub
// issue` reads as "Claim and ship the next open GitHub issue".
const cleanTaskTopicLine = (line) => {
  let s = (line || '').toString().trim();
  s = s.replace(/^#+\s*/, '');                    // markdown heading marker
  s = s.replace(/^[^\p{L}\p{N}[]+/u, '');          // leading emoji / symbol run
  s = s.replace(/^\[[^\]]*\]\s*/, '');             // [Claim Issue: App] tag
  s = s.replace(/\*\*/g, '');                      // bold emphasis markers
  s = s.replace(/^SWARM MODE\s*[—–-]\s*/i, '');    // swarm block label
  return s.replace(/\s+/g, ' ').trim();
};

// A short topical label for a task, preferring an explicit title / post-run
// agent summary (a completed task speaks what it actually did) and otherwise
// deriving one from the first meaningful, de-scaffolded line of the description.
export const deriveTaskSpeechLabel = (task) => {
  if (!task) return '';
  const explicit = task.title || task.metadata?.taskSummary;
  if (explicit && explicit.toString().trim()) return clip(explicit, TASK_LABEL_CLIP_LEN);
  for (const raw of (task.description || '').toString().split('\n')) {
    const cleaned = cleanTaskTopicLine(raw);
    if (cleaned) return clip(cleaned, TASK_LABEL_CLIP_LEN);
  }
  return '';
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
  const label = deriveTaskSpeechLabel(task);
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
// user reviews the PR visually. Speaks a short topical label (via
// deriveTaskSpeechLabel) rather than the raw prompt, so a swarm/claim task
// announces its topic instead of reciting the "# ⚡ SWARM MODE — …" block.
export const formatTaskCompletionLine = (task) => {
  if (!task) return '';
  const label = deriveTaskSpeechLabel(task);
  const success = task.status === 'completed';
  if (!label) {
    return success
      ? 'Your coding task is done.'
      : "Heads up — a coding task you dispatched didn't finish cleanly.";
  }
  return success
    ? `Your coding task is done: ${label}.`
    : `Heads up — the coding task "${label}" didn't finish cleanly.`;
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

  // Terminal outcomes already announced, keyed `${taskId}:${status}`. A task's
  // completion line is solicited and fires once at its terminal status, but
  // `updateTask` on an already-terminal voice-dispatched task re-emits
  // `tasks:changed action:'updated'` with the same status — without this guard
  // the spoken line would re-fire on every such re-update. Keying on id+status
  // (not id alone) keeps a DISTINCT outcome announceable: a blocked task later
  // re-dispatched to completed still speaks its success line. The key is
  // RESERVED synchronously (so a same-tick / in-flight duplicate dedups) but
  // rolled BACK if no line actually went out — config-disabled, quiet-hours,
  // voice-disabled, or a TTS failure — mirroring `dispatch`'s rate-limit slot,
  // so a later legitimate re-update can still announce. Grows only with distinct
  // voice-dispatched task outcomes (human-paced, rare), so no eviction is
  // needed; cleared on unwire.
  const announcedOutcomes = new Set();

  // Speak one line, advancing the source's rate-limit bucket. The slot is
  // reserved BEFORE awaiting `speak`: synthesis is async, so a same-tick burst
  // of same-source events (an error storm) would otherwise all read the stale
  // timestamp, pass the gate, and start concurrent syntheses — defeating the
  // per-source limit exactly when it matters. The reservation stands on a line
  // that goes out; on suppression/failure/throw we roll it back (unless a later
  // event already claimed the slot) so the budget isn't spent on a non-line.
  // try/finally only — a synthesis rejection still propagates to the caller's
  // catch. Returns whether a line actually went out, so callers with their own
  // once-guards (task-complete) can roll those back on suppression too.
  const dispatch = async (source, text, priority, { solicited = false } = {}) => {
    if (!text) return false;
    const now = Date.now();
    if (!allowBySource(source, lastSpokenAt.get(source), now, limits)) return false;
    const previous = lastSpokenAt.get(source) ?? null;
    lastSpokenAt.set(source, now);
    let ok = false;
    try {
      const result = await speak({ io, text, priority, source, solicited });
      ok = !!result?.ok;
    } finally {
      if (!ok && lastSpokenAt.get(source) === now) lastSpokenAt.set(source, previous);
    }
    return ok;
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
    // Reserve this terminal outcome synchronously (before queueing onto the
    // async tail) so a same-tick / in-flight duplicate dedups to one line. The
    // reservation is rolled back inside the tail if no line went out (config
    // off, quiet hours, voice off, TTS failure) so a later legitimate re-update
    // can still announce. A task without an id (shouldn't happen for real tasks)
    // fails open — better to re-announce than to silently swallow.
    const outcomeKey = task?.id != null ? `${task.id}:${status}` : null;
    if (outcomeKey) {
      if (announcedOutcomes.has(outcomeKey)) return;
      announcedOutcomes.add(outcomeKey);
    }
    taskCompleteTail = taskCompleteTail.then(async () => {
      let spoke = false;
      try {
        const cfg = await getVoiceConfig();
        if (cfg?.llm?.codeAgent?.announceOnComplete === false) return;
        const priority = status === 'completed' ? 'normal' : 'high';
        spoke = await dispatch('task-complete', formatTaskCompletionLine(task), priority, { solicited: true });
      } finally {
        if (!spoke && outcomeKey) announcedOutcomes.delete(outcomeKey);
      }
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
    announcedOutcomes.clear();
  };
};
