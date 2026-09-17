/**
 * The documented creative toolkit for minds building Eidoverse vernacular
 * content (#7459, part of the stigmergic-federation epic #7453).
 *
 * `eidoverseFoundations.js` already gives an install a place to keep a build
 * ({ body, style }, vernacular by default, promotion explicit) and
 * `eidoverseWorld.js`'s `eidoverse.augment` already lets a mind place bounded
 * geometry in the live scene. What was still missing was a small, DOCUMENTED
 * vocabulary a mind can reach for instead of inventing coordinates and colors
 * from scratch every time: named materials, named motifs, and named
 * generative placement layouts.
 *
 * - **Materials** and **motifs** are cosmetics — install-local style, the
 *   kind of choice `eidoverseFoundations.js` keeps out of a promoted `body`.
 * - **Layouts** are generative PLACEMENT algorithms, keyed by a closed id so
 *   a promoted `district-template.body.layoutId` reproduces the same
 *   geometry on any install that inherits it — the same reason
 *   `EIDOVERSE_FOUNDATION_KINDS` is a closed list rather than free text.
 *
 * Every layout is a deterministic, seeded placement function: same
 * `{layoutId, anchor, propCount, seed, facing}` always yields the same
 * positions, and nothing here ever calls an AI provider. That is what keeps
 * "generative placement" on the right side of the no-cold-bootstrap-LLM-call
 * rule (root `AGENTS.md`) — a mind (or a human, through the same helpers)
 * picks a layout/material/motif and this module computes WHERE things go
 * with plain seeded math, not a model call.
 *
 * `buildDistrictTemplateFoundationDraft` shapes its output to match
 * `eidoverseFoundationInputSchema` (`eidoverseFoundations.js`) directly: the
 * generative placement is substance and lands in `body`; the material/motif
 * choice is cosmetics and lands in `style`. Pure: no I/O, no clock, no
 * provider calls.
 */

const clampInt = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** Cosmetic palettes. Style-layer only — never a foundation `body` key. */
export const EIDOVERSE_CREATIVE_MATERIALS = Object.freeze([
  { id: 'sunbaked-clay', label: 'Sunbaked Clay', colorHex: '#c97a4a', description: 'Warm terracotta walls and rammed-earth paths.' },
  { id: 'weathered-copper', label: 'Weathered Copper', colorHex: '#4fa389', description: 'Oxidized green-blue metal roofing and trim.' },
  { id: 'moonlit-slate', label: 'Moonlit Slate', colorHex: '#5b6b8c', description: 'Cool blue-grey stone for quiet, nocturnal districts.' },
  { id: 'coral-lacquer', label: 'Coral Lacquer', colorHex: '#e0637a', description: 'Glossy warm accent panels for a lively market feel.' },
  { id: 'moss-stone', label: 'Moss Stone', colorHex: '#6f8f5a', description: 'Lichen-soft greys and greens for overgrown, garden districts.' },
  { id: 'brushed-steel', label: 'Brushed Steel', colorHex: '#8d97a3', description: 'Cool neutral metal for utilitarian, technical districts.' },
]);

/** Decorative arrangement intent. Style-layer only — never a `body` key. */
export const EIDOVERSE_CREATIVE_MOTIFS = Object.freeze([
  { id: 'lantern-row', label: 'Lantern Row', description: 'Evenly spaced light fixtures tracing the placement path.' },
  { id: 'garden-grove', label: 'Garden Grove', description: 'Planted greenery softening every prop position.' },
  { id: 'colonnade', label: 'Colonnade', description: 'Repeated vertical structural accents, formal and rhythmic.' },
  { id: 'market-stalls', label: 'Market Stalls', description: 'Low, dense furniture suggesting trade and gathering.' },
  { id: 'tide-pools', label: 'Tide Pools', description: 'Irregular, water-adjacent clustering.' },
]);

const RING_RADIUS = 6;
const GRID_SPACING = 3;
const ARC_RADIUS = 7;
const ARC_SPAN = Math.PI / 1.5; // 120 degrees, centered on `facing`
const GROVE_RADIUS = 5;

/** Deterministic seeded placement, one point (and facing yaw) per prop index. */
function radialRing(anchor, count, rng, facing) {
  return Array.from({ length: count }, (_, index) => {
    const angle = facing + (Math.PI * 2 * index) / count;
    const pos = [anchor[0] + Math.cos(angle) * RING_RADIUS, anchor[1], anchor[2] + Math.sin(angle) * RING_RADIUS];
    return { pos, yaw: angle + Math.PI };
  });
}

function gridPlot(anchor, count, rng, facing) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const cos = Math.cos(facing);
  const sin = Math.sin(facing);
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const localX = (col - (columns - 1) / 2) * GRID_SPACING;
    const localZ = row * GRID_SPACING + GRID_SPACING;
    const pos = [anchor[0] + localX * cos + localZ * sin, anchor[1], anchor[2] - localX * sin + localZ * cos];
    return { pos, yaw: facing + Math.PI };
  });
}

function arcRow(anchor, count, rng, facing) {
  return Array.from({ length: count }, (_, index) => {
    const spread = count > 1 ? (index / (count - 1) - 0.5) * ARC_SPAN : 0;
    const angle = facing + spread;
    const pos = [anchor[0] + Math.cos(angle) * ARC_RADIUS, anchor[1], anchor[2] + Math.sin(angle) * ARC_RADIUS];
    return { pos, yaw: angle + Math.PI };
  });
}

function groveCluster(anchor, count, rng, facing) {
  return Array.from({ length: count }, () => {
    const angle = facing + rng() * Math.PI * 2;
    const radius = GROVE_RADIUS * Math.sqrt(rng());
    const pos = [anchor[0] + Math.cos(angle) * radius, anchor[1], anchor[2] + Math.sin(angle) * radius];
    return { pos, yaw: rng() * Math.PI * 2 };
  });
}

/** Named generative placement algorithms. Structural — safe in a foundation `body`. */
const LAYOUT_GENERATORS = Object.freeze({
  'radial-ring': radialRing,
  'grid-plot': gridPlot,
  'arc-row': arcRow,
  'grove-cluster': groveCluster,
});

export const EIDOVERSE_CREATIVE_LAYOUTS = Object.freeze([
  { id: 'radial-ring', label: 'Radial Ring', description: 'Props spaced evenly around the anchor, facing inward.' },
  { id: 'grid-plot', label: 'Grid Plot', description: 'A rectangular grid of props extending from the anchor.' },
  { id: 'arc-row', label: 'Arc Row', description: 'Props along a 120-degree arc facing one direction, e.g. a storefront row.' },
  { id: 'grove-cluster', label: 'Grove Cluster', description: 'An organic, seeded-random cluster — useful for gardens or ruins.' },
]);

const findById = (catalog, id) => catalog.find((entry) => entry.id === id);

function requireCatalogEntry(catalog, id, label) {
  const entry = findById(catalog, id);
  if (!entry) throw new RangeError(`Unknown ${label} "${id}". Expected one of ${catalog.map((item) => item.id).join(', ')}.`);
  return entry;
}

/** A mind- and prompt-safe projection of the toolkit: ids, labels, descriptions only. */
export function describeCreativeCatalog() {
  const project = (catalog) => catalog.map(({ id, label, description }) => ({ id, label, description }));
  return {
    materials: project(EIDOVERSE_CREATIVE_MATERIALS),
    motifs: project(EIDOVERSE_CREATIVE_MOTIFS),
    layouts: project(EIDOVERSE_CREATIVE_LAYOUTS),
  };
}

// ---------------------------------------------------------------------------
// Deterministic seeded placement
// ---------------------------------------------------------------------------

/** FNV-1a: a short string seed to a 32-bit unsigned int. */
function hashSeed(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: a small, fast, deterministic PRNG — replayable across installs. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function requireAnchor(anchor) {
  if (!Array.isArray(anchor) || anchor.length !== 3 || anchor.some((value) => !Number.isFinite(value))) {
    throw new RangeError('anchor must be [x, y, z] finite numbers.');
  }
}

/**
 * Generate deterministic prop placements for a named layout.
 *
 * @param {object} options
 * @param {string} options.layoutId - one of `EIDOVERSE_CREATIVE_LAYOUTS`
 * @param {number[]} options.anchor - [x, y, z] world-space origin
 * @param {number} [options.propCount] - clamped to [1, 16]
 * @param {string} [options.seed] - any string; same seed replays the same placement.
 *   The geometric layouts (`radial-ring`, `grid-plot`, `arc-row`) are fully
 *   determined by anchor/count/facing and so are seed-invariant by design;
 *   only `grove-cluster` consumes the seeded RNG for its jitter. The
 *   reproducibility guarantee — same inputs, same output — holds for every
 *   layout either way.
 * @param {number} [options.facing] - radians, the layout's orientation
 * @returns {Array<{ pos: number[], yaw: number }>}
 */
export function generateDistrictTemplatePlacement({ layoutId, anchor, propCount = 6, seed = layoutId, facing = 0 }) {
  const generator = LAYOUT_GENERATORS[layoutId];
  if (!generator) throw new RangeError(`Unknown layout "${layoutId}". Expected one of ${EIDOVERSE_CREATIVE_LAYOUTS.map((item) => item.id).join(', ')}.`);
  requireAnchor(anchor);
  const count = clampInt(propCount, 1, 16);
  const rng = mulberry32(hashSeed(String(seed ?? layoutId)));
  return generator(anchor, count, rng, Number.isFinite(facing) ? facing : 0)
    .map((prop) => ({ pos: prop.pos.map((value) => Number(value.toFixed(3))), yaw: Number(prop.yaw.toFixed(4)) }));
}

/**
 * Turn a generated placement into `eidoverse.augment` `spawn` operations,
 * ready to submit as-is. Asset validity (a real library path) is checked by
 * `eidoverseWorld.js`'s augment implementation when the operations land —
 * this helper only owns the placement math.
 */
export function buildDistrictTemplateAugmentOperations({ layoutId, anchor, propCount, seed, facing, assetPath, idPrefix }) {
  if (typeof assetPath !== 'string' || !assetPath.trim()) throw new RangeError('assetPath must be a non-empty Eidoverse library or store path.');
  const prefix = typeof idPrefix === 'string' && idPrefix.trim() ? idPrefix.trim() : layoutId;
  const placement = generateDistrictTemplatePlacement({ layoutId, anchor, propCount, seed, facing });
  return placement.map((prop, index) => ({
    verb: 'spawn',
    args: { id: `${prefix}-${index}`, lib: assetPath, pos: prop.pos, yaw: prop.yaw, scale: 1 },
  }));
}

/**
 * Compose a `district-template` foundation input, shaped for
 * `eidoverseFoundationInputSchema` (`eidoverseFoundations.js`) and ready to
 * pass to `recordEidoverseFoundation` — it always lands on the local
 * `vernacular` layer by construction, matching every other authored
 * foundation. The generative placement (layout, anchor, seed, resulting
 * positions) is the promotable substance and goes in `body`; the material
 * and motif choice are cosmetics and go in `style`, exactly as
 * `styleLeakFindings` expects.
 */
export function buildDistrictTemplateFoundationDraft({
  id, title, summary, contributionId, layoutId, materialId, motifId, anchor, propCount = 6, seed, facing = 0, disclosure,
}) {
  const material = requireCatalogEntry(EIDOVERSE_CREATIVE_MATERIALS, materialId, 'material');
  const motif = requireCatalogEntry(EIDOVERSE_CREATIVE_MOTIFS, motifId, 'motif');
  const resolvedSeed = seed ?? `${id}-${layoutId}`;
  const placement = generateDistrictTemplatePlacement({ layoutId, anchor, propCount, seed: resolvedSeed, facing });
  return {
    id,
    kind: 'district-template',
    title,
    summary,
    contributionId,
    body: {
      layoutId,
      anchor: anchor.map((value) => Number(value)),
      propCount: clampInt(propCount, 1, 16),
      seed: resolvedSeed,
      facing,
      placement,
    },
    style: { materialId: material.id, motifId: motif.id, palette: material.colorHex, motif: motif.id },
    disclosure: disclosure ?? {},
  };
}
