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
 * Every role. The first seven, in this order, are the groups the collection
 * renders. `manifest` is a PortOS addition to the source's role set — sidecar
 * JSON (run records, reference sets, atlas manifests, the publish pointer) is a
 * real classifier category so it doesn't land in the image grid — but it is NOT
 * rendered as its own group: `groupSpriteAssetsByRole` folds each
 * runtime atlas's sidecar manifest onto its atlas row and omits the rest. The
 * role stays here so the classifier and its label map remain total.
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
// A packed walk strip's filename. Native runs write `<id>-walk-<dir>-strip.png`,
// but imported layouts name theirs `strip.png` or `strip-video-12-clean-alpha.png`
// — so match a `strip` token at a word boundary, not just the `-strip` infix
// (which would drop every imported strip into the generic sprite bucket and
// strip it of its Regenerate/Trim actions). `stripe.png` stays excluded.
const STRIP_FILE = /(^|[-_])strips?([-_.]|$)/i;
// `runtime/vN/` — the published-atlas version lives in the directory, not the
// filename, so supersede detection has to read it from there. This is the one
// source of truth for the `runtime/vN` grammar; `runtimeVersionDir` /
// `isRuntimeVersionPath` derive from it rather than re-anchoring the pattern.
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
  if (STRIP_FILE.test(fileOf(path))) return 'strip';
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
  // A saved trim is a derived DRAFT loop, not a finalized artifact — its own
  // producer manifest carries `status: candidate` — so it must not badge as
  // approved (that would read as reviewed/locked when it isn't).
  if (path.startsWith('walk/trims/')) return 'candidate';
  // Other imported `walk/` production assets are approved outputs.
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
 * The `runtime/vN` directory of a path (no trailing slash), or null. This is
 * the pairing key that ties an atlas PNG to its per-version sidecar manifest —
 * and it deliberately does NOT match `runtime/current.json` /
 * `runtime/publications.json`, which live in the top-level `runtime/` dir, so
 * the publish pointers are never mistaken for a version sidecar.
 */
export function runtimeVersionDir(path) {
  const m = typeof path === 'string' ? RUNTIME_VERSION_DIR.exec(path) : null;
  return m ? path.slice(0, m[0].length - 1) : null;
}

/** True for any file inside a `runtime/vN/` version directory (PNG or sidecar). */
export function isRuntimeVersionPath(path) {
  return runtimeVersionDir(path) !== null;
}

/**
 * True for the JSON sidecar of a runtime atlas — a `manifest`-role file living
 * in a `runtime/vN/` dir. Reuses the classifier's role so the "is this a build
 * manifest" definition lives in exactly one place (`roleFor`), not a second
 * regex in a component.
 */
export function isRuntimeSidecarManifest(path) {
  return isRuntimeVersionPath(path) && classifySpriteAsset(path).role === 'manifest';
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
 *
 * The `manifest` role is intentionally NOT rendered as its own group.
 * A runtime atlas's sidecar manifest is metadata FOR that atlas — same
 * `runtime/vN/` dir, 1:1, deleted as a unit — so it is folded onto its atlas
 * row as `row.manifest` (surfaced by the atlas card as a "View manifest"
 * affordance) rather than shown as a lookalike JSON card that reads as a
 * separate concern from the PNG it describes. The remaining JSON the classifier
 * tags `manifest` (publish pointers, run records, the reference-set manifest)
 * is behind-the-scenes state, not a browsable asset, so it is omitted from the
 * grid entirely.
 */
export function groupSpriteAssetsByRole(assets) {
  const rows = classifySpriteAssets(assets);

  // Index each per-version sidecar manifest by its `runtime/vN` dir so the
  // atlas PNG sharing that dir can carry it along.
  const manifestByRuntimeDir = new Map();
  for (const row of rows) {
    if (row.facets.role !== 'manifest') continue;
    const dir = runtimeVersionDir(row.path);
    if (dir) manifestByRuntimeDir.set(dir, row);
  }

  const byRole = new Map();
  for (const row of rows) {
    if (row.facets.role === 'manifest') continue; // folded onto its atlas / hidden
    let enriched = row;
    if (row.facets.role === 'atlas') {
      const manifest = manifestByRuntimeDir.get(runtimeVersionDir(row.path));
      if (manifest) enriched = { ...row, manifest };
    }
    const list = byRole.get(enriched.facets.role);
    if (list) list.push(enriched); else byRole.set(enriched.facets.role, [enriched]);
  }
  // `manifest` keys are never inserted (folded/skipped above), so filtering on
  // `byRole.has(role)` alone already excludes the Manifests group.
  return SPRITE_ASSET_ROLES
    .filter((role) => byRole.has(role))
    .map((role) => ({ role, label: SPRITE_ROLE_LABELS[role], assets: byRole.get(role) }));
}
