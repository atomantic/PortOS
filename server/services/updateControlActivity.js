// Keep a control directory while this server is still consuming its logs.
import { createMutex } from '../lib/asyncMutex.js';

export const withUpdateControlLock = createMutex();
const tracked = new Set();

export function trackUpdateControl(path) {
  tracked.add(path);
  return () => tracked.delete(path);
}

export const isUpdateControlTracked = path => tracked.has(path);
