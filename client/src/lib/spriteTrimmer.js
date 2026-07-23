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
 * (read from the asset listing). Only a run whose strip lives under `grok/` is
 * `trimmable` — the trim endpoint reads `grok/<runId>/animation-run.json`
 * hard-coded, so an imported `runs/<id>/` strip or a saved trim is preview-only
 * (playback + scrubbing, no re-save). This mirrors `spriteCollectionActions`'
 * `trimmableRunIds` gate so the two surfaces agree on what can be trimmed.
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
      trimmable: stripPath.startsWith('grok/'),
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
