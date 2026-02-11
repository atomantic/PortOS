export const CITY_COLORS = {
  ground: '#06b6d4',
  fog: '#0a0a0f',
  ambient: '#1a1a3e',
  building: {
    online: '#06b6d4',
    stopped: '#f59e0b',
    not_started: '#6366f1',
    not_found: '#6366f1',
    archived: '#334155',
  },
  buildingBody: '#0a0a1e',
  particles: '#06b6d4',
};

export const BUILDING_PARAMS = {
  width: 1.5,
  depth: 1.5,
  spacing: 3.5,
  heights: {
    online: 4,
    stopped: 2,
    not_started: 1.2,
    not_found: 1.2,
    archived: 0.8,
  },
  processHeightBonus: 0.5,
};

export const DISTRICT_PARAMS = {
  warehouseOffset: 18,
  gap: 5,
};

export const getBuildingColor = (status, archived) => {
  if (archived) return CITY_COLORS.building.archived;
  return CITY_COLORS.building[status] || CITY_COLORS.building.not_started;
};

export const getBuildingHeight = (app) => {
  if (app.archived) return BUILDING_PARAMS.heights.archived;
  const base = BUILDING_PARAMS.heights[app.overallStatus] || BUILDING_PARAMS.heights.not_started;
  const processBonus = app.overallStatus === 'online' ? (app.processes?.length || 0) * BUILDING_PARAMS.processHeightBonus : 0;
  return base + processBonus;
};
