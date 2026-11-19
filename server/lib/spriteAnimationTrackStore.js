/**
 * Sprites: the user-defined animation-track store (#3152).
 *
 * The EFFECTIVE track table is the compiled built-ins merged with the user store (one small JSON config), so sprite schemas stay module-load constants. Separate from `animationTracks.js`, which must stay a TRUE LEAF (`animationTracks.test.js`): `spriteValidation.js` builds sprite Zod ranges from it and must not pull the native image graph in; this module imports the leaf, never the reverse, and reaches only `fileUtils.js`.
 *
 * Reads are SYNCHRONOUS on purpose: every registry reader is sync and `spriteValidation.js` builds `spriteRuntimeContractSchema` at MODULE LOAD, where Zod can't await and ESM hoisting breaks "store is read before spriteValidation.js imports" ordering. One `readFileSync` per process keeps signatures untouched.
 * The shipped seed is the fallback: when `data/sprites/animation-tracks.json` is ABSENT it reads `data.reference/sprites/animation-tracks.json` (module load precedes boot migrations, else a first boot after upgrade builds a contract schema missing `scannerFrameCount`). An EXISTING store file is authoritative and never merged with the seed, so a deleted `scanner` stays deleted.
 * Storage: `file-primary`, machine-local, never federated; inseparable from the on-disk sprite tree (rows name the `setKind` strings approved sets carry); backed up by the rsync snapshot.
 * A bad stored row fails loudly at LOAD via `assertAnimationTrackRows` (same guard as the compiled table), naming the field instead of surfacing later as a `NaN` frame count.
 * The cache is the restart boundary: edits apply on next start (the merge is on hot paths; re-reading would make the registry mutable mid-request so a compile could validate spans against a table the render never saw). `__resetAnimationTrackStore()` is for tests and the CRUD UI (#3153).
 * The memo holds the MERGED table (never `null` once resolved: `walk` is always present).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { PATHS } from './fileUtils.js';
import {
  ANIMATION_TRACKS, WALK_TRACK, assertAnimationTrackRows, getAnimationTrack,
} from './spriteAnimationTracks.js';

/** The store file, relative to `data/` (and to `data.reference/` for the seed). */
export const ANIMATION_TRACK_STORE_REL = 'sprites/animation-tracks.json';
/** The store's on-disk layout version (distinct from any per-row shape version). */
export const ANIMATION_TRACK_STORE_SCHEMA_VERSION = 1;

/** The user-owned store — authoritative when it exists. */
export const animationTrackStorePath = () => join(PATHS.data, ANIMATION_TRACK_STORE_REL);
/** The shipped seed, read only when the user copy is absent (see the header). */
export const animationTrackSeedPath = () => join(PATHS.root, 'data.reference', ANIMATION_TRACK_STORE_REL);

// The merged table, `null` until first resolve; caches only the merged result (memoizing raw rows would pin a set that failed validation, so a fixed JSON would keep reporting the stale error).
let cachedEffectiveTracks = null;

/**
 * Classifies a read error: `absent` (ENOENT, try the next candidate), `io-error` (any other errno, report it) or `no-filesystem` (no errno: the call never reached a filesystem; see `resolveStoreDoc`).
 * Exported because this module binds `readFileSync` at import, so a test re-mocking `fs` couldn't intercept it.
 */
export function classifyStoreReadError(err) {
  if (!err?.code) return 'no-filesystem';
  return err.code === 'ENOENT' ? 'absent' : 'io-error';
}

/** Read one candidate store file: `null` when absent, THROWS when present but unreadable (a corrupt store must not silently degrade to the seed and revert tracks to shipped defaults). */
function readStoreDoc(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const kind = classifyStoreReadError(err);
    if (kind === 'absent') return null;
    // Re-thrown BARE so `resolveStoreDoc` reads it as "no store"; only a real errno gets a named error.
    if (kind === 'no-filesystem') throw err;
    throw new Error(`${ANIMATION_TRACK_STORE_REL}: cannot read ${path} — ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${ANIMATION_TRACK_STORE_REL}: ${path} is not valid JSON — ${err.message}`);
  }
}

/**
 * The authoritative store doc: the user copy if it exists, else the shipped seed, else `null` (walk alone). The whole resolution is guarded because `spriteValidation.js` builds sprite Zod ranges from this registry AT MODULE LOAD and nearly
 * everything imports it, so it runs in suites that stub `fs` partially or double `fileUtils.js` without `PATHS`: with no filesystem the answer is "no store", not an import-time failure. Scoped to the *environment* being unusable,
 * never a real read failure (an existing but unparseable store still throws; a TypeError from a missing mock export can't occur on a real install).
 */
function resolveStoreDoc() {
  try {
    return readStoreDoc(animationTrackStorePath()) ?? readStoreDoc(animationTrackSeedPath());
  } catch (err) {
    // Errors from an actual file carry this module's prefix and must stay loud.
    if (err?.message?.startsWith(ANIMATION_TRACK_STORE_REL)) throw err;
    return null;
  }
}

/** Freeze a raw stored row into a compiled row's shape with `builtin: false` FORCED: a stored `builtin: true` would shed its prompt past the "builtin rows carry no promptTemplate" guard, then throw at generate time with no builder. */
const normalizeStoredRow = (raw) => Object.freeze({
  ...raw,
  kinds: Object.freeze([...(Array.isArray(raw?.kinds) ? raw.kinds : [])]),
  builtin: false,
});

/** The user-defined rows keyed by id; `{}` when no store, seed or `tracks` array exists. */
function loadStoredRows() {
  const doc = resolveStoreDoc();
  const rows = Array.isArray(doc?.tracks) ? doc.tracks : [];
  const byId = {};
  for (const raw of rows) {
    const id = raw?.id;
    if (typeof id !== 'string' || !id) {
      throw new Error(`${ANIMATION_TRACK_STORE_REL}: every stored track needs a non-empty string id`);
    }
    // `walk` is mandatory: its bounds feed the Zod schemas and its `setKind` gates every character compile.
    if (id === WALK_TRACK) {
      throw new Error(`${ANIMATION_TRACK_STORE_REL}: '${WALK_TRACK}' is the mandatory built-in track and cannot be redefined by a stored row`);
    }
    if (Object.hasOwn(byId, id)) throw new Error(`${ANIMATION_TRACK_STORE_REL}: track '${id}' is defined twice`);
    byId[id] = normalizeStoredRow(raw);
  }
  return Object.freeze(byId);
}

/**
 * The compiled table merged with the user-defined store: `{ walk, …stored }`. SYNCHRONOUS so it works as a default parameter (`tracks = getEffectiveAnimationTracks()`) in atlas.js, atlasGrid.js, atlasLayout.js and walkFrames.js;
 * `walk` is always present and registered first, keeping derived orderings (atlas span order, id list) byte-stable across installs. Validated as a WHOLE table: key invariants are cross-row (shared contract field or `setKind`, two standalone baselines per record kind).
 */
export function getEffectiveAnimationTracks() {
  if (cachedEffectiveTracks) return cachedEffectiveTracks;
  const merged = Object.freeze({ ...ANIMATION_TRACKS, ...loadStoredRows() });
  assertAnimationTrackRows(merged);
  cachedEffectiveTracks = merged;
  return merged;
}

/** Effective track ids, in registration order (`walk` first, then stored). */
export function getEffectiveAnimationTrackIds() {
  return Object.keys(getEffectiveAnimationTracks());
}

/** `getAnimationTrack(id, getEffectiveAnimationTracks())` with its exact boundary: an absent id resolves to `walk`, an unrecognized one THROWS naming the known tracks, never `undefined`. Modules with an injected table call `getAnimationTrack(id, tracks)`. */
export function effectiveTrack(id) {
  return getAnimationTrack(id, getEffectiveAnimationTracks());
}

/** Drop the cached store read; call after a write or the running server keeps serving the old table. */
export function __resetAnimationTrackStore() {
  cachedEffectiveTracks = null;
}
