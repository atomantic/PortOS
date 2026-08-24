import { z } from 'zod';
import { RENDER_TARGET_BACKEND_AUTO, RECORD_RENDER_MODEL_MAX } from './renderTargets.js';
import { QUEUEABLE_IMAGE_MODES } from './generationModes.js';
import { GROK_VIDEO_DURATIONS } from './grokVideoClip.js';

/**
 * Cross-domain Zod primitives — the schema fragments that more than one
 * validation domain needs.
 *
 * Lives here (a leaf module) rather than in `validation.js` for the same
 * TDZ-cycle reason `zodCompat.js` exists: `validation.js` re-exports every
 * per-domain `*Validation.js` file with `export * from`, and ESM hoists those
 * re-exports above the module body — so a domain file that imported a value
 * back from `validation.js` would read it before it was initialized. Anything
 * both `validation.js` and a domain file need has to sit below both.
 *
 * `zodCompat.js` holds the *Zod-version* compatibility helpers (`.partial()`
 * semantics, empty-string sentinels); this module holds *PortOS-domain*
 * fragments that carry real business vocabulary (render pins, model-id
 * charset, clip lengths, path safety). Keeping them apart is what stops
 * zodCompat from accumulating imports on renderTargets/imageGen/grok modules.
 */

// Clip lengths grok's image_to_video delivers, as a Zod union built from the
// single shared list (see grokVideoClip.js). `z.literal` per value rather than
// `z.number().refine()` keeps the "expected 6 | 10" error message the
// hand-written union produced. Shared so routes/videoGen.js and the sprite
// animation schemas validate `duration` against this same union instead of
// rebuilding it.
export const grokVideoDurationSchema = z.union(
  GROK_VIDEO_DURATIONS.map((d) => z.literal(d)),
);

// Shared "valid model id" base — one definition of the shape a cloud-CLI
// model id may take (bounds + charset), derived per consumer so a future
// tweak (e.g. allowing `@`) lands everywhere at once. Used by settings
// schemas, the universe render route's one-off override, and the sprite
// fork/render pins.
export const cloudModelIdString = (message) => z.string().trim().max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, message);

// Per-RECORD render pin (#3231 Phase 3) — the flat `imageMode`/`imageModelId`
// field pair persisted on universe / series / sprite records, following the
// creative-commission shape. Spread into a record's create + patch schemas.
// Absent preserves; `'auto'`/`''`/null clears (the sanitizers collapse all
// three to "no pin"). The model id keeps the shared cloud-model charset so a
// pinned id can safely reach a CLI argv.
export const recordRenderPinFields = {
  imageMode: z.preprocess(
    (v) => (v === '' ? null : v),
    z.enum([RENDER_TARGET_BACKEND_AUTO, ...QUEUEABLE_IMAGE_MODES]).nullable().optional(),
  ),
  imageModelId: z.preprocess(
    (v) => (v === '' ? null : v),
    cloudModelIdString('model must be a valid model id').max(RECORD_RENDER_MODEL_MAX).nullable().optional(),
  ),
};

// Batch-by-id query param — `?ids=a,b,c` on a list route (#4148). Both wire
// forms normalize identically: a CSV string, and the repeated `?ids=a&ids=b`
// form Express hands over as an array (whose members may themselves be CSV).
// Each entry is trimmed and blanks are dropped, so one shape can't slip past the
// blank-removal or the cap the other enforces. An empty/all-blank value
// collapses to `undefined` so the field reads cleanly as absent
// (sentinel-not-empty) and the route falls through to its normal filters.
//
// `truncate` picks what an over-cap batch does. `false` (the default) rejects it
// with a 400 — the caller learns its request was too big instead of receiving a
// partial result it can't distinguish from "those ids don't exist". `true`
// silently slices at `max`, which the catalog's ingredient list has done since
// it shipped; kept as an option so this shared helper doesn't change that
// route's established contract.
export const csvIdsParam = ({ max, maxIdLength = 64, truncate = false } = {}) => z.preprocess((v) => {
  if (typeof v !== 'string' && !Array.isArray(v)) return v;
  const parts = (Array.isArray(v) ? v : [v])
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : [entry]))
    .map((s) => (typeof s === 'string' ? s.trim() : s))
    .filter((s) => s !== '');
  const bounded = truncate ? parts.slice(0, max) : parts;
  return bounded.length ? bounded : undefined;
}, z.array(z.string().trim().min(1).max(maxIdLength)).max(max).optional());

// subdirFilter is interpolated into an rsync `--include=${subdirFilter}/***`
// arg (rsync runs shell:false, so this is not shell injection — but `*` would
// expand to `--include=*/***` and defeat the filter chain, and `../foo` would
// traverse out of the snapshot subdir). Restrict to a relative path of safe
// characters with no wildcard, traversal, or absolute segments. Exported as a
// predicate so the restoreSnapshot service guard and the sprite run-id schemas
// reuse the exact same rule (mirrors isSafeRecordId in validation.js) — see
// issue #1822.
export const isSafeSubdirFilter = (v) =>
  typeof v === 'string'
  && /^[a-z0-9._/-]+$/i.test(v)
  && !v.split('/').includes('..')
  && !v.startsWith('/');
