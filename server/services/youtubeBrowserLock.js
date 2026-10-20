/**
 * One lease on the managed browser's YouTube tab. History sync and playlist
 * sync both resolve to the same CDP page (findOrOpenPage matches by hostname),
 * so a navigation by one tears down the other's extraction. Each job wraps its
 * whole run in withYoutubeTab so the two take turns; their own single-flight
 * guards stay in place.
 */
import { createMutex } from '../lib/asyncMutex.js';

const withLock = createMutex();

export const withYoutubeTab = (fn) => withLock(fn);
