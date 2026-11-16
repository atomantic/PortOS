/**
 * Storyboard scene/shot durable ids + id-first target resolution (#3413) for `stages.storyboards.scenes[]`.
 *
 * `ensureStoryboardIds(scenes)` stamps a deterministic `scene-NN` / `shot-NN` id on any entry lacking one and re-stamps later copies of a DUPLICATE id (collision-escaped with a `-2` suffix, so peers and concurrent readers derive identical ids); `resolveStoryboardTarget(list, { id, index })` → `{ index, record, matchedBy, stale }` resolves a captured id against a fresh array, falling back to the index only when no id was captured and reporting `stale: true` (409, never an index retarget) when a captured id is gone. Scenes were once addressed purely by ARRAY INDEX (route `sceneIndex`, media-job owner `scene<idx>`, stage write `scenes[index]`), so a reorder or delete between a caller's read and its serialized write retargeted the write (and the completion hook's routing of the finished render) onto whatever scene now held that slot. `ensureStoryboardIds` runs from `sanitizeVisualStage`'s storyboards branch (records grow ids on next write) and the backfill migrations; `resolveStoryboardTarget` falls back to the index only for pre-migration records with no id. Ids are DETERMINISTIC, not random: concurrent readers of one un-migrated record must derive the same id, and federated peers backfilling their own copy would otherwise each stamp something different and churn conflicts forever. A taken base gets a `-2`, `-3`, … suffix (an array holding `scene-01` never gets a duplicate), and an array ALREADY carrying duplicate ids (a duplicated scene, or the extractor's tolerated duplicate shot ids) has later copies re-stamped, since duplicates make id resolution ambiguous (the mis-target this prevents).
 */

import { isNonBlankStr } from './textUtils.js';
const ID_MAX = 80;

export const sceneIdForIndex = (index) => `scene-${String(index + 1).padStart(2, '0')}`;
export const shotIdForIndex = (index) => `shot-${String(index + 1).padStart(2, '0')}`;

// Deterministic collision escape: `scene-03` → `scene-03-2` → `scene-03-3`.
const uniqueId = (base, taken) => {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
};

// Stamp `id` on every entry lacking one and re-stamp any whose id DUPLICATES an earlier entry's (as bad as none: the resolver tie-breaks on the captured index, so reordering same-id entries mis-targets). First occurrence keeps the id
// (matching `sanitizeShots`' first-wins `continuityFromShotId`). Returns the ORIGINAL array reference when nothing changed so callers can detect a no-op.
const stampIds = (list, idFor) => {
  if (!Array.isArray(list) || list.length === 0) return list;
  // Only ids that survive as-is (first occurrences) count as taken; a duplicate is about to be replaced and must not reserve its id.
  const taken = new Set();
  for (const rec of list) {
    if (rec && typeof rec === 'object' && isNonBlankStr(rec.id)) taken.add(rec.id);
  }
  const seen = new Set();
  let changed = false;
  const out = list.map((rec, i) => {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
    if (isNonBlankStr(rec.id) && !seen.has(rec.id)) {
      seen.add(rec.id);
      return rec;
    }
    const id = uniqueId(idFor(i).slice(0, ID_MAX), taken);
    taken.add(id);
    seen.add(id);
    changed = true;
    return { ...rec, id };
  });
  return changed ? out : list;
};

/** Stamp durable ids onto a storyboard `scenes[]` array (and each scene's `shots[]`). Pure: a new array only when something was stamped, else the input reference; non-object entries pass through (the sanitizer above decides what a scene may be). */
export function ensureStoryboardIds(scenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) return scenes;
  let shotsChanged = false;
  const withShotIds = scenes.map((scene) => {
    if (!scene || typeof scene !== 'object' || !Array.isArray(scene.shots)) return scene;
    const shots = stampIds(scene.shots, shotIdForIndex);
    if (shots === scene.shots) return scene;
    shotsChanged = true;
    return { ...scene, shots };
  });
  const stamped = stampIds(withShotIds, sceneIdForIndex);
  if (stamped !== withShotIds) return stamped;
  return shotsChanged ? withShotIds : scenes;
}

/**
 * Resolve a render target (a scene in `scenes[]`, or a shot in `scene.shots[]`) against the FRESHEST array, given the id + index captured at read. Returns `{ index, record, matchedBy, stale }`:
 *   - `matchedBy: 'id'`: the captured id is present (authoritative, survives a reorder); if it appears more than once the captured index wins the tiebreak, else the first match.
 *   - `matchedBy: 'index'`: no id was captured (pre-migration), so the index is the only addressing.
 *   - `matchedBy: null, stale: true`: an id WAS captured and is gone (removed between read and write); callers surface a 409 (a never-existed index is a 404) and must NOT fall back to the index (the mis-target this prevents).
 *   - `matchedBy: null, stale: false`: no id, and the index is out of range.
 */
export function resolveStoryboardTarget(list, { id = null, index = null } = {}) {
  const arr = Array.isArray(list) ? list : [];
  // `Number(null)` / `Number('')` are 0: an absent index must NOT read as index 0 (AGENTS.md sentinel discipline), so coerce only real numerics.
  const idx = index === null || index === undefined || index === '' ? NaN : Number(index);
  const hasIndex = Number.isInteger(idx) && idx >= 0;
  if (isNonBlankStr(id)) {
    if (hasIndex && arr[idx] && arr[idx].id === id) {
      return { index: idx, record: arr[idx], matchedBy: 'id', stale: false };
    }
    const found = arr.findIndex((r) => r && r.id === id);
    if (found >= 0) return { index: found, record: arr[found], matchedBy: 'id', stale: false };
    return { index: -1, record: null, matchedBy: null, stale: true };
  }
  if (hasIndex && arr[idx]) return { index: idx, record: arr[idx], matchedBy: 'index', stale: false };
  return { index: -1, record: null, matchedBy: null, stale: false };
}
