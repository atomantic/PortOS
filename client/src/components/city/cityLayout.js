import { BUILDING_PARAMS, DISTRICT_PARAMS } from './cityConstants';
import { autoColumns, gridIndexToPosition } from '../../utils/cityDistrictLayout';

const STATUS_ORDER = { online: 0, stopped: 1, not_started: 2, not_found: 3 };

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
    positions.set(app.id, { x, z, district: 'downtown' });
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
      positions.set(app.id, { x, z, district: 'warehouse' });
    });
  }

  return positions;
};
