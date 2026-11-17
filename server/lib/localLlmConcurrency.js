// Per-endpoint cap and in-flight slot tracking for concurrent local-LLM work.
//
// `LOCAL_LLM_MAX_CONCURRENCY` plus the per-endpoint local-LLM slot gate (`acquireLocalSlot`,
// `releaseLocalSlot`), in-flight activity predicate (`isLocalEndpointBusy`), scheme-optional port
// match (`localEndpointsSharePort`), and settle observer (`onLocalEndpointSettled`) — a
// dependency-light leaf so `cosLocalEndpointSlots.js` and `managedDaemon.js` avoid importing
// `promptRunner.js`.
//
// Own dependency-light leaf so CoS slot accounting and the managed-daemon idle reaper can read it
// without loading the prompt runner's import graph.
import { isLoopbackEndpoint } from './localEndpoint.js';

export const LOCAL_LLM_MAX_CONCURRENCY = Math.max(1, Number(process.env.LOCAL_LLM_MAX_CONCURRENCY) || 1);

const localEndpointGates = new Map(); // endpoint -> { active: number, queue: (()=>void)[] }
const settledListeners = new Set();

function endpointPortKey(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.trim()) return null;
  const trimmed = endpoint.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (!URL.canParse(candidate)) return null;
  const url = new URL(candidate);
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

function notifyEndpointActivity(endpoint) {
  for (const listener of settledListeners) {
    try {
      listener(endpoint);
    } catch {
      // Best-effort observer notification.
    }
  }
}

export function acquireLocalSlot(endpoint, signal = null) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  let gate = localEndpointGates.get(endpoint);
  if (!gate) {
    gate = { active: 0, queue: [] };
    localEndpointGates.set(endpoint, gate);
  }
  if (gate.active < LOCAL_LLM_MAX_CONCURRENCY) {
    gate.active += 1;
    notifyEndpointActivity(endpoint);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const index = gate.queue.indexOf(onReady);
      if (index !== -1) gate.queue.splice(index, 1);
      reject(signal.reason);
      notifyEndpointActivity(endpoint);
    };
    const onReady = () => {
      signal?.removeEventListener('abort', onAbort);
      notifyEndpointActivity(endpoint);
      resolve();
    };
    gate.queue.push(onReady);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function releaseLocalSlot(endpoint) {
  const gate = localEndpointGates.get(endpoint);
  if (!gate) return;
  const next = gate.queue.shift();
  if (next) next(); // hand the slot straight to the next waiter (active unchanged)
  else gate.active = Math.max(0, gate.active - 1);
  notifyEndpointActivity(endpoint);
}

/**
 * True when any local-LLM run is currently in flight (or queued) against
 * `endpoint` or another endpoint string sharing its port. Scheme-less
 * (`localhost:8010/v1`) and absolute (`http://127.0.0.1:8010/v1`) forms match.
 */
export function isLocalEndpointBusy(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.trim()) return false;
  const targetPort = endpointPortKey(endpoint);
  for (const [key, gate] of localEndpointGates) {
    if (!gate || (gate.active <= 0 && gate.queue.length === 0)) continue;
    if (key === endpoint) return true;
    if (targetPort && endpointPortKey(key) === targetPort) return true;
  }
  return false;
}

/** True when both endpoint strings parse to the same port, scheme optional. */
export function localEndpointsSharePort(left, right) {
  const leftPort = endpointPortKey(left);
  return Boolean(leftPort) && leftPort === endpointPortKey(right);
}

/** Drop slot gates. Test isolation only — production state is the live process. */
export function _resetLocalLlmSlotsForTests() {
  localEndpointGates.clear();
}

/**
 * Register a listener invoked when a local endpoint slot is acquired or
 * released, so a managed daemon's idle clock refreshes both on dispatch and
 * when a long-running inference finishes.
 */
export function onLocalEndpointSettled(listener) {
  if (typeof listener !== 'function') return () => {};
  settledListeners.add(listener);
  return () => settledListeners.delete(listener);
}

/** Share the per-endpoint FIFO budget across streamed runs and bounded completions.
 * Cancellation removes a queued waiter without taking or leaking a slot.
 */
export async function withLocalConcurrencyGate(provider, fn, { signal = null } = {}) {
  const endpoint = provider?.endpoint;
  const isLocalProvider = provider?.type === 'api' || provider?.type === 'tui';
  if (!(isLocalProvider && isLoopbackEndpoint(endpoint))) return fn();
  await acquireLocalSlot(endpoint, signal);
  try {
    signal?.throwIfAborted();
    return await fn();
  } finally {
    releaseLocalSlot(endpoint);
  }
}
