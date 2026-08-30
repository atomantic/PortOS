// Pure, deterministic helpers for OpenWorld's mini-map overlay (roadmap 2.8): a top-down
// HUD map that plots every building as a dot at its REAL city-layout position. The layout
// itself comes from `computeOpenWorldLayout(apps)` (the same function OpenWorldScene uses to place
// buildings), so the map can't drift from the actual city. This module only handles the
// projection math — world (x, z) ground coordinates → normalized 0..1 map coordinates for a
// fixed-size map box — plus bounds and empty/degenerate handling. No React / three.js
// imports so the topology stays unit-testable (mirrors openWorldTaskQueue.js).
//
// Geography awareness: every island and Signal Trail causeway is read from the SAME
// archipelago plan (`openWorldPlan.js`) the 3D scene uses. `geographyWorldPoints()` feeds
// the island extents into the map bounds and `projectGeography()` projects the actual
// island/link geometry, so the HUD map cannot drift back into the old rectangular city.

import {
  ARCHIPELAGO_ISLANDS,
  ARCHIPELAGO_LINKS,
  PARCELS,
  archipelagoLinkPoints,
} from './openWorldPlan';

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
// computeOpenWorldLayout. Keeping the filter + minimum-count gate beside the
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

// Keep dense projected markers aimable on compact touch surfaces. The first marker keeps
// its true projection; later markers that land too close are fanned out in a deterministic
// ring so the map remains spatially honest without stacking hit targets invisibly.
export function spreadProjectedPoints(points, { minDistance = 0.075, offset = 0.045 } = {}) {
  const list = Array.isArray(points) ? points : [];
  const placed = [];
  return list.map((point, index) => {
    const nearby = placed.filter((candidate) => {
      const dx = candidate.nx - point.nx;
      const dy = candidate.ny - point.ny;
      return Math.sqrt(dx * dx + dy * dy) < minDistance;
    });
    if (nearby.length === 0) {
      const result = { ...point };
      placed.push(result);
      return result;
    }

    const ring = Math.ceil(nearby.length / 6);
    const slot = nearby.length % 6;
    const angle = (slot / 6) * Math.PI * 2 + index * 0.17;
    const result = {
      ...point,
      nx: clamp01(point.nx + Math.cos(angle) * offset * ring),
      ny: clamp01(point.ny + Math.sin(angle) * offset * ring),
    };
    placed.push(result);
    return result;
  });
}

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// World-space extrema for every island. These are folded into the map bounds so the
// complete playable world remains visible even when the install has few or no app buildings.
export function geographyWorldPoints() {
  return ARCHIPELAGO_ISLANDS.flatMap((island) => {
    const [x, z] = island.center;
    return [
      { x: x - island.radiusX, z },
      { x: x + island.radiusX, z },
      { x, z: z - island.radiusZ },
      { x, z: z + island.radiusZ },
    ];
  });
}

// Normalized (0..1) projection of the authored islands and their Signal Trail links.
export function projectGeography(bounds, padding = MINI_MAP_PADDING) {
  if (!bounds) return null;
  return {
    islands: ARCHIPELAGO_ISLANDS.map((island) => {
      const [x, z] = island.center;
      const center = projectPoint({ x, z }, bounds, padding);
      const edgeX = projectPoint({ x: x + island.radiusX, z }, bounds, padding);
      const edgeZ = projectPoint({ x, z: z + island.radiusZ }, bounds, padding);
      return {
        id: island.id,
        label: island.label,
        biome: island.biome,
        nx: center.nx,
        ny: center.ny,
        radiusX: Math.abs(edgeX.nx - center.nx),
        radiusY: Math.abs(edgeZ.ny - center.ny),
      };
    }),
    links: ARCHIPELAGO_LINKS.map((link) => ({
      id: link.id,
      points: archipelagoLinkPoints(link).map(([x, z]) => projectPoint({ x, z }, bounds, padding)),
    })),
  };
}

// Project the live player pose (position + heading) into normalized mini-map coordinates.
// Returns null when bounds or player position are absent/invalid.
export function projectPlayer(playerPos, heading = 0, bounds = null, padding = MINI_MAP_PADDING) {
  if (!playerPos || typeof playerPos.x !== 'number' || typeof playerPos.z !== 'number' || !bounds) {
    return null;
  }
  const { nx, ny } = projectPoint({ x: playerPos.x, z: playerPos.z }, bounds, padding);
  // Three.js / rover heading increases counter-clockwise (0 faces north / -Z; -π/2 faces east / +X).
  // CSS rotation is clockwise in screen space, so we negate the angle to align the blip's pointer.
  const rotationDeg = -(heading * 180) / Math.PI;
  return { nx, ny, rotationDeg };
}

// Project major district landmarks onto the mini-map
const MAP_LANDMARKS = [
  { id: 'ai-core', parcel: 'aiCore', label: 'AI Core', color: '#06b6d4' },
  { id: 'backup-vault', parcel: 'backupVault', label: 'Vault', color: '#f59e0b' },
  { id: 'task-queue', parcel: 'taskQueue', label: 'Queue', color: '#f97316' },
  { id: 'wellness', parcel: 'health', label: 'Health', color: '#10b981' },
  { id: 'memory', parcel: 'memory', label: 'Memory', color: '#a855f7' },
  { id: 'goals', parcel: 'goals', label: 'Goals', color: '#eab308' },
  { id: 'artifacts', parcel: 'artifacts', label: 'Artifacts', color: '#facc15' },
  { id: 'productivity', parcel: 'productivity', label: 'Productivity', color: '#22c55e' },
];

export function projectLandmarks(bounds, padding = MINI_MAP_PADDING) {
  if (!bounds) return [];
  const results = [];
  for (const lm of MAP_LANDMARKS) {
    const parcel = PARCELS[lm.parcel];
    if (!parcel) continue;
    const { nx, ny } = projectPoint({ x: parcel.anchor[0], z: parcel.anchor[2] }, bounds, padding);
    results.push({
      id: lm.id,
      label: lm.label,
      color: lm.color,
      nx,
      ny,
    });
  }
  return results;
}

// Full derived view-model for the mini-map component. Takes the layout `positions` Map (the
// return value of `computeOpenWorldLayout(apps)`, keyed by app id) plus the `apps` array (for
// status/name/archived metadata), and produces a flat list of plotted dots with normalized
// coordinates, the world bounds, and a count. Apps missing a layout position are skipped
// (defensive — every active/archived app should have one). Handles empty/non-array inputs by
// returning an empty, bounds-null view.
//
// `opts.geography` (default false) folds the whole archipelago into the bounds and returns
// its projected island/link view-model. The live overlay passes `true`.
export function computeMiniMap(apps, positions, opts = {}) {
  const padding = opts.padding ?? MINI_MAP_PADDING;
  const includeGeography = opts.geography === true;
  const includeLandmarks = opts.landmarks === true;
  const appList = Array.isArray(apps) ? apps : [];
  const posMap = positions instanceof Map ? positions : new Map();

  const placed = [];
  for (const app of appList) {
    const pos = posMap.get(app?.id);
    if (!pos) continue;
    placed.push({ app, pos });
  }

  // Geography anchors expand the box to the complete playable world, but never become dots.
  const boundsPoints = placed.map(({ pos }) => pos);
  if (includeGeography) boundsPoints.push(...geographyWorldPoints());
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

  const player = opts.player ? projectPlayer(opts.player.position, opts.player.heading, bounds, padding) : null;
  const landmarks = includeLandmarks ? projectLandmarks(bounds, padding) : [];

  return {
    dots,
    bounds,
    count: dots.length,
    empty: dots.length === 0,
    geography: includeGeography ? projectGeography(bounds, padding) : null,
    player,
    landmarks,
  };
}
