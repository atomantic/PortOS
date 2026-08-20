import { hashString } from '../../utils/hashString';

// Drei <Text> needs a TTF; this copy keeps the Geist Pixel glyphs but strips
// layout tables that Troika's font parser logs as unsupported.
export const PIXEL_FONT_URL = '/fonts/GeistPixel-Square-3d.ttf';

export const CITY_COLORS = {
  ground: '#06b6d4',
  ambient: '#0d0d2b',
  building: {
    online: '#06b6d4',
    stopped: '#ef4444',
    not_started: '#8b5cf6',
    not_found: '#8b5cf6',
    // PM2 read failed — status unavailable. A muted amber-gray so it reads as
    // "unknown," distinct from the purple "never launched" buildings.
    unknown: '#9ca3af',
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
  // Time-of-day presets (used by OpenWorldSky + OpenWorldLights)
  // hour: 0-24 mapped to sun arc. Sun traces east(6h) → overhead(12h) → west(18h) → below(0h)
  // daylightFactor: multiplier for scene ambient/point lights (bright day, dim night)
  // NOTE: the city UI now selects only day/night (→ 'noon'/'sunset' via resolveOpenWorldTimeOfDay).
  // 'sunrise' and 'midnight' are retained for legacy stored reads and possible future use,
  // but are no longer reachable from the settings picker.
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
      // Bright daytime sky, but with enough blue/chroma in the horizon bands that
      // the dome reads as sky instead of a white fog sheet over the city.
      zenith: '#0f4f9a',
      midSky: '#1e78bf',
      horizonHigh: '#3d95d2',
      horizonLow: '#58a9dc',
      sunCore: '#fffef2',
      sunGlow: '#fff7d6',
      sunLight: '#fff4e0',
      // Moderate intensities — kept low enough that lit surfaces don't clip to white
      // (the post-process previously bloomed the over-bright scene into a white disc).
      sunIntensity: 1.25,
      sunScale: 0.7,
      isMoon: false,
      daylightFactor: 1.0,
      // Muted blue-gray pavement; daylight + sky reflections otherwise turn the
      // central city plane into a white mirror.
      groundColor: '#3f5268',
      groundRoughness: 0.9,
      // Soft daytime sky fill (blue from above, warm bounce) — gentle, not high-key.
      hemiSkyColor: '#8bb8e0',
      hemiGroundColor: '#8f9488',
      hemiIntensity: 0.65,
      ambientColor: '#8ea4c6',
      ambientIntensity: 0.24,
    },
    sunset: {
      // Theme-night preset: moonlit cyber-night, not blackout. The city should
      // feel nocturnal while still being readable from moonlight and neon bounce.
      hour: 12,
      zenith: '#071329',
      midSky: '#0b1f38',
      horizonHigh: '#251445',
      horizonLow: '#080917',
      sunCore: '#d9ecff',
      sunGlow: '#7bbcff',
      sunLight: '#8fc7ff',
      sunIntensity: 1.1,
      sunScale: 0.72,
      isMoon: true,
      daylightFactor: 0.2,
      groundColor: '#283246',
      groundRoughness: 0.75,
      hemiSkyColor: '#5c8ac6',
      hemiGroundColor: '#121626',
      hemiIntensity: 1.1,
      ambientColor: '#1b2a4a',
      ambientIntensity: 0.55,
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
    // --- Vibes world style ---------------------------------------------------
    // The low-poly bright look: a warm, high-key outdoor world rather than a neon
    // night city. Colors mirror the Vibes open-world reference palette (teal-blue
    // zenith → warm sand horizon, warm sun, cool sky bounce) so the two worlds read
    // as the same art direction. `daylightFactor: 1` puts every dayMix-driven surface
    // (grid, fog, puddles, neon albedo, label ink) fully into its bright form.
    vibesDay: {
      hour: 12,
      zenith: '#4a9ec2',
      midSky: '#5faebf',
      horizonHigh: '#a8cfc4',
      horizonLow: '#f3af78',
      sunCore: '#fff4e2',
      sunGlow: '#ffe4ba',
      sunLight: '#ffe0b8',
      sunIntensity: 1.5,
      sunScale: 0.8,
      isMoon: false,
      daylightFactor: 1.0,
      // Meadow green rather than pavement — the ground plane is a landscape here.
      groundColor: '#86b893',
      groundRoughness: 0.95,
      hemiSkyColor: '#b9e3d8',
      hemiGroundColor: '#3f5c4a',
      hemiIntensity: 1.05,
      ambientColor: '#ffceae',
      ambientIntensity: 0.4,
    },
    // The "night" half of the Vibes style. Deliberately still bright — a golden-hour
    // dusk, not a blackout — so the world keeps its low-poly readability. daylightFactor
    // stays high (0.9) so dayMix ≈ 0.99 and the neon-night surfaces stay suppressed.
    vibesDusk: {
      hour: 18,
      zenith: '#2f6f92',
      midSky: '#71a2b0',
      horizonHigh: '#f0a46f',
      horizonLow: '#f07f6d',
      sunCore: '#ffd9a8',
      sunGlow: '#ffb27a',
      sunLight: '#ffc48f',
      sunIntensity: 1.2,
      sunScale: 1.0,
      isMoon: false,
      daylightFactor: 0.9,
      groundColor: '#6f9b80',
      groundRoughness: 0.95,
      hemiSkyColor: '#9fc7cd',
      hemiGroundColor: '#3a4a3c',
      hemiIntensity: 0.95,
      ambientColor: '#ffc9a2',
      ambientIntensity: 0.45,
    },
  },
  // The OpenWorld uses one canonical cyber sky. Legacy stored skyTheme values are
  // ignored by the scene and fall back to these presets.
  skyThemes: {},
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
    unknown: 1.5,
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

// Resolve a building's color from a status against a building-color map. The map
// defaults to the static CITY_COLORS table; pass a themed palette's `building` map
// (where `online` tracks the theme accent) to follow a theme switch.
export const getBuildingColor = (status, archived, building = CITY_COLORS.building) => {
  if (archived) return building.archived;
  return building[status] || building.not_started;
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

// 0 at night (sunset preset), ramping to 1 at full day (noon). The scene's many
// night-cyberpunk surfaces (post-fx grade, building albedo/neon, ground grid/fog)
// lerp toward a bright daytime look by this factor. The ramp starts at 0.35 so the
// established night look (sunset's daylightFactor 0.2) stays fully at 0/unchanged.
export const openWorldDayMix = (settings) => {
  const preset = getTimeOfDayPreset(settings?.timeOfDay ?? 'sunset', settings?.skyTheme ?? 'cyberpunk');
  return smoothstepRange(0.35, 1, preset?.daylightFactor ?? 0);
};

// Explicit tier rank for the detail gates below. `settings.effectiveTier` is the
// runtime tier selected by the adaptive render budget — a first-class signal that
// replaces the old `particleDensity`-as-quality-proxy (issue #2592).
// When it's absent (older payloads, tests, or code that never set it) we fall back
// to the legacy particleDensity thresholds so behavior is unchanged.
const DETAIL_TIER_RANK = { low: 0, medium: 1, high: 2, ultra: 3 };

// True at medium tier and above — the shared gate for optional set dressing (rooftop
// kits, street furniture, transit trams). The low tier renders structure only.
export const openWorldShowDetail = (settings) => (
  settings?.effectiveTier
    ? (DETAIL_TIER_RANK[settings.effectiveTier] ?? DETAIL_TIER_RANK.high) >= DETAIL_TIER_RANK.medium
    : (settings?.particleDensity ?? 1) > 0.5
);

// True at high tier and above — the gate for the heavier InteriorMappingMaterial
// window panes, which ray-march a fake interior per pane and so cost more than the
// flat window texture. Held one tier above openWorldShowDetail so medium-tier machines
// keep the rest of the set dressing but skip the per-pane interior shader.
export const openWorldShowInteriorWindows = (settings) => (
  settings?.effectiveTier
    ? (DETAIL_TIER_RANK[settings.effectiveTier] ?? DETAIL_TIER_RANK.high) >= DETAIL_TIER_RANK.high
    : (settings?.particleDensity ?? 1) >= 1
);

// Drei <Text> props for an informational in-world label that stays legible in both
// the night-neon scene AND the bright daytime scene. At night (dayMix→0) the label keeps
// its neon fill with a hairline dark keyline so it survives the bright grid and props. As day
// ramps up (dayMix→1) the fill lerps toward a dark ink — readable against the bright
// sky and sunlit mid-tone facades where a glowing neon fill just washes out — and a
// light outline halo fades in to lift the glyphs off whatever's behind them. The ink
// keeps a hint of the label's hue so day labels stay loosely color-coded by status.
// Continuous in dayMix so it degrades gracefully if an intermediate time-of-day is
// ever re-enabled (today dayMix is strictly 0 or 1). Decorative neon signage is NOT
// a caller — it is meant to dim in daylight like real neon.
export const openWorldLabelColors = (neonColor, dayMix = 0) => {
  const d = Math.max(0, Math.min(1, dayMix || 0));
  const darkInk = mixHex('#0d1422', neonColor, 0.22);
  return {
    color: mixHex(neonColor, darkInk, d),
    outlineColor: d > 0 ? '#eef4ff' : '#020817',
    // Percentage strings are relative to fontSize, so the keyline scales with each label.
    // The tiny night keyline is intentionally subdued; daylight gets the stronger halo.
    outlineWidth: `${(0.9 + d * 10.1).toFixed(2)}%`,
    outlineOpacity: 0.45 + d * 0.37,
  };
};

// Get a deterministic neon accent color per app (for windows/decorations). The accent
// list defaults to the static palette; pass a themed palette's `neonAccents` to follow
// a theme switch (its lead entry tracks the theme accent).
export const getAccentColor = (app, neonAccents = CITY_COLORS.neonAccents) => {
  const hash = hashString(app.name || app.id);
  return neonAccents[hash % neonAccents.length];
};

// --- Theme integration -------------------------------------------------------
// OpenWorld's "brand" surfaces (ground grid, particles, online buildings, the
// lead neon accent, the dark structural bases) default to cyan. When the user picks
// a PortOS theme, deriveOpenWorldPalette recolors those surfaces toward the theme accent
// so the 3D scene tracks the rest of the UI; status colors (stopped=red, etc.) stay
// semantic. The palette is a fresh immutable object per theme — every brand surface
// is recomputed from the theme accent (never from a previous theme), so repeated
// switches can't compound. ORIGINAL_GROUND is the fallback accent for a theme with no
// --port-accent; the cyan-era brand defaults are captured up front to recompute from.
const ORIGINAL_GROUND = CITY_COLORS.ground;
const ORIGINAL_BUILDING_BODY = CITY_COLORS.buildingBody;

// Shared color primitives. parseHex: "#0a7a4a" -> [10, 122, 74] (null on bad input).
// toHex: clamps/rounds each channel back to "#rrggbb".
const parseHex = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (r, g, b) => '#' + [r, g, b]
  .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
  .join('');

// "10 122 74" (a --port-* rgb triplet) -> "#0a7a4a"
const tripletToHex = (triplet) => {
  if (typeof triplet !== 'string') return null;
  const parts = triplet.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return toHex(parts[0], parts[1], parts[2]);
};

const darkenHex = (hex, factor) => {
  const rgb = parseHex(hex);
  return rgb ? toHex(rgb[0] * factor, rgb[1] * factor, rgb[2] * factor) : hex;
};

// Mix a hex color t of the way toward white (t in 0..1). Used to derive a bright,
// accent-tinted daytime sky backdrop from the theme accent.
const lightenHex = (hex, t) => {
  const rgb = parseHex(hex);
  return rgb ? toHex(...rgb.map((c) => c + (255 - c) * t)) : hex;
};

// Mix two hex colors (t in 0..1, 0=a, 1=b).
export const mixHex = (a, b, t) => {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return ca && cb ? toHex(...ca.map((c, i) => c + (cb[i] - c) * t)) : a;
};

// Tint a color toward the theme accent by `amount`, then rescale to the original
// luminance so ONLY hue/saturation shift — the scene's brightness hierarchy (dark
// structural bases stay dark, bright sky bands stay bright) is preserved while every
// surface picks up the theme. The accent defaults to the static cyan brand; pass a
// themed palette's accent to track a theme switch. Pure; null-safe.
export const tintTowardAccent = (hex, amount = 0.2, accentHex = CITY_COLORS.ground) => {
  const base = parseHex(hex);
  const accent = parseHex(accentHex);
  if (!base || !accent) return hex;
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const lb = lum(base);
  if (lb === 0) return hex; // pure black has no hue to tint
  const mixed = base.map((c, i) => c + (accent[i] - c) * amount);
  const lm = lum(mixed) || 1;
  const k = lb / lm; // rescale mixed back to the base's luminance
  return toHex(mixed[0] * k, mixed[1] * k, mixed[2] * k);
};

// Convenience for the dark structural bases (building bodies, district plinths,
// monument footings) — a slightly stronger tint than the default. The accent defaults
// to the static brand; pass a themed accent (from useOpenWorldPalette().accent) to theme.
export const tintStructure = (hex, accentHex = CITY_COLORS.ground) => tintTowardAccent(hex, 0.22, accentHex);

// GLSL-style smoothstep with an edge remap (distinct from the plain Hermite
// smoothstep(t) in utils/easing.js — different arity, kept local on purpose).
export const smoothstepRange = (a, b, x) => {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Deterministic Park-Miller LCG. Returns a () => [0,1) generator seeded from an
// integer — the shared form of the inline seeded-random used across city scenery
// so a given seed always yields the same building/terrain layout.
export const seededRand = (seed) => {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s & 0x7fffffff) / 2147483647;
  };
};

// --- World style -------------------------------------------------------------
// OpenWorld renders in one of two art directions, and the style is DATA rather than a
// binary tested in four places: every consumer reads a field off the def below instead of
// asking "is this cyber?". Adding a third style means adding a row here, not editing the
// sky resolver, the palette, the layer gates, and the settings picker.
//
// - presets      the time-of-day pair fed to OpenWorldSky / OpenWorldLights / OpenWorldGround. Through
//                each preset's daylightFactor → openWorldDayMix, this alone carries most of the
//                look: every surface that already lerped night→day follows it for free.
// - lowPoly      flat-shaded, matte structural surfaces (see the palette's `surface`).
// - neonLayers   whether the neon-night scene layers (galaxy spheremap, starfield, shooting
//                stars, data rain, embers, volumetric light cones, neon signage) mount at
//                all. Over a sunlit low-poly landscape they read as haze and grain, so they
//                are gated out rather than faded per-frame.
// - accents      the decorative spread for windows/props. The lead slot is always replaced
//                by the live theme accent, so the world follows the UI in either style.
// - buildingBody the structural body color, re-tinted toward the theme accent.
// - terrain      the daytime bands OpenWorldLandscape's terrain shader mixes between.
//
// 'cyber' is kept as a real option, not nostalgia: it keeps the whole neon layer exercised
// by the suite instead of bit-rotting behind a default nobody selects.
export const WORLD_STYLE_DEFS = {
  vibes: {
    id: 'vibes',
    label: 'OPEN WORLD',
    presets: { day: 'vibesDay', night: 'vibesDusk' },
    lowPoly: true,
    neonLayers: false,
    // Warm sand / coral / teal / sage / amber instead of the cyberpunk neon set, so the
    // bright low-poly world doesn't wear night-club colors.
    accents: ['#63f2db', '#f07f6d', '#d7b98c', '#9873b9', '#f3b562', '#57c9c0', '#8c7169', '#dde4df'],
    // A painted coastal palette: blue-green city soil, sage meadows, and cool stone
    // ridges keep the empty world readable before any live app towers arrive.
    buildingBody: '#7e9e90',
    terrain: { inner: '#6d8f8f', meadow: '#91b983', ridge: '#7896a2' },
  },
  cyber: {
    id: 'cyber',
    label: 'CYBER CITY',
    presets: { day: 'noon', night: 'sunset' },
    lowPoly: false,
    neonLayers: true,
    accents: CITY_COLORS.neonAccents,
    buildingBody: ORIGINAL_BUILDING_BODY,
    terrain: { inner: '#686d68', meadow: '#6f8758', ridge: '#8d937f' },
  },
};

export const WORLD_STYLES = Object.keys(WORLD_STYLE_DEFS);
export const DEFAULT_WORLD_STYLE = 'vibes';

// Sentinel-safe: an absent / legacy / misspelled stored value resolves to the default
// rather than silently selecting an undefined style.
export const resolveWorldStyle = (style) => (
  Object.hasOwn(WORLD_STYLE_DEFS, style) ? style : DEFAULT_WORLD_STYLE
);

// The style's definition, always a real one.
export const getWorldStyle = (style) => WORLD_STYLE_DEFS[resolveWorldStyle(style)];

// OpenWorld renders just two times of day — day and night — and follows the active
// theme's mode by default ('auto'). The user can still force 'day'/'night'. Legacy
// stored values (sunrise/noon/sunset/midnight) are treated as 'auto' so existing
// installs pick up theme coupling without a migration. Open World uses its selected
// preset pair; Cyber City is intentionally locked to its moonlit-night preset because
// its neon materials are authored for darkness.
export const resolveOpenWorldTimeOfDay = (setting, themeIsDay, worldStyle) => {
  const style = getWorldStyle(worldStyle);
  // Cyber City is an explicitly nocturnal art direction. Keeping that invariant here means
  // a theme switch, an old stored time-of-day value, and the settings drawer can never put
  // its neon materials under a daylight preset.
  if (style.id === 'cyber') return { daytime: false, presetKey: style.presets.night };

  const daytime = setting === 'day' ? true
    : setting === 'night' ? false
    : !!themeIsDay;
  return { daytime, presetKey: daytime ? style.presets.day : style.presets.night };
};

// Derive the OpenWorld palette from a PortOS theme object (a THEMES entry) and the
// active world style. Pure. The style swaps the decorative/structural brand surfaces
// (nothing semantic): status colors stay semantic in both worlds.
export const deriveOpenWorldPalette = (theme, worldStyle) => {
  const style = getWorldStyle(worldStyle);
  const { lowPoly } = style;
  const accent = tripletToHex(theme?.colors?.['--port-accent']) || ORIGINAL_GROUND;
  const isDay = theme?.mode === 'day';
  // Night backdrop: a near-black, accent-tinted void — the neon's additive/bloom
  // materials need darkness or they blow out. Day backdrop: a bright, accent-tinted
  // sky (the daytime preset dims the neon, so a light surround is safe and reads as
  // actual daytime). The scene picks one based on the resolved time of day; the HUD
  // panels follow the light/dark theme independently (see .openworld-themed CSS).
  // In the Vibes world there is no neon to protect, and "night" is a golden dusk — so
  // both surrounds are bright sky rather than a near-black void.
  const nightBackground = lowPoly
    ? getTimeOfDayPreset(style.presets.night).midSky
    : darkenHex(accent, 0.1);
  const dayBackground = lowPoly
    ? getTimeOfDayPreset(style.presets.day).midSky
    : lightenHex(accent, 0.72);

  // Themed brand surfaces — recomputed from the theme accent each time, so switching
  // back and forth never compounds. The lead neonAccents entry tracks the accent;
  // the rest of the spread is the world style's decorative palette. The structural
  // body color is re-tinted toward the accent (luminance preserved) so structures
  // track the theme too, not just the accent surfaces. Status colors stay semantic.
  const neonAccents = [accent, ...style.accents.slice(1)];
  const building = { ...CITY_COLORS.building, online: accent };
  const buildingBody = tintStructure(style.buildingBody, accent);

  return {
    themeId: theme?.id || 'classic-midnight',
    mode: theme?.mode || 'night',
    isDay,
    // The active art direction. Scene components read these off the palette they already
    // consume rather than re-resolving the style from settings — one bit, one channel.
    worldStyle: style.id,
    lowPoly,
    neonLayers: style.neonLayers,
    terrain: style.terrain,
    // Material props every structural world mesh spreads so it inherits the art direction
    // instead of hardcoding a finish: `<meshStandardMaterial … {...surface} />`, spread
    // AFTER the mesh's own roughness/metalness so the style wins where it has an opinion.
    // Low-poly worlds read by their facets — flat shading gives each face one normal — and
    // a matte, non-metallic finish keeps buildings looking painted rather than wet like the
    // cyber city's glass. Derived here (not per render) so its identity is stable and r3f
    // never sees a changed material prop; `flatShading` is part of three.js's shader program
    // cache key, so a value that flipped per render would recompile every lit material.
    surface: lowPoly
      ? { flatShading: true, roughness: 0.95, metalness: 0 }
      : { flatShading: false },
    accent,
    nightBackground,
    dayBackground,
    // Default surround by theme mode — used for the loading screen before settings resolve.
    background: isDay ? dayBackground : nightBackground,
    // Brand surfaces the 3D scene reads via useOpenWorldPalette() instead of the old
    // mutated singleton. `ground`/`particles` are the accent; `building`/`buildingBody`/
    // `neonAccents` carry the themed maps.
    ground: accent,
    particles: accent,
    neonAccents,
    building,
    buildingBody,
    // Helper functions pre-bound to this palette's accent/maps, so a consumer can call
    // `palette.tintStructure(hex)` (no accent threading) and still track the theme. These
    // are the themed equivalents of the bare module helpers, which default to the static
    // cyan brand when called without a palette.
    tintTowardAccent: (hex, amount = 0.2) => tintTowardAccent(hex, amount, accent),
    tintStructure: (hex) => tintStructure(hex, accent),
    getBuildingColor: (status, archived) => getBuildingColor(status, archived, building),
    getAccentColor: (app) => getAccentColor(app, neonAccents),
  };
};
