/**
 * How many music-video renders this process is running right now — final
 * renders, draft excerpts and single-shot renders. They run their own ffmpeg
 * and browsers rather than through the media job queue, so the system idle
 * verdict (lib/systemIdle.js) and the update preflight read them here; without
 * this, the unattended updater restarted the server through a final render.
 *
 * A leaf on purpose: each render module keeps its in-flight slots in a map made
 * here, so reading the count never imports the render code (a module that never
 * loaded has nothing running), and a slot opening or closing invalidates the
 * shared activity snapshot like any other lifecycle edge.
 */

import { noteSystemActivity } from '../systemActivityNotify.js';

const maps = new Map();

/**
 * A Map of one kind's in-flight render slots that counts toward system activity
 * and notes each slot opening and closing.
 */
export function trackedRenderMap(kind) {
  const map = new Map();
  const set = map.set.bind(map);
  const remove = map.delete.bind(map);
  map.set = (key, value) => {
    const opened = !map.has(key);
    set(key, value);
    if (opened) noteSystemActivity('musicVideo', 'start');
    return map;
  };
  map.delete = (key) => {
    const closed = remove(key);
    if (closed) noteSystemActivity('musicVideo', map.size || countActiveMusicVideoRenders() ? 'completion' : 'drained');
    return closed;
  };
  maps.set(kind, map);
  return map;
}

/** Total music-video renders in flight in this process. */
export function countActiveMusicVideoRenders() {
  let total = 0;
  for (const map of maps.values()) total += map.size;
  return total;
}
