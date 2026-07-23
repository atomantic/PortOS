/**
 * Sprite asset facets (#2931) — classify a record-relative sprite asset path
 * into `{ family, status, role, direction, runId }` so the character asset
 * collection can group by what an asset *is* rather than by which directory it
 * happens to live in.
 *
 * This is the client-side counterpart of the source pipeline's
 * `assets.py:classify_asset()`. It stays client-side deliberately (#2930's
 * out-of-scope note): the listing is already scoped to one record, so a server
 * round-trip buys nothing, and the path grammar is stable enough to mirror.
 *
 * Pure module — no I/O, no React. The path grammar it decodes is written by:
 *   reference/<id>-walk-<dir>-vN.png          locked reference / anchor
 *   reference/candidates/walk-<dir>-candidate-N.png
 *   reference/uploads/<file>                  user-supplied design image
 *   grok|runs/<runId>/generated/frames/NN-<phase>.png
 *   grok|runs/<runId>/generated/<id>-walk-<dir>-strip.png
 *   grok|runs/<runId>/generated/review/<id>-...-contrast-review.png
 *   grok|runs/<runId>/generated/source-video.mp4
 *   walk/trims/<slug>-vNNN-strip.png · <slug>-vNNN.gif
 *   runtime/vN/<stem>-vN.png                  published atlas
 *   atlas/<file>                              imported props atlas family
 */

// Mirrors server/services/sprites/prompts.js SPRITE_DIRECTIONS (the client
// can't import server modules; WalkWorkflow mirrors WALK_PHASES the same way).
export const SPRITE_DIRECTIONS = [
  'south', 'south-east', 'east', 'north-east',
  'north', 'north-west', 'west', 'south-west',
];

/**
 * Every role, in the order the collection renders its groups. `manifest` is a
 * PortOS addition to the source's role set: sidecar JSON is a real category
 * here (run records, reference sets, atlas manifests, the publish pointer) and
 * folding it into `sprite` would put JSON in the image grid.
 */
export const SPRITE_ASSET_ROLES = [
  'reference', 'strip', 'animation', 'frame', 'atlas', 'evidence', 'sprite', 'manifest',
];

export const SPRITE_ROLE_LABELS = {
  reference: 'Reference set',
  strip: 'Strips',
  animation: 'Animations',
  frame: 'Frames',
  atlas: 'Atlases',
  evidence: 'Review evidence',
  sprite: 'Other sprites',
  manifest: 'Manifests',
};

// Longest-first alternation so `south-east` wins over `south` — regex
// alternation is ordered, which is what makes the boundary correct without a
// lookahead (`walk-south-east-abc` must not classify as `south`).
const DIRECTION_ALTERNATION = [...SPRITE_DIRECTIONS]
  .sort((a, b) => b.length - a.length)
  .join('|');
const ANCHOR_DIRECTION_MATCH = new RegExp(`walk-(${DIRECTION_ALTERNATION})`);
// Saved trims default to the slug `<direction>-loop`, which carries no
// `walk-` prefix — match it off the head of the filename instead.
const TRIM_DIRECTION_MATCH = new RegExp(`^walk/trims/(${DIRECTION_ALTERNATION})-`);

const RUN_DIR_MATCH = /^(?:grok|runs)\/([^/]+)\//;
const MANIFEST_EXT = /\.(json|ya?ml|txt|md|csv)$/i;
const ANIMATION_EXT = /\.(gif|mp4|webm|mov|m4v)$/i;
// `runtime/vN/` — the published-atlas version lives in the directory, not the
// filename, so supersede detection has to read it from there.
const RUNTIME_VERSION_DIR = /^runtime\/v(\d+)\//;
// `-v3.png`, `-v001-strip.png` — a trailing version marker on the filename.
const FILE_VERSION = /-v(\d+)(?=(-[a-z0-9-]+)?\.[a-z0-9]+$)/i;

const dirOf = (path) => {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
};
const fileOf = (path) => path.slice(path.lastIndexOf('/') + 1);

function roleFor(path) {
  // Extension-driven checks come first: `runtime/current.json` is a manifest,
  // not an atlas, and a run's source clip is an animation, not a frame.
  if (MANIFEST_EXT.test(path)) return 'manifest';
  if (ANIMATION_EXT.test(path)) return 'animation';
  if (path.includes('/review/') || fileOf(path).includes('contrast-review')) return 'evidence';
  if (path.includes('/generated/frames/')) return 'frame';
  if (fileOf(path).includes('-strip')) return 'strip';
  if (path.startsWith('runtime/') || path.startsWith('atlas/')) return 'atlas';
  if (path.startsWith('reference/')) return 'reference';
  return 'sprite';
}

function statusFor(path) {
  // No PortOS path writes a `rejected/` segment today — the source pipeline
  // does, and imported trees can carry one, so it is honored rather than
  // silently classified as a candidate.
  if (/(^|\/)rejected\//.test(path)) return 'rejected';
  if (path.startsWith('runtime/') || path.startsWith('atlas/')) return 'runtime';
  if (path.startsWith('reference/candidates/')) return 'candidate';
  if (path.startsWith('reference/uploads/')) return 'source';
  if (path.startsWith('reference/')) return 'approved';
  // A saved trim is a deliberate, named output — not a raw run intermediate.
  if (path.startsWith('walk/')) return 'approved';
  if (RUN_DIR_MATCH.test(path)) return 'candidate';
  return 'source';
}

function familyFor(path, runId) {
  if (runId) return runId;
  if (path.startsWith('walk/trims/')) return 'trims';
  const idx = path.indexOf('/');
  return idx < 0 ? 'files' : path.slice(0, idx);
}

function directionFor(path) {
  const trim = TRIM_DIRECTION_MATCH.exec(path);
  if (trim) return trim[1];
  const anchor = ANCHOR_DIRECTION_MATCH.exec(path);
  return anchor ? anchor[1] : null;
}

/**
 * Version identity for supersede detection: assets sharing a `stem` are
 * successive versions of one artifact, and only the highest `version` is
 * current. Returns `null` when the path carries no version marker (nothing to
 * supersede against).
 */
function versionOf(path) {
  const runtimeDir = RUNTIME_VERSION_DIR.exec(path);
  if (runtimeDir) {
    // Strip the version from BOTH the directory and the filename so
    // `runtime/v2/hero-v2.png` and `runtime/v3/hero-v3.png` share a stem.
    return { stem: `runtime:${fileOf(path).replace(FILE_VERSION, '')}`, version: Number(runtimeDir[1]) };
  }
  const file = FILE_VERSION.exec(fileOf(path));
  if (!file) return null;
  return { stem: `${dirOf(path)}:${fileOf(path).replace(FILE_VERSION, '')}`, version: Number(file[1]) };
}

/**
 * Facets for a single record-relative asset path. Pure and total — an
 * unrecognized path degrades to `{ family: <first segment>, status: 'source',
 * role: 'sprite' }` rather than throwing.
 */
export function classifySpriteAsset(path) {
  if (typeof path !== 'string' || !path) {
    return { family: 'files', status: 'source', role: 'sprite', direction: null, runId: null };
  }
  const run = RUN_DIR_MATCH.exec(path);
  const runId = run ? run[1] : null;
  return {
    family: familyFor(path, runId),
    status: statusFor(path),
    role: roleFor(path),
    direction: directionFor(path),
    runId,
  };
}

/**
 * Classify a whole listing, adding the one facet that is only knowable across
 * the set: an `approved` asset that is NOT the highest version of its stem is
 * `superseded`. Deliberately scoped to `approved` — a runtime atlas stays
 * `runtime` (the publish pointer, not the version number, decides which is
 * live) and a candidate stays a candidate.
 *
 * Returns new objects; the input rows are never mutated.
 */
export function classifySpriteAssets(assets) {
  const rows = (Array.isArray(assets) ? assets : []).map((asset) => ({
    ...asset,
    facets: classifySpriteAsset(asset?.path),
  }));

  const latest = new Map();
  for (const row of rows) {
    if (row.facets.status !== 'approved') continue;
    const v = versionOf(row.path);
    if (!v) continue;
    latest.set(v.stem, Math.max(latest.get(v.stem) ?? -Infinity, v.version));
  }
  if (latest.size === 0) return rows;

  return rows.map((row) => {
    if (row.facets.status !== 'approved') return row;
    const v = versionOf(row.path);
    if (!v || v.version >= latest.get(v.stem)) return row;
    return { ...row, facets: { ...row.facets, status: 'superseded' } };
  });
}

/**
 * Classified assets grouped into render-ready role sections, in
 * `SPRITE_ASSET_ROLES` order. Empty roles are omitted.
 */
export function groupSpriteAssetsByRole(assets) {
  const rows = classifySpriteAssets(assets);
  const byRole = new Map();
  for (const row of rows) {
    const list = byRole.get(row.facets.role);
    if (list) list.push(row); else byRole.set(row.facets.role, [row]);
  }
  return SPRITE_ASSET_ROLES
    .filter((role) => byRole.has(role))
    .map((role) => ({ role, label: SPRITE_ROLE_LABELS[role], assets: byRole.get(role) }));
}
