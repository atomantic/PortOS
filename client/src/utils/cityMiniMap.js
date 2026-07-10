// Pure, deterministic helpers for CyberCity's mini-map overlay (roadmap 2.8): a top-down
// HUD map that plots every building as a dot at its REAL city-layout position. The layout
// itself comes from `computeCityLayout(apps)` (the same function CityScene uses to place
// buildings), so the map can't drift from the actual city. This module only handles the
// projection math — world (x, z) ground coordinates → normalized 0..1 map coordinates for a
// fixed-size map box — plus bounds and empty/degenerate handling. No React / three.js
// imports so the topology stays unit-testable (mirrors cityTaskQueue.js).
//
// Geography awareness: the bay, shoreline, and Data Harbor are read from the SAME master
// town plan (`cityPlan.js`) the 3D scene uses, so the map's waterfront can't drift from the
// real city either. `geographyWorldPoints()` feeds those anchors into the map bounds so the
// bay is visible, and `projectGeography()` returns normalized shoreline/harbor coordinates
// for the overlay to draw.

import { WORLD, PARCELS } from './cityPlan';

// Padding (as a fraction of the box) so dots never sit exactly on the frame edge.
export const MINI_MAP_PADDING = 0.08;

// Compute the world-space bounds of a set of { x, z } layout positions. Returns null for an
// empty input so callers can render an "empty city" state rather than a degenerate box.
export function computeBounds(positions) {
  const list = Array.isArray(positions) ? positions : [];
  if (list.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of list) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
}

// Compute bounds for one layout district directly from the Map returned by
// computeCityLayout. Keeping the filter + minimum-count gate beside the
// canonical extrema reducer prevents visual layers from re-implementing the
// Infinity/-Infinity sentinel loop (and forgetting the empty-district case).
export function computeDistrictBounds(positions, district, { minCount = 1 } = {}) {
  if (!positions || typeof positions.forEach !== 'function') return null;
  const entries = [];
  positions.forEach((position) => {
    if (position?.district === district) entries.push(position);
  });
  if (entries.length < minCount) return null;
  return computeBounds(entries);
}

// Project a single world (x, z) into normalized 0..1 map coordinates given the world bounds.
// `nx` runs left→right with world +x; `ny` runs top→bottom with world +z (so the map reads
// like a top-down floor plan). A zero-width or zero-height span (one app, or a row/column)
// centers along that axis instead of dividing by zero. `padding` insets the usable area so
// dots clear the frame. Results are clamped to [0, 1].
export function projectPoint(point, bounds, padding = MINI_MAP_PADDING) {
  if (!bounds) return { nx: 0.5, ny: 0.5 };
  const spanX = bounds.maxX - bounds.minX;
  const spanZ = bounds.maxZ - bounds.minZ;
  const usable = 1 - 2 * padding;

  const fracX = spanX > 0 ? (point.x - bounds.minX) / spanX : 0.5;
  const fracZ = spanZ > 0 ? (point.z - bounds.minZ) / spanZ : 0.5;

  const nx = padding + fracX * usable;
  const ny = padding + fracZ * usable;
  return { nx: clamp01(nx), ny: clamp01(ny) };
}

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// World-space anchor points for the city's waterfront, read from the master town plan. These
// are folded into the map bounds (when geography is enabled) so the bay north of the shoreline
// and the Data Harbor's piers are actually inside the visible box — building positions alone
// only span the land, so the water would otherwise sit off-frame.
export function geographyWorldPoints() {
  const harbor = PARCELS.dataHarbor;
  const [hx, , hz] = harbor.anchor;
  const halfW = harbor.w / 2;
  const halfD = harbor.d / 2;
  return [
    // Shoreline span across the paved land width, at the waterline.
    { x: -WORLD.landHalf, z: WORLD.shorelineZ },
    { x: WORLD.landHalf, z: WORLD.shorelineZ },
    // Data Harbor footprint (out over the bay, z < shoreline).
    { x: hx - halfW, z: hz - halfD },
    { x: hx + halfW, z: hz + halfD },
  ];
}

// Normalized (0..1) projection of the waterfront for the overlay to draw, given the SAME
// bounds the dots use. `shorelineY` is the vertical position of the waterline (water is above
// it on the map — smaller z projects to smaller ny); `harbor` is the harbor marker's point.
// Returns null when bounds are null (empty city) so the overlay skips the water layer.
export function projectGeography(bounds, padding = MINI_MAP_PADDING) {
  if (!bounds) return null;
  const harbor = PARCELS.dataHarbor;
  const { ny: shorelineY } = projectPoint({ x: 0, z: WORLD.shorelineZ }, bounds, padding);
  const harborPoint = projectPoint({ x: harbor.anchor[0], z: harbor.anchor[2] }, bounds, padding);
  return {
    shorelineY,
    harbor: { nx: harborPoint.nx, ny: harborPoint.ny, label: harbor.label },
  };
}

// Full derived view-model for the mini-map component. Takes the layout `positions` Map (the
// return value of `computeCityLayout(apps)`, keyed by app id) plus the `apps` array (for
// status/name/archived metadata), and produces a flat list of plotted dots with normalized
// coordinates, the world bounds, and a count. Apps missing a layout position are skipped
// (defensive — every active/archived app should have one). Handles empty/non-array inputs by
// returning an empty, bounds-null view.
//
// `opts.geography` (default false) folds the bay/shoreline/harbor anchors into the bounds and
// returns a `geography` view-model (shoreline + harbor in normalized coords). It's opt-in so
// the pure projection tests keep building-only bounds; the live overlay passes `true`.
export function computeMiniMap(apps, positions, opts = {}) {
  const padding = opts.padding ?? MINI_MAP_PADDING;
  const includeGeography = opts.geography === true;
  const appList = Array.isArray(apps) ? apps : [];
  const posMap = positions instanceof Map ? positions : new Map();

  const placed = [];
  for (const app of appList) {
    const pos = posMap.get(app?.id);
    if (!pos) continue;
    placed.push({ app, pos });
  }

  // Geography anchors expand the box so the waterfront is on-frame, but never become dots.
  const boundsPoints = placed.map(({ pos }) => pos);
  if (includeGeography && boundsPoints.length > 0) boundsPoints.push(...geographyWorldPoints());
  const bounds = computeBounds(boundsPoints);

  const dots = placed.map(({ app, pos }) => {
    const { nx, ny } = projectPoint(pos, bounds, padding);
    return {
      id: app.id,
      name: app.name || app.id,
      status: app.archived ? 'archived' : (app.overallStatus || 'not_started'),
      archived: Boolean(app.archived),
      district: pos.district,
      nx,
      ny,
    };
  });

  return {
    dots,
    bounds,
    count: dots.length,
    empty: dots.length === 0,
    geography: includeGeography ? projectGeography(bounds, padding) : null,
  };
}
