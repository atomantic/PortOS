import { instanceEvents } from '../services/instanceEvents.js';

// Remote guest capabilities have no push channel. Share one probe loop across
// all visible travel panels; never start the runtime or call an AI provider.
const subscribers = new Set();
let timer = null;
let generation = 0;
let pending = null;
let dirty = false;
let fingerprint = null;

function refresh() {
  if (!subscribers.size) return;
  if (pending) {
    dirty = true;
    return;
  }
  const current = generation;
  dirty = false;
  pending = import('../services/eidoverseTravel.js')
    .then(({ listEidoverseDestinations }) => listEidoverseDestinations())
    // Only an explicit capability loss clears valid destinations. Transient
    // probe failures preserve the last snapshot without exposing error details.
    .catch(error => error?.code === 'EIDOVERSE_TRAVEL_UNAVAILABLE' ? { destinations: [] } : null)
    .then(snapshot => {
      if (snapshot === null || current !== generation || !subscribers.size || dirty) return;
      const next = JSON.stringify(snapshot);
      if (next === fingerprint) return;
      fingerprint = next;
      for (const socket of subscribers) socket.emit('eidoverse-travel:destinations', snapshot);
    })
    .finally(() => {
      pending = null;
      if (dirty && subscribers.size) refresh();
    });
}

function remove(socket) {
  if (!subscribers.delete(socket) || subscribers.size) return;
  clearInterval(timer);
  timer = null;
  generation += 1;
  fingerprint = null;
  dirty = false;
  instanceEvents.off('peers:updated', refresh);
}

/** Registered after the shared socket auth gate; never available to peer relays. */
export function registerEidoverseTravelHandlers(socket) {
  socket.on('eidoverse-travel:subscribe', () => {
    if (subscribers.has(socket)) return;
    subscribers.add(socket);
    if (subscribers.size === 1) {
      generation += 1;
      // HTTP owns initial/reconnect reads. Only the ongoing external probe is
      // shared here, so subscribing does not double the initial peer fan-out.
      timer = setInterval(refresh, 30_000);
      timer.unref?.();
      instanceEvents.on('peers:updated', refresh);
    }
  });
  socket.on('eidoverse-travel:unsubscribe', () => remove(socket));
  socket.on('disconnect', () => remove(socket));
}
