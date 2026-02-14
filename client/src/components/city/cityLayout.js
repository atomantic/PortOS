import { BUILDING_PARAMS, DISTRICT_PARAMS } from './cityConstants';

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

  // Downtown district (active apps) centered at origin
  const activeCols = Math.max(1, Math.ceil(Math.sqrt(active.length)));
  const activeRows = Math.ceil(active.length / activeCols);
  const activeOffsetX = ((activeCols - 1) * spacing) / 2;
  const activeOffsetZ = ((activeRows - 1) * spacing) / 2;

  active.forEach((app, i) => {
    const col = i % activeCols;
    const row = Math.floor(i / activeCols);
    positions.set(app.id, {
      x: col * spacing - activeOffsetX,
      z: row * spacing - activeOffsetZ,
      district: 'downtown',
    });
  });

  // Warehouse district (archived apps) offset along +Z
  if (archived.length > 0) {
    const archiveCols = Math.max(1, Math.ceil(Math.sqrt(archived.length)));
    const archiveRows = Math.ceil(archived.length / archiveCols);
    const archiveOffsetX = ((archiveCols - 1) * spacing) / 2;
    const warehouseZ = activeRows * spacing / 2 + DISTRICT_PARAMS.gap;

    archived.forEach((app, i) => {
      const col = i % archiveCols;
      const row = Math.floor(i / archiveCols);
      positions.set(app.id, {
        x: col * spacing - archiveOffsetX,
        z: warehouseZ + row * spacing,
        district: 'warehouse',
      });
    });
  }

  return positions;
};
