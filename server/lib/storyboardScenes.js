/**
 * Storyboard scene/shot durable ids + id-first target resolution (#3413).
 *
 * Storyboard scenes used to be addressed purely by ARRAY INDEX end to end —
 * the route took `sceneIndex`, the media-job owner encoded `scene<idx>`, and
 * the stage write patched `scenes[index]`. A reorder or delete landing between
 * a caller's read and its (serialized) write therefore retargeted the write
 * onto whatever scene now occupied that slot, and the completion hook routed
 * the finished render by the same stale index, so the mis-targeting was
 * consistent rather than self-correcting.
 *
 * Both halves of the fix live here:
 *
 *   - `ensureStoryboardIds` stamps a durable `id` on any scene (and shot) that
 *     lacks one. It is called from `sanitizeVisualStage`'s storyboards branch,
 *     so every persisted record grows ids on its next write, and from the
 *     backfill migrations for records already on disk / in Postgres.
 *   - `resolveStoryboardTarget` resolves a captured id against a FRESH array,
 *     falling back to the index only for pre-migration records that carry no
 *     id at all.
 *
 * Ids are DETERMINISTIC (`scene-01`, `shot-02`, …) rather than random on
 * purpose:
 *   - Two concurrent readers of the same un-migrated record must derive the
 *     same id, otherwise their writes would disagree about what they targeted.
 *   - Federated peers each run the backfill over their own copy of a shared
 *     record; a random id would make every peer stamp something different and
 *     churn conflicts forever. Deterministic ids converge.
 *
 * A deterministic base that is already taken gets a `-2`, `-3`, … suffix, so
 * an array that already holds `scene-01` never gets a duplicate stamped onto
 * it (duplicate ids would make id resolution ambiguous).
 */

const ID_MAX = 80;

const isNonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;

export const sceneIdForIndex = (index) => `scene-${String(index + 1).padStart(2, '0')}`;
export const shotIdForIndex = (index) => `shot-${String(index + 1).padStart(2, '0')}`;

// Deterministic collision escape: `scene-03` → `scene-03-2` → `scene-03-3`.
const uniqueId = (base, taken) => {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
};

// Stamp `id` on every entry that lacks one. Returns the ORIGINAL array
// reference when nothing changed so callers can cheaply detect a no-op.
const stampIds = (list, idFor) => {
  if (!Array.isArray(list) || list.length === 0) return list;
  const taken = new Set(
    list.filter((r) => r && typeof r === 'object' && isNonEmptyStr(r.id)).map((r) => r.id),
  );
  let changed = false;
  const out = list.map((rec, i) => {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
    if (isNonEmptyStr(rec.id)) return rec;
    const id = uniqueId(idFor(i).slice(0, ID_MAX), taken);
    taken.add(id);
    changed = true;
    return { ...rec, id };
  });
  return changed ? out : list;
};

/**
 * Stamp durable ids onto a storyboard `scenes[]` array (and each scene's
 * `shots[]`). Pure: returns a new array only when something was stamped,
 * otherwise the input reference. Non-object entries pass through untouched —
 * the sanitizer above this is the one that decides what a scene may be.
 */
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
 * Resolve a render target (a scene inside `scenes[]`, or a shot inside
 * `scene.shots[]`) against the FRESHEST array, given the id + index captured
 * when the caller read the record.
 *
 * Returns `{ index, record, matchedBy, stale }`:
 *   - `matchedBy: 'id'`    — the captured id is still present (authoritative,
 *     survives a reorder). When the id appears more than once (a duplicated
 *     record), the captured index wins the tiebreak, else the first match.
 *   - `matchedBy: 'index'` — no id was captured (pre-migration record), so the
 *     index is the only addressing available.
 *   - `matchedBy: null, stale: true`  — an id WAS captured and is gone: the
 *     target was removed between read and write. Callers surface this as a 409
 *     (distinct from a never-existed index, which is a 404) and must NOT fall
 *     back to the index, since that is exactly the mis-target this prevents.
 *   - `matchedBy: null, stale: false` — no id, and the index is out of range.
 */
export function resolveStoryboardTarget(list, { id = null, index = null } = {}) {
  const arr = Array.isArray(list) ? list : [];
  // `Number(null)` / `Number('')` are 0 — an absent index must NOT read as
  // "index 0" (CLAUDE.md sentinel discipline), so coerce only real numerics.
  const idx = index === null || index === undefined || index === '' ? NaN : Number(index);
  const hasIndex = Number.isInteger(idx) && idx >= 0;
  if (isNonEmptyStr(id)) {
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
