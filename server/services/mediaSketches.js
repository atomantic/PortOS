/**
 * Sketch & annotation overlays for generated media, keyed by `<kind>:<ref>`.
 *
 * Phase 1 of the Sketch & Annotation Canvas (issue #2036): a user draws over an
 * existing generated image and the strokes are persisted as a per-key sidecar so
 * they survive reload and job pruning. Each key stores two files:
 *
 *   data/media-sketches/<id>.json  — stroke vectors + canvas dimensions
 *   data/media-sketches/<id>.png   — flattened raster (image + strokes)
 *
 * where `<id>` is a filesystem-safe base64url encoding of the `<kind>:<ref>` key
 * (a ref is an arbitrary filename, so it can't be used as a path segment
 * directly). This is file-backed sidecar data (media-adjacent binary + vector
 * blobs, no relational shape) per the docs/STORAGE.md classification — the same
 * class as media-annotations.json / thumbnails, NOT a db-primary record.
 */

import { join } from 'path';
import { unlink, access } from 'fs/promises';
import { PATHS, atomicWrite, readJSONFile, ensureDir, tryReadFile } from '../lib/fileUtils.js';
import { isValidKey, parseKey } from '../lib/mediaItemKey.js';

const SKETCH_DIR = join(PATHS.data, 'media-sketches');

export const ERR_VALIDATION = 'VALIDATION_ERROR';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

// Guardrails so a hand-rolled or malicious payload can't balloon a sidecar.
export const MAX_STROKES = 5000;
export const MAX_POINTS_PER_STROKE = 20000;
export const STROKE_MODES = new Set(['draw', 'erase']);

export { isValidKey };

// A ref is an arbitrary filename (e.g. `image:my file:v2.png` is rejected by
// parseKey, but `image:my-file.png` is fine and still needs escaping for a
// path segment). base64url keeps every valid key to a single safe token.
const keyToId = (key) => Buffer.from(key, 'utf8').toString('base64url');
const jsonPathFor = (key) => join(SKETCH_DIR, `${keyToId(key)}.json`);
const pngPathFor = (key) => join(SKETCH_DIR, `${keyToId(key)}.png`);

const DATA_URL_PNG = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;

const isFinitePositive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

// Sanitize a single stroke into the persisted shape or return null to drop it.
function sanitizeStroke(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(raw.points) || raw.points.length === 0) return null;
  const points = [];
  for (const p of raw.points) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    points.push({ x: p.x, y: p.y });
    if (points.length >= MAX_POINTS_PER_STROKE) break;
  }
  if (points.length === 0) return null;
  const mode = STROKE_MODES.has(raw.mode) ? raw.mode : 'draw';
  const color = typeof raw.color === 'string' ? raw.color.slice(0, 32) : '#ef4444';
  const size = isFinitePositive(raw.size) ? Math.min(raw.size, 512) : 4;
  return { mode, color, size, points };
}

export function sanitizeSketchInput(input) {
  if (!input || typeof input !== 'object') throw makeErr('sketch payload required', ERR_VALIDATION);
  if (!Array.isArray(input.strokes)) throw makeErr('strokes must be an array', ERR_VALIDATION);
  if (!isFinitePositive(input.width) || !isFinitePositive(input.height)) {
    throw makeErr('width and height must be positive numbers', ERR_VALIDATION);
  }
  const strokes = [];
  for (const raw of input.strokes) {
    const s = sanitizeStroke(raw);
    if (s) strokes.push(s);
    if (strokes.length >= MAX_STROKES) break;
  }
  let png = null;
  if (typeof input.png === 'string' && input.png) {
    const m = DATA_URL_PNG.exec(input.png);
    if (!m) throw makeErr('png must be a data:image/png;base64 URL', ERR_VALIDATION);
    png = Buffer.from(m[1], 'base64');
  }
  return {
    width: input.width,
    height: input.height,
    strokes,
    png, // Buffer | null
  };
}

/** Read the persisted sketch for a key, or null when none exists. */
export async function getSketch(key) {
  if (!isValidKey(key)) throw makeErr(`Invalid key: ${key}`, ERR_VALIDATION);
  const data = await readJSONFile(jsonPathFor(key), null, { logError: false });
  if (!data || typeof data !== 'object' || !Array.isArray(data.strokes)) return null;
  return {
    key,
    width: data.width,
    height: data.height,
    strokes: data.strokes,
    updatedAt: data.updatedAt || null,
    hasPng: !!data.hasPng,
  };
}

/** Raw flattened PNG bytes for a key, or null. */
export async function getSketchPng(key) {
  if (!isValidKey(key)) throw makeErr(`Invalid key: ${key}`, ERR_VALIDATION);
  return tryReadFile(pngPathFor(key), null); // Buffer | null
}

/**
 * Absolute path to a key's flattened PNG sidecar when it exists on disk, else
 * null. Phase 2 (issue #2036) feeds this file to the img2img regen pipeline as
 * the init image, so it needs the path (not the bytes) to hand off to the runner.
 */
export async function getSketchPngPath(key) {
  if (!isValidKey(key)) throw makeErr(`Invalid key: ${key}`, ERR_VALIDATION);
  const path = pngPathFor(key);
  return access(path).then(() => path).catch(() => null);
}

/**
 * Persist (or replace) the sketch for a key. An empty stroke list removes the
 * sidecar entirely so a fully-erased canvas doesn't leave a stale record.
 * Returns the stored projection `{ key, width, height, strokes, updatedAt, hasPng }`.
 */
export async function saveSketch(key, input) {
  if (!isValidKey(key)) throw makeErr(`Invalid key: ${key}`, ERR_VALIDATION);
  const parsed = parseKey(key);
  if (parsed.kind !== 'image') throw makeErr('Only image media can be annotated', ERR_VALIDATION);
  const clean = sanitizeSketchInput(input);
  await ensureDir(SKETCH_DIR);

  if (clean.strokes.length === 0) {
    await removeSketch(key);
    return { key, width: clean.width, height: clean.height, strokes: [], updatedAt: null, hasPng: false };
  }

  const hasPng = !!clean.png;
  if (hasPng) await atomicWrite(pngPathFor(key), clean.png);
  // A re-save that carries only vectors (no PNG) must drop any prior flattened
  // export, otherwise `hasPng:false` in the JSON disagrees with a stale
  // `<id>.png` that getSketchPng() would keep streaming.
  else await unlink(pngPathFor(key)).catch(() => {});
  const record = {
    key,
    width: clean.width,
    height: clean.height,
    strokes: clean.strokes,
    updatedAt: new Date().toISOString(),
    hasPng,
  };
  await atomicWrite(jsonPathFor(key), record);
  return record;
}

/** Remove a key's sidecar (json + png). Idempotent. */
export async function removeSketch(key) {
  if (!isValidKey(key)) throw makeErr(`Invalid key: ${key}`, ERR_VALIDATION);
  await unlink(jsonPathFor(key)).catch(() => {});
  await unlink(pngPathFor(key)).catch(() => {});
}
