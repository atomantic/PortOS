import { BUILDING_PARAMS, DISTRICT_PARAMS, getBuildingHeight } from './cityConstants';
import { autoColumns, gridIndexToPosition } from '../../utils/cityDistrictLayout';

const STATUS_ORDER = { online: 0, stopped: 1, not_started: 2, not_found: 3 };

// Keep downtown buildings off the central AI Core landmark: anything that lands
// inside a one-cell plaza radius is pushed radially out to the plaza edge so its
// tower/label doesn't intersect the core. A building exactly at the origin has no
// direction to push, so it falls back to the front (-Z) edge facing the camera.
const CORE_CLEARANCE_RADIUS = BUILDING_PARAMS.spacing;
const CENTER_FALLBACK_ANGLE = -Math.PI / 2;

const cleanZero = (n) => (Math.abs(n) < 1e-9 ? 0 : n);

const clearCorePlaza = (x, z) => {
  const dist = Math.hypot(x, z);
  if (dist >= CORE_CLEARANCE_RADIUS) return { x, z };

  const angle = dist > 0 ? Math.atan2(z, x) : CENTER_FALLBACK_ANGLE;
  return {
    x: cleanZero(Math.cos(angle) * CORE_CLEARANCE_RADIUS),
    z: cleanZero(Math.sin(angle) * CORE_CLEARANCE_RADIUS),
  };
};

export const computeCityLayout = (apps) => {
  const active = [];
  const archived = [];

  apps.forEach(app => {
    if (app.archived) {
      archived.push(app);
    } else {
      active.push(app);
    }
  });

  // Sort active: online first, then stopped, then not_started
  active.sort((a, b) => (STATUS_ORDER[a.overallStatus] ?? 3) - (STATUS_ORDER[b.overallStatus] ?? 3));

  const positions = new Map();
  const { spacing } = BUILDING_PARAMS;

  // Downtown district (active apps): a roughly-square grid centered on the origin (both axes).
  const activeCols = autoColumns(active.length);
  const activeRows = Math.ceil(active.length / activeCols);

  active.forEach((app, i) => {
    const [x, , z] = gridIndexToPosition(i, { columns: activeCols, spacing, rowCount: activeRows });
    positions.set(app.id, { ...clearCorePlaza(x, z), district: 'downtown', height: getBuildingHeight(app) });
  });

  // Warehouse district (archived apps): X-centered grid offset along +Z from downtown.
  if (archived.length > 0) {
    const archiveCols = autoColumns(archived.length);
    const warehouseZ = activeRows * spacing / 2 + DISTRICT_PARAMS.gap;

    archived.forEach((app, i) => {
      const [x, , z] = gridIndexToPosition(i, {
        columns: archiveCols,
        spacing,
        base: [0, 0, warehouseZ],
      });
      positions.set(app.id, { x, z, district: 'warehouse', height: getBuildingHeight(app) });
    });
  }

  return positions;
};
