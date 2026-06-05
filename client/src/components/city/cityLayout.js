import { BUILDING_PARAMS, DISTRICT_PARAMS, getBuildingHeight } from './cityConstants';
import { autoColumns, gridIndexToPosition } from '../../utils/cityDistrictLayout';

const STATUS_ORDER = { online: 0, stopped: 1, not_started: 2, not_found: 3 };

// Keep downtown buildings off the central AI Core landmark: anything that lands
// inside a one-cell plaza radius is pushed out onto the plaza ring so its
// tower/label doesn't intersect the core. A building exactly at the origin has no
// radial direction, so it starts from a fixed front bearing.
const CORE_CLEARANCE_RADIUS = BUILDING_PARAMS.spacing;
const CENTER_FALLBACK_ANGLE = -Math.PI / 2;

const cleanZero = (n) => (Math.abs(n) < 1e-9 ? 0 : n);
const slotKey = (x, z) => `${Math.round(x)},${Math.round(z)}`;

// Push a cell that sits inside the core plaza out onto the plaza ring, starting
// from its own radial bearing (or the front fallback for a dead-centre cell) and
// fanning out in 45° steps to dodge any slot already taken. Without the dodge, an
// odd×odd grid's centre cell would land on the front-edge cell that's already on
// the ring (e.g. 9 apps → two buildings stacked at (0, -spacing)).
const placeOnPlazaRing = (x, z, occupied) => {
  const baseAngle = (x === 0 && z === 0) ? CENTER_FALLBACK_ANGLE : Math.atan2(z, x);
  const onRing = (angle) => ({
    x: cleanZero(Math.cos(angle) * CORE_CLEARANCE_RADIUS),
    z: cleanZero(Math.sin(angle) * CORE_CLEARANCE_RADIUS),
  });
  for (let step = 0; step < 8; step++) {
    // 0, +45, -45, +90, -90, … — radial bearing first, then fan symmetrically.
    const offset = Math.ceil(step / 2) * (step % 2 === 1 ? 1 : -1) * (Math.PI / 4);
    const slot = onRing(baseAngle + offset);
    if (!occupied.has(slotKey(slot.x, slot.z))) return slot;
  }
  return onRing(baseAngle);
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
  const occupied = new Set();

  // Downtown district (active apps): a roughly-square grid centered on the origin (both axes).
  const activeCols = autoColumns(active.length);
  const activeRows = Math.ceil(active.length / activeCols);

  const downtownCells = active.map((app, i) => {
    const [x, , z] = gridIndexToPosition(i, { columns: activeCols, spacing, rowCount: activeRows });
    return { app, x, z };
  });

  // Pass 1: cells already clear of the plaza keep their grid slot (and reserve it).
  const insidePlaza = [];
  downtownCells.forEach((cell) => {
    if (Math.hypot(cell.x, cell.z) >= CORE_CLEARANCE_RADIUS) {
      occupied.add(slotKey(cell.x, cell.z));
      positions.set(cell.app.id, { x: cell.x, z: cell.z, district: 'downtown', height: getBuildingHeight(cell.app) });
    } else {
      insidePlaza.push(cell);
    }
  });

  // Pass 2: cells inside the plaza get pushed to a free spot on the plaza ring.
  insidePlaza.forEach((cell) => {
    const { x, z } = placeOnPlazaRing(cell.x, cell.z, occupied);
    occupied.add(slotKey(x, z));
    positions.set(cell.app.id, { x, z, district: 'downtown', height: getBuildingHeight(cell.app) });
  });

  // Warehouse district (archived apps): X-centered grid offset along +Z from downtown.
  // The +Z offset follows downtown's depth, but is floored so the near row (and the
  // ARCHIVE DISTRICT label two units in front of it) always clears the central AI Core
  // plaza. Without the floor, few-/no-active-app installs collapse the warehouse onto
  // the core (all-archived → warehouseZ 4, label at z=2, on top of the monument). The
  // floor is a no-op for normal installs: any layout with 3+ active apps already has
  // activeRows ≥ 2, so warehouseZ is already ≥ CORE_CLEARANCE_RADIUS + gap.
  if (archived.length > 0) {
    const archiveCols = autoColumns(archived.length);
    const warehouseZ = Math.max(
      activeRows * spacing / 2 + DISTRICT_PARAMS.gap,
      CORE_CLEARANCE_RADIUS + DISTRICT_PARAMS.gap,
    );

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
