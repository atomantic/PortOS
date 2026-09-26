import { browserEvents, getFullStatus } from './browserService.js';

// CDP, PM2 and completed downloads can change outside PortOS without callbacks.
// Only mounted Browser consumers pay for this shared, read-only observation.
export const BROWSER_OBSERVE_MS = 5000;
const subscribers = new Set();
let snapshot = null;
let sampledAt = 0;
let failure = null;
let pending = null;
let revision = 0;
let timer = null;
let generation = 0;
let observing = false;

function notify() {
  for (const socket of subscribers) {
    if (socket.connected) socket.emit('browser:changed', {});
  }
}

export async function getBrowserStatusSnapshot({ fresh = false } = {}) {
  if (pending) return pending;
  if (!fresh && (snapshot || failure) && Date.now() - sampledAt < BROWSER_OBSERVE_MS) {
    if (failure) throw failure;
    return snapshot;
  }
  pending = (async () => {
    let next;
    while (true) {
      const started = revision;
      const startedGeneration = generation;
      let readError;
      next = await getFullStatus({ strict: true }).catch(err => { readError = err; });
      // Retry a superseded read (including failures) while a viewer needs it.
      // Last unsubscribe prevents even a queued retry from keeping work alive.
      if ((started !== revision || startedGeneration !== generation) && subscribers.size) continue;
      if (readError) throw readError;
      if (started !== revision) return next;
      break;
    }
    const changed = failure || JSON.stringify(next) !== JSON.stringify(snapshot);
    snapshot = next;
    failure = null;
    sampledAt = Date.now();
    if (changed) notify();
    return snapshot;
  })().catch(err => {
    const changed = !failure || failure.message !== err.message;
    failure = err;
    sampledAt = Date.now();
    if (changed) notify();
    throw err;
  }).finally(() => { pending = null; });
  return pending;
}

function schedule() {
  if (!subscribers.size || timer) return;
  timer = setTimeout(() => {
    timer = null;
    observe();
  }, BROWSER_OBSERVE_MS);
  timer.unref?.();
}

function observe() {
  if (observing || !subscribers.size) return;
  observing = true;
  const started = generation;
  getBrowserStatusSnapshot({ fresh: true }).catch(() => {
    // The cache exposes the failure to HTTP consumers without replacing data.
  }).finally(() => {
    observing = false;
    if (started !== generation && subscribers.size) observe();
    else schedule();
  });
}

function invalidate() {
  revision += 1;
  sampledAt = -Infinity;
  if (!subscribers.size) return;
  clearTimeout(timer);
  timer = null;
  observe();
}

for (const event of ['config:changed', 'status:changed', 'pages:changed', 'downloads:changed']) {
  browserEvents.on(event, invalidate);
}

export function registerBrowserStatusSocket(socket) {
  const release = () => {
    if (!subscribers.delete(socket) || subscribers.size) return;
    generation += 1;
    clearTimeout(timer);
    timer = null;
  };
  socket.on('browser:subscribe', () => {
    const first = !subscribers.size;
    subscribers.add(socket);
    if (first) observe();
  });
  socket.on('browser:unsubscribe', release);
  socket.on('disconnect', release);
}
