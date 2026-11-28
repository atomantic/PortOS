/**
 * Voice Call timing debug: a persisted toggle plus a stream of timestamped stage lines for the Transmission log.
 *
 * Client marks time each stage from the client turn start (mic stop or text send); server lines
 * (`voice:timing`) carry the server's own elapsed time since it began the turn. Every line is
 * stamped with the browser's arrival time, so the gap between "audio.sent" and the server's
 * "turn.start" shows upload time. The server keeps per-socket state, so the toggle is re-sent on
 * every (re)connect.
 */

import socket from './socket';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage';

const STORAGE_KEY = 'portos.voice.timingDebug';

let enabled = safeReadStorage(STORAGE_KEY) === '1';
let clientTurnStart = null;
const listeners = new Set();
const toggleListeners = new Set();

const syncServer = () => socket.emit('voice:debug:timing', { enabled });

const publish = (entry) => {
  for (const fn of listeners) fn(entry);
};

// Socket listeners attach on first use, so voice modules that only call markVoiceTiming
// stay free of socket side effects while the debug is off.
let wired = false;
const wire = () => {
  if (wired) return;
  wired = true;
  socket.on('connect', () => {
    if (enabled) syncServer();
  });
  socket.on('voice:timing', (data) => {
    if (!enabled || typeof data?.label !== 'string') return;
    publish({ at: Date.now(), source: 'server', label: data.label, ms: Number.isFinite(data.ms) ? data.ms : null, turnId: data.turnId });
  });
};
if (enabled) {
  wire();
  if (socket.connected) syncServer();
}

export const isVoiceTimingDebug = () => enabled;

export const setVoiceTimingDebug = (next) => {
  enabled = next === true;
  wire();
  safeWriteStorage(STORAGE_KEY, enabled ? '1' : '0');
  syncServer();
  for (const fn of toggleListeners) fn(enabled);
};

export const onVoiceTimingDebugChange = (handler) => {
  toggleListeners.add(handler);
  return () => toggleListeners.delete(handler);
};

/** Subscribe to timing lines `{ at, source: 'client'|'server', label, ms, turnId? }`. */
export const onVoiceTiming = (handler) => {
  wire();
  listeners.add(handler);
  return () => listeners.delete(handler);
};

/** Mark a client-side stage; `startsTurn` resets the client clock so later marks read from it. */
export const markVoiceTiming = (label, { startsTurn = false } = {}) => {
  if (!enabled) return;
  const at = Date.now();
  if (startsTurn || clientTurnStart === null) clientTurnStart = at;
  publish({ at, source: 'client', label, ms: at - clientTurnStart });
};
