// Geist Pixel Square font URL for drei <Text> in 3D scene (TTF required, troika doesn't support woff2)
export const PIXEL_FONT_URL = '/fonts/GeistPixel-Square.ttf';

export const CITY_COLORS = {
  ground: '#06b6d4',
  fog: '#050510',
  sky: '#030308',
  ambient: '#0d0d2b',
  building: {
    online: '#06b6d4',
    stopped: '#f59e0b',
    not_started: '#6366f1',
    not_found: '#6366f1',
    archived: '#475569',
  },
  buildingBody: '#080816',
  particles: '#06b6d4',
  stars: '#ffffff',
  // Neon accent palette for building window/decoration variety
  neonAccents: ['#06b6d4', '#ec4899', '#8b5cf6', '#22c55e', '#f97316', '#3b82f6', '#f43f5e', '#a855f7'],
  // Celestial colors
  planet: '#3b82f6',
  orbit: '#1e3a5f',
};

export const BOROUGH_PARAMS = {
  processRingRadius: 3.0,    // Distance of process buildings from center
  processMinHeight: 1.5,
  processMaxHeight: 3.5,
};

export const PROCESS_BUILDING_PARAMS = {
  width: 0.8,
  depth: 0.8,
};

export const BUILDING_PARAMS = {
  width: 2.0,
  depth: 2.0,
  spacing: 12.0,
  heights: {
    online: 5,
    stopped: 2.5,
    not_started: 1.5,
    not_found: 1.5,
    archived: 2.0,
  },
  processHeightBonus: 0.8,
  // Height variation: seeded by app name hash for consistent randomness
  heightVariation: 2.5,
};

export const DISTRICT_PARAMS = {
  warehouseOffset: 18,
  gap: 4,
};

// Simple string hash for consistent per-app randomness
const hashString = (str) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

export const getBuildingColor = (status, archived) => {
  if (archived) return CITY_COLORS.building.archived;
  return CITY_COLORS.building[status] || CITY_COLORS.building.not_started;
};

export const getBuildingHeight = (app) => {
  if (app.archived) return BUILDING_PARAMS.heights.archived;
  const base = BUILDING_PARAMS.heights[app.overallStatus] || BUILDING_PARAMS.heights.not_started;
  const processBonus = app.overallStatus === 'online'
    ? (app.processes?.length || 0) * BUILDING_PARAMS.processHeightBonus
    : 0;
  // Add name-based variation so buildings look like a real skyline
  const hash = hashString(app.name || app.id);
  const variation = (hash % 100) / 100 * BUILDING_PARAMS.heightVariation;
  return base + processBonus + variation;
};

// Get a deterministic neon accent color per app (for windows/decorations)
export const getAccentColor = (app) => {
  const hash = hashString(app.name || app.id);
  return CITY_COLORS.neonAccents[hash % CITY_COLORS.neonAccents.length];
};
