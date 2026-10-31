import { useEffect, useSyncExternalStore } from 'react';
import socket from '../services/socket';
import { getMediaUsages } from '../services/api';

// One shared usage map for every mounted card and viewer: fetched when the
// first consumer mounts (each visit to a media page), on reconnect, and after
// a delete or swap through refreshMediaUsages().
const EMPTY = Object.freeze({});
let snapshot = EMPTY;
let consumers = 0;
let inflight = null;
let stale = false;
const listeners = new Set();

const publish = (next) => {
  snapshot = next && typeof next === 'object' ? next : EMPTY;
  for (const listener of listeners) listener();
};

/** Refetch the usage map; a call while one is in flight runs once more after it. */
export function refreshMediaUsages() {
  if (inflight) {
    stale = true;
    return inflight;
  }
  inflight = Promise.resolve()
    .then(() => getMediaUsages({ silent: true }))
    .then((data) => publish(data?.items))
    .catch(() => {})
    .finally(() => {
      inflight = null;
      if (stale) {
        stale = false;
        refreshMediaUsages();
      }
    });
  return inflight;
}

const onConnect = () => { void refreshMediaUsages(); };

function retain() {
  consumers += 1;
  if (consumers > 1) return;
  socket.on('connect', onConnect);
  void refreshMediaUsages();
}

function release() {
  consumers -= 1;
  if (consumers > 0) return;
  socket.off('connect', onConnect);
}

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = () => snapshot;

/** `{ '<kind>:<ref>': [{ source, label, id, title, role, href }] }`: the records using each media file. */
export function useMediaUsages() {
  useEffect(() => {
    retain();
    return release;
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot);
}
