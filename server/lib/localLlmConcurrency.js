// Per-endpoint cap and in-flight slot tracking for concurrent local-LLM work.
// Own dependency-free leaf so CoS slot accounting and the managed-daemon idle
// reaper can read it without loading the prompt runner's import graph.
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

export function acquireLocalSlot(endpoint) {
  let gate = localEndpointGates.get(endpoint);
  if (!gate) {
    gate = { active: 0, queue: [] };
    localEndpointGates.set(endpoint, gate);
  }
  notifyEndpointActivity(endpoint);
  if (gate.active < LOCAL_LLM_MAX_CONCURRENCY) {
    gate.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    gate.queue.push(() => {
      notifyEndpointActivity(endpoint);
      resolve();
    });
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
 * `endpoint` or a loopback alias sharing its port.
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

