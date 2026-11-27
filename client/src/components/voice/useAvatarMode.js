import { useSyncExternalStore } from 'react';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';

const KEY = 'portos.voice.generativeAvatar';
const listeners = new Set();
let selected = safeReadStorage(KEY) !== 'off';
const getMode = () => selected;
const subscribe = callback => {
  listeners.add(callback);
  return () => listeners.delete(callback);
};

export function setAvatarMode(enabled) {
  selected = enabled;
  safeWriteStorage(KEY, enabled ? 'on' : 'off');
  for (const notify of listeners) notify();
}

export const useAvatarMode = () => useSyncExternalStore(subscribe, getMode);
