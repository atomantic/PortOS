/**
 * Music Video take prompts at rest (#16210): each take keeps the exact prompt
 * its render was sent, about 4 KB of composed text, and most of it repeats
 * across a shot's re-renders and across shots (the project style, production
 * bible and palette lines). The stored record keeps every distinct prompt line
 * once, in a record-level `takePromptPool`, and each take keeps `promptLines`,
 * the pool positions of its lines in order.
 *
 * This is a storage encoding only. The stores pack on write and unpack on load,
 * so every reader above them (services, routes, the sync wire, content hashes,
 * the client) sees `take.prompt` exactly as sent, byte for byte, in its original
 * key position. A take written before #16210 carries `prompt` inline; it loads
 * as is and is packed at the record's next write. Code reading the row's JSON
 * directly (SQL, frozen migrations) sees the packed shape.
 */

export const TAKE_PROMPT_POOL_KEY = 'takePromptPool';

// Replace `from` with `to` at the same key position, so a round trip keeps the take's shape.
const renameKey = (obj, from, to, value) => Object.fromEntries(Object.entries(obj).map(([k, v]) => (k === from ? [to, value] : [k, v])));

const lineOf = (pool) => (ref) => (Number.isInteger(ref) && ref >= 0 && ref < pool.length && typeof pool[ref] === 'string' ? pool[ref] : null);

function unpackTake(take, line) {
  if (!take || typeof take !== 'object' || !('promptLines' in take)) return take;
  // A take that somehow carries both keeps its inline prompt; the refs are dropped.
  if (typeof take.prompt === 'string') {
    const { promptLines: _refs, ...rest } = take;
    return rest;
  }
  const lines = Array.isArray(take.promptLines) ? take.promptLines.map(line) : null;
  // A broken ref (never written by packTakePrompts) reads as no recorded prompt, which every reader already handles.
  const prompt = lines && lines.every((l) => l !== null) ? lines.join('\n') : null;
  return renameKey(take, 'promptLines', 'prompt', prompt);
}

/**
 * The stored record as readers see it: every packed take's `prompt` restored
 * and the pool removed. Returns the same object when nothing is packed.
 */
export function unpackTakePrompts(project) {
  if (!project || typeof project !== 'object') return project;
  const hasPool = TAKE_PROMPT_POOL_KEY in project;
  const scenes = project.scenes;
  const packedScene = (scene) => Array.isArray(scene?.takes) && scene.takes.some((t) => t && typeof t === 'object' && 'promptLines' in t);
  if (!hasPool && !(Array.isArray(scenes) && scenes.some(packedScene))) return project;
  const pool = Array.isArray(project[TAKE_PROMPT_POOL_KEY]) ? project[TAKE_PROMPT_POOL_KEY] : [];
  const line = lineOf(pool);
  const { [TAKE_PROMPT_POOL_KEY]: _pool, ...rest } = project;
  if (!Array.isArray(scenes)) return rest;
  return { ...rest, scenes: scenes.map((scene) => (packedScene(scene) ? { ...scene, takes: scene.takes.map((take) => unpackTake(take, line)) } : scene)) };
}

/**
 * The record as the stores write it: each take's prompt as pool refs, the pool
 * rebuilt from the takes on every write (so it never holds a line no take uses).
 * Lossless: `unpackTakePrompts(packTakePrompts(p))` equals `p` for any unpacked `p`,
 * and packing an already-packed record repacks it rather than nesting refs.
 */
export function packTakePrompts(project) {
  const source = unpackTakePrompts(project);
  if (!source || typeof source !== 'object' || !Array.isArray(source.scenes)) return source;
  const pool = [];
  const index = new Map();
  const ref = (text) => {
    let at = index.get(text);
    if (at === undefined) {
      at = pool.length;
      pool.push(text);
      index.set(text, at);
    }
    return at;
  };
  const packable = (take) => take && typeof take === 'object' && typeof take.prompt === 'string';
  const scenes = source.scenes.map((scene) => (Array.isArray(scene?.takes) && scene.takes.some(packable)
    ? { ...scene, takes: scene.takes.map((take) => (packable(take) ? renameKey(take, 'prompt', 'promptLines', take.prompt.split('\n').map(ref)) : take)) }
    : scene));
  return pool.length ? { ...source, scenes, [TAKE_PROMPT_POOL_KEY]: pool } : source;
}
