/**
 * Loop Trimmer helpers for the Sprite Manager (#2933).
 *
 * Pure geometry + source-list math behind the deep-linkable Loop Trimmer
 * workspace: turn a record's walk state (+ its on-disk asset listing) into the
 * ordered set of animation sources the trimmer can load, derive a strip's frame
 * geometry, label each phase, and sanitize the user's output slug to the
 * `[a-z0-9-]+` shape the server accepts.
 *
 * No React, no I/O, no canvas — the component owns painting; this module owns
 * the arithmetic so the correctness surface is unit-testable without mounting.
 */

// Mirrors server/services/sprites/walkPostprocess.js WALK_PHASES (and the copy
// WalkWorkflow.jsx imports from here) — the phase label for each of the 8 cells
// a native grok walk run packs.
export const WALK_PHASES = [
  'left-contact', 'left-down', 'left-passing', 'left-up',
  'right-contact', 'right-down', 'right-passing', 'right-up',
];

const DEFAULT_FPS = 12;

// Walk-cycle authoring bounds (mirror server/services/sprites/walkBounds.js).
// Frame count = how many frames the packed cycle holds (more = smoother); fps =
// preview playback speed. Cycle duration = frameCount / fps seconds.
//
// Both are pinned at the SET level (#2985), never per render: a walk cycle is N
// contiguous atlas columns × 8 direction rows, so every direction must agree or
// the atlas cannot compile. These constants only seed the option lists — the
// server resolves the target and refuses a disagreeing render. They live here
// (not in a component) because two surfaces now offer the same control: the
// walk workflow's set-level picker and the Loop Trimmer's re-derive (#2980).
export const WALK_DEFAULT_FRAME_COUNT = 12;
export const WALK_DEFAULT_FPS = 10;
// Module-local: callers pick from the option lists below rather than re-deriving
// them, so the bounds themselves have no consumer outside this file.
const WALK_FRAME_COUNT_RANGE = { min: 6, max: 16 };
const WALK_FPS_RANGE = { min: 4, max: 24 };

// Inclusive integer sequence [min..max] by step. Both option lists derive from
// module constants, so build them once at load rather than on every render.
const seq = (min, max, step) => {
  const out = [];
  for (let v = min; v <= max; v += step) out.push(v);
  return out;
};
export const WALK_FRAME_COUNT_OPTIONS = seq(WALK_FRAME_COUNT_RANGE.min, WALK_FRAME_COUNT_RANGE.max, 1);
// The speed picker offers even steps to keep the list short, but the server
// accepts ANY integer in range — an imported set (or a direct API call) can pin
// an odd fps like 15. A <select> whose value matches no <option> silently
// displays the FIRST option, so the control would claim "4 fps" while the set is
// really at 15. Splice the current value in so the control never lies.
const WALK_FPS_OPTIONS = seq(WALK_FPS_RANGE.min, WALK_FPS_RANGE.max, 2);
export const walkFpsOptionsFor = (fps) => (WALK_FPS_OPTIONS.includes(fps) || !Number.isFinite(fps)
  ? WALK_FPS_OPTIONS
  : [...WALK_FPS_OPTIONS, fps].sort((a, b) => a - b));

/**
 * Frame geometry for a packed strip, defaulting to the native 8-phase packaging
 * when a run predates (or omits) the richer stripPreview fields. `cellWidth` /
 * `cellHeight` are 0 when the preview carries no cell size — callers derive the
 * true cell size from the loaded image's natural dimensions instead, which also
 * covers saved-trim strips that never carry a stripPreview.
 */
export function stripFrameGeometry(stripPreview) {
  const rawCount = Math.round(Number(stripPreview?.frameCount));
  const frameCount = rawCount > 1 ? rawCount : WALK_PHASES.length; // NaN > 1 is false
  const fps = Number(stripPreview?.fps) > 0 ? Number(stripPreview.fps) : DEFAULT_FPS;
  const cw = Number(stripPreview?.cellWidth);
  const ch = Number(stripPreview?.cellHeight);
  return {
    frameCount,
    fps,
    cellWidth: cw > 0 ? cw : 0,
    cellHeight: ch > 0 ? ch : 0,
  };
}

/**
 * Human label for one frame index. Named walk phases only apply to the native
 * 8-cell packing; a longer imported redraw cycle (or an arbitrary saved trim)
 * gets a plain `frame N` so the labels never mix a real phase with a bare index.
 */
export function phaseLabelFor(index, frameCount) {
  if (frameCount === WALK_PHASES.length && WALK_PHASES[index]) return WALK_PHASES[index];
  return `frame ${index}`;
}

/** `[0, 1, …, frameCount-1]`. */
export function allColumns(frameCount) {
  const n = Math.max(0, Math.round(Number(frameCount)) || 0);
  return Array.from({ length: n }, (_, i) => i);
}

/** The complement of `enabled` within `[0, frameCount)`, ascending. */
export function invertColumns(frameCount, enabled) {
  const set = new Set(enabled);
  return allColumns(frameCount).filter((i) => !set.has(i));
}

/**
 * Normalize a user-typed output name to the server's `[a-z0-9-]+` slug shape:
 * lowercase, non-alphanumerics collapse to a single `-`, and leading/trailing
 * dashes are trimmed. Returns '' for input with no usable characters so callers
 * can fall back to the server's default (`<direction>-loop`) rather than send a
 * slug the route would reject.
 */
export function sanitizeTrimSlug(name) {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Ordered animation sources for the trimmer's source select: every packaged
 * walk run that carries a preview strip, followed by the record's saved trims
 * (read from the asset listing). Every run with a strip is `trimmable` — the
 * trim service resolves geometry layout-agnostically (native `runs/`, legacy
 * `grok/`, imported `runs/`, or an imagegen redraw), so there's no vendor
 * coupling here anymore. A saved trim is preview-only (no run behind it to
 * re-trim). This mirrors `spriteCollectionActions`' `trimmableRunIds` gate so
 * the two surfaces agree on what can be trimmed.
 *
 * Each source: `{ id, kind: 'run'|'trim', runId, direction, label, stripPath,
 * frameCount, fps, trimmable }`. `runId` is null for a saved-trim source.
 */
export function buildTrimmerSources(walk, assets = []) {
  const sources = [];
  for (const run of walk?.runs || []) {
    const stripPath = run?.stripPreview?.stripPath;
    if (!stripPath) continue;
    const { frameCount, fps } = stripFrameGeometry(run.stripPreview);
    sources.push({
      id: `run:${run.id}`,
      kind: 'run',
      runId: run.id,
      direction: run.direction || null,
      label: `${run.direction || run.id} · ${run.status || 'run'}`,
      stripPath,
      frameCount,
      fps,
      // Any run with a packed strip can be re-trimmed — the service resolves it
      // by id regardless of on-disk layout.
      trimmable: true,
    });
  }

  for (const asset of assets || []) {
    if (!/^walk\/trims\/[^/]+-strip\.png$/.test(asset?.path || '')) continue;
    if (!(asset.width > 0) || !(asset.height > 0)) continue;
    const frameCount = Math.max(1, Math.round(asset.width / asset.height));
    const name = asset.path.slice('walk/trims/'.length).replace(/-strip\.png$/, '');
    sources.push({
      id: `trim:${asset.path}`,
      kind: 'trim',
      runId: null,
      direction: null,
      label: `saved trim · ${name}`,
      stripPath: asset.path,
      frameCount,
      fps: DEFAULT_FPS,
      trimmable: false,
    });
  }

  return sources;
}
