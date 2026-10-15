/**
 * Renders this process is running outside the media job queue: music-video
 * final renders, draft excerpts and single-shot renders, video timeline
 * renders, publishing-kit builds and Code Animation production runs. Each runs
 * its own ffmpeg, browsers or Blender, so the system idle verdict
 * (lib/systemIdle.js), the update preflight and Live activity read them here;
 * without this, the unattended updater restarted the server through a final
 * render.
 *
 * A leaf on purpose: each render module keeps its in-flight slots in a map made
 * here, so reading the list never imports the render code (a module that never
 * loaded has nothing running), and a slot opening or closing invalidates the
 * shared activity snapshot like any other lifecycle edge.
 */

import { noteSystemActivity } from './systemActivityNotify.js';

const kinds = new Map();

/**
 * A Map of one kind's in-flight render slots that counts toward system activity
 * and notes each slot opening and closing. `noun` names one slot in blocker
 * lines ("music video render"); `link(key, value)` is the page that owns a slot.
 */
export function trackedRenderMap(kind, { noun = 'render', link = () => null } = {}) {
  const map = new Map();
  const started = new Map();
  const set = map.set.bind(map);
  const remove = map.delete.bind(map);
  map.set = (key, value) => {
    const opened = !map.has(key);
    set(key, value);
    if (opened) {
      started.set(key, new Date().toISOString());
      noteSystemActivity('render', 'start');
    }
    return map;
  };
  map.delete = (key) => {
    const closed = remove(key);
    if (closed) {
      started.delete(key);
      noteSystemActivity('render', countActiveRenders() ? 'completion' : 'drained');
    }
    return closed;
  };
  kinds.set(kind, { map, started, noun, link });
  return map;
}

/** Every tracked render in flight: `{ kind, noun, to, startedAt }`. */
export function listActiveRenders() {
  const renders = [];
  for (const [kind, { map, started, noun, link }] of kinds) {
    for (const [key, value] of map) renders.push({ kind, noun, to: link(key, value) || null, startedAt: started.get(key) || null });
  }
  return renders;
}

/** Total tracked renders in flight in this process. */
function countActiveRenders() {
  let total = 0;
  for (const { map } of kinds.values()) total += map.size;
  return total;
}
