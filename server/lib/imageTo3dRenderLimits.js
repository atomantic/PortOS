// Shared bounds and vocabularies for image-to-3D render options.


/** Sampler steps per flow phase; runtime is ~linear in steps, so the cap bounds a mistyped value. */
export const RENDER_STEPS_MIN = 1;

export const RENDER_STEPS_MAX = 64;

/** int32: both lanes hand seeds to torch generators (narrower than `MAX_SEED` in client genUtils). */
export const RENDER_SEED_MAX = 2147483647;

/** Abstract tiers mapped per target by `detailTiers` (lane vocabularies differ). `'auto'` is a real value, not null. */
export const DETAIL_TIERS = ['auto', 'fast', 'balanced', 'max'];

/**
 * glTF alpha modes a caller may request for the exported material.
 *
 * `'auto'` defers to the exporter's heuristic; `null` = "don't ask" (see `glbMaterials.js`).
 */
export const ALPHA_MODES = ['OPAQUE', 'auto', 'BLEND', 'MASK'];

/**
 * Subject framing: fraction of the square canvas the source's longest side occupies. `1` is the
 * identity; below 1 gives extremities margin. Open at 0, closed at 1.
 */
export const SUBJECT_SCALE_MIN_EXCLUSIVE = 0;

export const SUBJECT_SCALE_MAX = 1;
