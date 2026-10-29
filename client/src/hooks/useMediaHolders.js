import { useEffect, useSyncExternalStore } from 'react';
import socket from '../services/socket';
import { getMediaHolders } from '../services/api';

// One shared holders map for every mounted card: the first consumer fetches it
// and listens for `media:holders:changed` (and reconnects), the last one stops.
const EMPTY = Object.freeze({ self: null, items: {}, byCardKey: {} });
let snapshot = EMPTY;
let consumers = 0;
let inflight = null;
let stale = false;
const listeners = new Set();

const publish = (next) => {
  snapshot = next;
  for (const listener of listeners) listener();
};

// The server keys entries by file; cards look them up by their own key.
function indexed(data) {
  if (!data || typeof data.items !== 'object' || !data.items) return EMPTY;
  const byCardKey = {};
  for (const entry of Object.values(data.items)) {
    for (const key of Array.isArray(entry?.cardKeys) ? entry.cardKeys : []) byCardKey[key] = entry;
  }
  return { self: data.self ?? null, items: data.items, byCardKey };
}

/** Refetch the holders map; a call while one is in flight runs once more after it. */
export function refreshMediaHolders() {
  if (inflight) {
    stale = true;
    return inflight;
  }
  inflight = Promise.resolve()
    .then(() => getMediaHolders({ silent: true }))
    .then((data) => publish(indexed(data)))
    .catch(() => {})
    .finally(() => {
      inflight = null;
      if (stale) {
        stale = false;
        refreshMediaHolders();
      }
    });
  return inflight;
}

const onChanged = () => { void refreshMediaHolders(); };

function retain() {
  consumers += 1;
  if (consumers > 1) return;
  socket.on('media:holders:changed', onChanged);
  socket.on('connect', onChanged);
  void refreshMediaHolders();
}

function release() {
  consumers -= 1;
  if (consumers > 0) return;
  socket.off('media:holders:changed', onChanged);
  socket.off('connect', onChanged);
}

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = () => snapshot;

/** `{ self, items, byCardKey }`: the machines holding each media file other machines also hold. */
export function useMediaHolders() {
  useEffect(() => {
    retain();
    return release;
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot);
}

