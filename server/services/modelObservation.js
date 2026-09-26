/**
 * Demand-driven samples shared by HTTP readers and socket viewers. Readers
 * inspect external state only: subscribing never loads a model or runs AI.
 * No sample payload goes over the socket; existing authenticated routes retain
 * their projections and failure semantics.
 */
const resources = new Map();
const groups = new Map();
const signature = value => JSON.stringify(value, (key, item) =>
  ['timestamp', 'checkedAt', 'responseTime', 'latencyMs'].includes(key) ? undefined : item);

export function observeModelResource(namespace, probe, intervalMs = 20_000) {
  const subscribers = groups.get(namespace) ?? new Set();
  groups.set(namespace, subscribers);
  let pending = null;
  let sample = null;
  let sampled = false;
  let revision = 0;
  let timer = null;
  let lastSignature;
  let sampledAt = 0;

  const notify = () => {
    for (const socket of subscribers) {
      if (!socket.connected) continue;
      socket.emit(`${namespace}:changed`, {});
    }
  };
  const schedule = () => {
    if (!subscribers.size || timer) return;
    timer = setTimeout(() => {
      timer = null;
      read({ fresh: true }).catch(() => {});
    }, intervalMs);
    timer.unref?.();
  };
  const read = ({ fresh = false } = {}) => {
    if (pending) return pending;
    if (!fresh && subscribers.size && sampled && Date.now() - sampledAt < intervalMs) {
      return sample.error ? Promise.reject(sample.error) : Promise.resolve(sample.value);
    }
    pending = Promise.resolve().then(async () => {
      let result;
      let started;
      // A mutation fences both the cached sample and reads already in flight.
      // Every waiter gets the post-mutation sample, never the discarded result.
      do {
        started = revision;
        result = await Promise.resolve().then(() => probe({ fresh })).then(value => ({ value }), error => ({ error }));
      } while (started !== revision);
      const nextSignature = result.error ? 'probe-unavailable' : signature(result.value);
      sample = result;
      sampled = true;
      sampledAt = Date.now();
      if (nextSignature !== lastSignature) {
        lastSignature = nextSignature;
        notify();
      }
      if (result.error) throw result.error;
      return result.value;
    }).finally(() => {
      pending = null;
      schedule();
    });
    return pending;
  };
  const invalidate = () => {
    revision += 1;
    sampled = false;
    if (subscribers.size) read({ fresh: true }).catch(() => {});
  };
  const stop = () => {
    clearTimeout(timer);
    timer = null;
    sampled = false;
    lastSignature = undefined;
    // An in-flight read can drain, but cannot schedule without subscribers.
  };
  const resource = { read, invalidate, stop };
  resources.set(namespace, resource);
  if (subscribers.size) read().catch(() => {});
  return resource;
}

export function invalidateModelObservation(namespace) {
  resources.get(namespace)?.invalidate();
}

// Register only named resources, never arbitrary client-supplied probe targets.
export function registerModelObservationSocket(socket) {
  const register = namespace => {
    const subscribers = groups.get(namespace) ?? new Set();
    groups.set(namespace, subscribers);
    socket.on(`${namespace}:subscribe`, () => {
      subscribers.add(socket);
      resources.get(namespace)?.read().catch(() => {});
    });
    const release = () => {
      subscribers.delete(socket);
      if (!subscribers.size) resources.get(namespace)?.stop();
    };
    socket.on(`${namespace}:unsubscribe`, release);
    socket.on('disconnect', release);
  };
  register('loaded-models');
  register('voice-readiness');
  register('provider-readiness');
  register('provider-status');
  register('codex-account');
}

/** Mutations invalidate even on failure: an external action may partially apply. */
export function observeModelMutations(...namespaces) {
  return (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      res.once('finish', () => namespaces.forEach(invalidateModelObservation));
    }
    next();
  };
}

export function resetModelObservationsForTests() {
  for (const resource of resources.values()) resource.stop();
  resources.clear();
  groups.clear();
}
