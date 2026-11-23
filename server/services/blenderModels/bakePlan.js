/**
 * describe().bake: `{ size: 1024 | 2048 | 4096, samples, sets: [{ id, partIds }] }`
 * (issue #17879), judged against the parts the model declared. Pure; the
 * report turns each problem into an error finding and bake.js bakes only a
 * plan with none.
 */
export const BLENDER_MODEL_BAKE_SIZES = Object.freeze([1024, 2048, 4096]);
export const BLENDER_MODEL_BAKE_SAMPLES_MAX = 1024;
export const BLENDER_MODEL_BAKE_SETS_MAX = 16;
// A UV overlap above this share of the covered area makes a set's textures unusable.
export const BLENDER_MODEL_BAKE_UV_OVERLAP_MAX = 0.02;
/** The three images a set bakes, by name, with the file each is kept in. */
export const BLENDER_MODEL_BAKE_IMAGES = Object.freeze({ baseColor: 'base_color.png', normal: 'normal.png', orm: 'orm.png' });

const SET_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * `{ requested, size, samples, sets, problems }` for a `bake` the protocol parsed (null: none asked).
 * `sets` holds `{ id, partIds }` only when `problems` is empty; each problem is `{ code, message, subjects? }`.
 */
export function planBlenderModelBake(bake, declaredPartIds) {
  if (bake == null) return { requested: false, size: null, samples: null, sets: [], problems: [] };
  const problems = [];
  const problem = (code, message, subjects) => problems.push({ code, message, ...(subjects ? { subjects: subjects.slice(0, 50) } : {}) });
  if (bake.raw) {
    problem('bake-invalid', 'describe().bake must be a dict: {"size", "samples", "sets": [{"id", "partIds"}]}');
    return { requested: true, size: null, samples: null, sets: [], problems };
  }
  const { size, samples } = bake;
  if (!BLENDER_MODEL_BAKE_SIZES.includes(size)) problem('bake-size-invalid', `bake.size must be one of ${BLENDER_MODEL_BAKE_SIZES.join(', ')}`);
  if (!Number.isInteger(samples) || samples < 1 || samples > BLENDER_MODEL_BAKE_SAMPLES_MAX) {
    problem('bake-samples-invalid', `bake.samples must be a whole number from 1 to ${BLENDER_MODEL_BAKE_SAMPLES_MAX}`);
  }
  const declared = new Set(declaredPartIds);
  const entries = Array.isArray(bake.sets) ? bake.sets : [];
  if (!entries.length || bake.setsTruncated || entries.length > BLENDER_MODEL_BAKE_SETS_MAX) {
    problem('bake-sets-invalid', `bake.sets must list 1 to ${BLENDER_MODEL_BAKE_SETS_MAX} sets`);
  }
  const malformed = entries.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !entry || !SET_ID.test(entry.id ?? '') || !Array.isArray(entry.partIds) || !entry.partIds.length || entry.partIds.some((part) => typeof part !== 'string'))
    .map(({ entry, index }) => entry?.id ?? `sets[${index}]`);
  if (malformed.length) problem('bake-set-invalid', 'Each bake set needs an id (letters, digits, ".", "_" or "-") and a non-empty list of part ids', malformed);
  const sets = entries.filter((entry) => entry && SET_ID.test(entry.id ?? '') && Array.isArray(entry.partIds) && entry.partIds.length && entry.partIds.every((part) => typeof part === 'string'));
  const ids = sets.map((entry) => entry.id);
  const repeated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (repeated.length) problem('bake-set-duplicate', 'Two bake sets share an id', repeated);
  const unknown = [...new Set(sets.flatMap((entry) => entry.partIds).filter((part) => !declared.has(part)))];
  if (unknown.length) problem('bake-part-unknown', 'A bake set names a part describe() did not declare', unknown);
  const claimed = sets.flatMap((entry) => [...new Set(entry.partIds)]);
  const shared = [...new Set(claimed.filter((part, index) => claimed.indexOf(part) !== index))];
  if (shared.length) problem('bake-part-shared', 'A part belongs to more than one bake set', shared);
  return { requested: true, size, samples, sets: problems.length ? [] : sets.map((entry) => ({ id: entry.id, partIds: entry.partIds })), problems };
}
