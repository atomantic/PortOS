/**
 * Coalesced invalidation for the shared system-activity snapshot.
 *
 * Lifecycle transitions call `noteSystemActivity(source, phase)`. Bursts inside
 * one short window collapse to a single `system:activity` frame. The frame is
 * an invalidation — sequence, source, phase — never the snapshot and never
 * record content. Clients perform one bounded read of `getSystemActivity()`,
 * and a failed read stays unknown rather than idle.
 *
 * GPU/CPU samples have no lifecycle event. They stay on a separate telemetry
 * read that the live-activity inspector polls only while it is visible.
 */

const ACTIVITY_SOURCES = new Set([
  'agents', 'media', 'imageTo3d', 'llm', 'mind', 'appOperations', 'backup', 'update',
]);

export const SYSTEM_ACTIVITY_COALESCE_MS = 50;

let io = null;
let seq = 0;
let timer = null;
let pending = null;
const notes = [];
let armed = false;
let previousMind = null;
const unsubs = [];

export function bindSystemActivityIo(next) {
  io = next || null;
}

export function noteSystemActivity(source, phase) {
  if (!ACTIVITY_SOURCES.has(source) || typeof phase !== 'string' || !phase) return;
  notes.push({ source, phase });
  pending = { source, phase };
  if (timer) return;
  timer = setTimeout(flushSystemActivity, SYSTEM_ACTIVITY_COALESCE_MS);
  timer.unref?.();
}

export function flushSystemActivity() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const note = pending;
  pending = null;
  if (!note || !io || typeof io.emit !== 'function') return;
  seq += 1;
  try {
    io.emit('system:activity', { seq, source: note.source, phase: note.phase });
  } catch (err) {
    console.error(`❌ system activity notify failed: ${err.message}`);
  }
}

/** Every note since the last drain, including ones still waiting to coalesce. */
export function drainActivityNotesForTests() {
  return notes.splice(0);
}

export function resetSystemActivityNotifyForTests() {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = null;
  notes.length = 0;
  seq = 0;
  io = null;
  previousMind = null;
  for (const off of unsubs.splice(0)) off();
  armed = false;
}

function listen(emitter, event, handler) {
  emitter.on(event, handler);
  unsubs.push(() => emitter.off(event, handler));
}

export function mindActivityPhases(previous, next) {
  if (!next || typeof next !== 'object') return [];
  const thinking = Boolean(next.activeTurnId);
  const wasThinking = Boolean(previous?.activeTurnId);
  const queued = Number(next.queuedMessageCount) || 0;
  const wasQueued = Number(previous?.queuedMessageCount) || 0;
  const failed = (Number(next.failureCount) || 0) > (Number(previous?.failureCount) || 0);
  const phases = [];
  if (!wasThinking && thinking) phases.push('start');
  else if (wasThinking && !thinking) {
    if (next.status === 'paused') phases.push('cancellation');
    else if (failed || next.status === 'degraded' || next.status === 'interrupted') phases.push('failure');
    else phases.push('completion');
  }
  if (queued > wasQueued) phases.push('queued');
  else if (wasQueued > 0 && queued < wasQueued) phases.push('drained');
  return phases;
}

export function agentCompletionPhase(agent) {
  if (agent?.result?.success === true) return 'completion';
  const error = typeof agent?.result?.error === 'string' ? agent.result.error : '';
  if (/terminat|kill|cancel/i.test(error)) return 'cancellation';
  return 'failure';
}

export function taskQueuePhase(change) {
  const action = change?.action;
  if (action === 'added' || action === 'unblocked' || action === 'requeued' || action === 'approved') return 'queued';
  if (action === 'deleted') return 'drained';
  if (change?.previousStatus === 'pending' && change?.task?.status && change.task.status !== 'pending') return 'drained';
  return null;
}

const MEDIA_PHASE = {
  enqueued: 'queued',
  started: 'start',
  completed: 'completion',
  failed: 'failure',
  canceled: 'cancellation',
};

const MEDIA_TERMINAL = new Set(['completion', 'failure', 'cancellation']);
const LIVE_MEDIA = new Set(['queued', 'running']);

/**
 * Wrap the host's runner hooks so every LLM lifecycle edge invalidates the
 * snapshot. Notes first: a throwing usage/error hook must not swallow the
 * invalidation. Cancellation is its own hook because a Stop does not fire
 * `onRunFailed`.
 */
export function attachLlmActivityHooks(hooks = {}) {
  return {
    ...hooks,
    onRunStarted: (metadata) => {
      noteSystemActivity('llm', 'start');
      return hooks.onRunStarted?.(metadata);
    },
    onRunCompleted: (metadata, output) => {
      noteSystemActivity('llm', 'completion');
      return hooks.onRunCompleted?.(metadata, output);
    },
    onRunFailed: (metadata, error) => {
      noteSystemActivity('llm', 'failure');
      return hooks.onRunFailed?.(metadata, error);
    },
    onRunCanceled: (metadata) => {
      noteSystemActivity('llm', 'cancellation');
      return hooks.onRunCanceled?.(metadata);
    },
  };
}

export async function armSystemActivityWatchers() {
  if (armed) return;
  armed = true;
  let mediaJobEvents;
  let listJobs;
  let cosEvents;
  try {
    ({ mediaJobEvents, listJobs } = await import('./mediaJobQueue/index.js'));
    ({ cosEvents } = await import('./cosEvents.js'));
  } catch (err) {
    armed = false;
    throw err;
  }

  for (const [event, phase] of Object.entries(MEDIA_PHASE)) {
    listen(mediaJobEvents, event, () => {
      noteSystemActivity('media', phase);
      if (!MEDIA_TERMINAL.has(phase)) return;
      let live = true;
      try {
        live = listJobs().some((job) => LIVE_MEDIA.has(job?.status));
      } catch (err) {
        console.error(`❌ media activity drain check failed: ${err.message}`);
        return;
      }
      if (!live) noteSystemActivity('media', 'drained');
    });
  }

  listen(cosEvents, 'agent:spawned', () => noteSystemActivity('agents', 'start'));
  listen(cosEvents, 'agent:terminate', () => noteSystemActivity('agents', 'cancellation'));
  listen(cosEvents, 'agent:completed', (agent) => noteSystemActivity('agents', agentCompletionPhase(agent)));
  listen(cosEvents, 'tasks:changed', (change) => {
    const phase = taskQueuePhase(change);
    if (phase) noteSystemActivity('agents', phase);
  });
  listen(cosEvents, 'persistent-mind:status', (status) => {
    const phases = mindActivityPhases(previousMind, status);
    previousMind = status && typeof status === 'object' ? status : previousMind;
    for (const phase of phases) noteSystemActivity('mind', phase);
  });
}
