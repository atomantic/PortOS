/** Boot-only subscriptions; notification producers need no media execution graph. */
import { noteSystemActivity, mindActivityPhases, agentCompletionPhase, taskQueuePhase } from './systemActivityNotify.js';

let registration = null;

const MEDIA_PHASE = {
  enqueued: 'queued',
  started: 'start',
  completed: 'completion',
  failed: 'failure',
  canceled: 'cancellation',
};

const MEDIA_TERMINAL = new Set(['completion', 'failure', 'cancellation']);
const LIVE_MEDIA = new Set(['queued', 'running']);

/** Repeated callers share one registration and its idempotent teardown. */
export function armSystemActivityWatchers() {
  registration ??= attachWatchers().catch((error) => {
    registration = null;
    throw error;
  });
  return registration;
}

async function attachWatchers() {
  const { mediaJobEvents, listJobs } = await import('./mediaJobQueue/index.js');
  const { cosEvents } = await import('./cosEvents.js');
  let previousMind = null;
  const unsubs = [];
  const listen = (emitter, event, handler) => {
    emitter.on(event, handler);
    unsubs.push(() => emitter.off(event, handler));
  };

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
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    for (const off of unsubs.splice(0)) off();
    registration = null;
  };
}
