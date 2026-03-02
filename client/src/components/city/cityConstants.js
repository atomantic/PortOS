// Geist Pixel Square font URL for drei <Text> in 3D scene (TTF required, troika doesn't support woff2)
export const PIXEL_FONT_URL = '/fonts/GeistPixel-Square.ttf';

export const CITY_COLORS = {
  ground: '#06b6d4',
  ambient: '#0d0d2b',
  building: {
    online: '#06b6d4',
    stopped: '#ef4444',
    not_started: '#8b5cf6',
    not_found: '#8b5cf6',
    archived: '#64748b',
  },
  buildingBody: '#0c0c24',
  particles: '#06b6d4',
  stars: '#ffffff',
  // Neon accent palette for building window/decoration variety
  neonAccents: ['#06b6d4', '#ec4899', '#8b5cf6', '#22c55e', '#f97316', '#3b82f6', '#f43f5e', '#a855f7'],
  // Celestial colors
  planet: '#3b82f6',
  orbit: '#1e3a5f',
  // Time-of-day presets (used by CitySky + CityLights)
  // hour: 0-24 mapped to sun arc. Sun traces east(6h) → overhead(12h) → west(18h) → below(0h)
  // daylightFactor: multiplier for scene ambient/point lights (bright day, dim night)
  timeOfDay: {
    sunrise: {
      hour: 6,
      zenith: '#0a0a30',
      midSky: '#1a1040',
      horizonHigh: '#ff6050',
      horizonLow: '#ffaa40',
      sunCore: '#ff8844',
      sunGlow: '#ff6060',
      sunLight: '#ffccaa',
      sunIntensity: 2.0,
      sunScale: 1.0,
      isMoon: false,
      daylightFactor: 0.3,
      groundColor: '#2a2a40',
      groundRoughness: 0.7,
      // Hemisphere sky light (Unreal Engine "sky light" equivalent)
      hemiSkyColor: '#ff9966',
      hemiGroundColor: '#2a1a30',
      hemiIntensity: 0.6,
      ambientColor: '#2a1a3a',
      ambientIntensity: 0.25,
    },
    noon: {
      hour: 12,
      zenith: '#1a4488',
      midSky: '#2266aa',
      horizonHigh: '#4488bb',
      horizonLow: '#5599cc',
      sunCore: '#ffffee',
      sunGlow: '#ffffcc',
      sunLight: '#ffffff',
      sunIntensity: 4.5,
      sunScale: 0.7,
      isMoon: false,
      daylightFactor: 1.0,
      groundColor: '#3a3a50',
      groundRoughness: 0.6,
      hemiSkyColor: '#7799bb',
      hemiGroundColor: '#2a3040',
      hemiIntensity: 1.2,
      ambientColor: '#556688',
      ambientIntensity: 0.35,
    },
    sunset: {
      hour: 18,
      zenith: '#050520',
      midSky: '#1a0a2e',
      horizonHigh: '#ff4060',
      horizonLow: '#ff8040',
      sunCore: '#ffaa44',
      sunGlow: '#ff6080',
      sunLight: '#ffccaa',
      sunIntensity: 1.5,
      sunScale: 1.0,
      isMoon: false,
      daylightFactor: 0.2,
      groundColor: '#1a1830',
      groundRoughness: 0.75,
      hemiSkyColor: '#ff6644',
      hemiGroundColor: '#151520',
      hemiIntensity: 0.4,
      ambientColor: '#1a1a3a',
      ambientIntensity: 0.2,
    },
    midnight: {
      hour: 0,
      zenith: '#020208',
      midSky: '#040412',
      horizonHigh: '#08081a',
      horizonLow: '#0a0a22',
      sunCore: '#ccccee',
      sunGlow: '#8888bb',
      sunLight: '#334466',
      sunIntensity: 0.12,
      sunScale: 0.6,
      isMoon: true,
      daylightFactor: 0.0,
      groundColor: '#0a0a20',
      groundRoughness: 0.85,
      hemiSkyColor: '#111122',
      hemiGroundColor: '#050508',
      hemiIntensity: 0.05,
      ambientColor: '#0a0a1a',
      ambientIntensity: 0.1,
    },
  },
  // Sky themes: visual palette overrides for time-of-day presets
  // 'cyberpunk' uses default timeOfDay colors above
  // 'dreamworld' bright purple/blue open-world sky with clouds
  skyThemes: {
    cyberpunk: null, // uses default timeOfDay colors
    dreamworld: {
      sunrise: {
        hour: 6,
        zenith: '#4a2080',
        midSky: '#6a3aaa',
        horizonHigh: '#ff9070',
        horizonLow: '#ffcc88',
        sunCore: '#ffdd66',
        sunGlow: '#ffaa55',
        sunLight: '#ffeecc',
        sunIntensity: 3.0,
        sunScale: 1.2,
        isMoon: false,
        daylightFactor: 0.5,
        groundColor: '#4a4a60',
        groundRoughness: 0.5,
        hemiSkyColor: '#cc88ff',
        hemiGroundColor: '#4a3a50',
        hemiIntensity: 0.8,
        ambientColor: '#6644aa',
        ambientIntensity: 0.35,
      },
      noon: {
        hour: 12,
        zenith: '#4466cc',
        midSky: '#6688dd',
        horizonHigh: '#88aaee',
        horizonLow: '#aaccff',
        sunCore: '#ffffee',
        sunGlow: '#ffffcc',
        sunLight: '#ffffff',
        sunIntensity: 5.0,
        sunScale: 0.8,
        isMoon: false,
        daylightFactor: 1.0,
        groundColor: '#556680',
        groundRoughness: 0.4,
        hemiSkyColor: '#99bbff',
        hemiGroundColor: '#445566',
        hemiIntensity: 1.6,
        ambientColor: '#7799cc',
        ambientIntensity: 0.5,
      },
      sunset: {
        hour: 18,
        zenith: '#2a1860',
        midSky: '#5530a0',
        horizonHigh: '#ff6088',
        horizonLow: '#ffaa60',
        sunCore: '#ffcc44',
        sunGlow: '#ff8866',
        sunLight: '#ffddbb',
        sunIntensity: 2.5,
        sunScale: 1.2,
        isMoon: false,
        daylightFactor: 0.4,
        groundColor: '#302848',
        groundRoughness: 0.55,
        hemiSkyColor: '#bb6688',
        hemiGroundColor: '#2a2040',
        hemiIntensity: 0.6,
        ambientColor: '#4a2266',
        ambientIntensity: 0.3,
      },
      midnight: {
        hour: 0,
        zenith: '#0a0830',
        midSky: '#161248',
        horizonHigh: '#2a2266',
        horizonLow: '#3a3080',
        sunCore: '#ccccff',
        sunGlow: '#9999dd',
        sunLight: '#556688',
        sunIntensity: 0.3,
        sunScale: 0.7,
        isMoon: true,
        daylightFactor: 0.05,
        groundColor: '#141230',
        groundRoughness: 0.7,
        hemiSkyColor: '#221e55',
        hemiGroundColor: '#0a0818',
        hemiIntensity: 0.1,
        ambientColor: '#1a1644',
        ambientIntensity: 0.15,
      },
    },
  },
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

// Resolve the time-of-day preset for a given sky theme
// Returns theme-specific overrides if available, otherwise default timeOfDay preset
export const getTimeOfDayPreset = (timeOfDay, skyTheme) => {
  const hasOwn = Object.prototype.hasOwnProperty;
  const skyThemes = CITY_COLORS.skyThemes;
  const timeOfDayPresets = CITY_COLORS.timeOfDay;

  if (skyThemes && hasOwn.call(skyThemes, skyTheme)) {
    const themeOverrides = skyThemes[skyTheme];
    if (themeOverrides && hasOwn.call(themeOverrides, timeOfDay)) {
      return themeOverrides[timeOfDay];
    }
  }

  if (timeOfDayPresets && hasOwn.call(timeOfDayPresets, timeOfDay)) {
    return timeOfDayPresets[timeOfDay];
  }

  return timeOfDayPresets.sunset;
};

// Get a deterministic neon accent color per app (for windows/decorations)
export const getAccentColor = (app) => {
  const hash = hashString(app.name || app.id);
  return CITY_COLORS.neonAccents[hash % CITY_COLORS.neonAccents.length];
};
