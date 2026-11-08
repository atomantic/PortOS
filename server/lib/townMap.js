/**
 * Town map of an Environment (catalog `place`, `payload.town`): one map that
 * places other Environments (the sets, each with its own greybox) and joins
 * them with streets, so a music video's previz can follow people through a
 * whole town instead of one set at a time. Filler (houses, fences, fields,
 * lamps) is generated from each street and the town's seed, never stored.
 *
 * `{ version: 1, seed, sets: [{ id, ingredientId, position: [x, z], rotationDegrees }],
 *    streets: [{ id, kind, sides, width, points: [[x, z], ...] }] }`
 * Units are meters on the ground plane; north is -Z and east is +X, as in the
 * greyboxes. A set's rotation turns its greybox about Y (0 = as modeled).
 * Browser-safe and pure; the save schema lives in townMapValidation.js.
 */
import { ROUTE_MAP_HEADINGS } from './musicVideoRouteMapLimits.js';

export const TOWN_VERSION = 1;
export const TOWN_LIMITS = Object.freeze({
  SETS: 60,
  STREETS: 80,
  STREET_POINTS: 64,
  COORD: 5000,
  WIDTH_MAX: 40,
  FILL_MAX: 2400,
});
// What a street is: a paved road (with lamps), a footpath, or a dirt track across open ground.
export const TOWN_STREET_KINDS = Object.freeze(['road', 'path', 'track']);
// What lines a street: houses, a fence, open fields, or nothing.
export const TOWN_STREET_SIDES = Object.freeze(['houses', 'fence', 'fields', 'none']);
export const TOWN_STREET_DEFAULT_WIDTH = Object.freeze({ road: 9, path: 2.5, track: 4 });

/** An empty town. */
export const blankTown = (seed = 1) => ({ version: TOWN_VERSION, seed, sets: [], streets: [] });

/** The place's town map, or null. */
export function placeTown(ingredient) {
  const town = ingredient?.payload?.town;
  return town && typeof town === 'object' && Array.isArray(town.sets) && Array.isArray(town.streets) ? town : null;
}

const round = (n) => Math.round(n * 100) / 100 + 0;
const HEADING_DEGREES = Object.fromEntries(ROUTE_MAP_HEADINGS.map((heading, i) => [heading, i * 45]));
// Compass degrees (0 = north, 90 = east) to a ground direction: north is -Z.
const compassDir = (deg) => [Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)];
// A greybox's facing 0 looks along +Z (south); a set turned to face compass `deg` rotates by 180 - deg.
const facingRotation = (deg) => ((180 - deg) % 360 + 360) % 360;
const STOP_SPACING = 120;
const SIDE_STREET_LENGTH = 80;
const ROUTE_GAP = 220;

/**
 * A first town drawn from a music video's route maps: each route's stops laid
 * out along one road in its heading, STOP_SPACING apart, turned to face the way
 * of travel; side streets branch off where a stop names one; a later route that
 * starts at a placed set continues from it. The video's other places line up
 * beside the routes so they can be dragged into place. Sets need a catalog
 * link (`ingredientId`); `skipped` names the places that have none. `newId`
 * mints ids.
 */
export function draftTownFromRouteMaps(project, { newId, seed = 1 } = {}) {
  const places = (project?.concept?.subjects || []).filter((subject) => subject?.kind === 'place');
  const bySubject = new Map(places.map((subject) => [subject.id, subject]));
  const town = blankTown(seed);
  const placedAt = new Map();
  const skipped = new Set();
  const place = (subject, position, compass) => {
    if (!subject.ingredientId) { skipped.add(subject.name || subject.id); return null; }
    if (placedAt.has(subject.ingredientId)) return placedAt.get(subject.ingredientId);
    if (town.sets.length >= TOWN_LIMITS.SETS) return null;
    const at = position.map(round);
    town.sets.push({ id: newId(), ingredientId: subject.ingredientId, position: at, rotationDegrees: facingRotation(compass) });
    placedAt.set(subject.ingredientId, at);
    return at;
  };
  let lane = 0;
  for (const map of Array.isArray(project?.routeMaps) ? project.routeMaps : []) {
    const compass = HEADING_DEGREES[map.heading] ?? 0;
    const dir = compassDir(compass);
    const left = compassDir(compass - 90);
    const stops = (map.stops || []).map((stop) => ({ stop, subject: bySubject.get(stop.subjectId) })).filter((entry) => entry.subject);
    if (!stops.length) continue;
    const start = placedAt.get(stops[0].subject.ingredientId) || [lane * ROUTE_GAP * left[0], lane * ROUTE_GAP * left[1]];
    if (!placedAt.has(stops[0].subject.ingredientId)) lane += 1;
    let cursor = start;
    const road = [];
    stops.forEach(({ stop, subject }, i) => {
      const at = i === 0 ? cursor : [cursor[0] + dir[0] * STOP_SPACING, cursor[1] + dir[1] * STOP_SPACING];
      const placed = place(subject, at, compass) || at.map(round);
      cursor = placed;
      road.push(placed);
      for (const feature of stop.features || []) {
        if (feature.kind !== 'side-street' || feature.side === 'ahead' || town.streets.length >= TOWN_LIMITS.STREETS) continue;
        const side = feature.side === 'left' ? left : [-left[0], -left[1]];
        town.streets.push({ id: newId(), kind: 'road', sides: 'houses', width: TOWN_STREET_DEFAULT_WIDTH.road, points: [placed, [placed[0] + side[0] * SIDE_STREET_LENGTH, placed[1] + side[1] * SIDE_STREET_LENGTH].map(round)] });
      }
    });
    const points = road.filter((p, i) => i === 0 || p[0] !== road[i - 1][0] || p[1] !== road[i - 1][1]);
    if (points.length >= 2 && town.streets.length < TOWN_LIMITS.STREETS) {
      town.streets.push({ id: newId(), kind: 'road', sides: 'houses', width: TOWN_STREET_DEFAULT_WIDTH.road, points: points.slice(0, TOWN_LIMITS.STREET_POINTS) });
    }
  }
  // Places no route visits: a row south of everything, to drag into place.
  const loose = places.filter((subject) => subject.ingredientId && !placedAt.has(subject.ingredientId));
  const southmost = Math.max(0, ...[...placedAt.values()].map((p) => p[1]));
  loose.forEach((subject, i) => place(subject, [(i - (loose.length - 1) / 2) * 60, southmost + 150], 0));
  for (const subject of places) if (!subject.ingredientId) skipped.add(subject.name || subject.id);
  return { town, skipped: [...skipped] };
}

// Deterministic PRNG, so a town's filler is the same on every device and every load.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashString = (text) => [...text].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 2166136261);

const HOUSE_STEP = 24;
const LAMP_STEP = 36;
const FENCE_POST_STEP = 3;
// Filler stays clear of a placed set's center by this much, so the set itself shows.
const SET_CLEARANCE = 30;

/**
 * The generated filler along every street, as flat lists the viewer instances:
 * `houses` and `fences` are boxes `{ position: [x, y, z], size: [w, h, d], rotationDegrees }`,
 * `fields` are ground strips (boxes of tiny height), `lamps` are `{ position, rotationDegrees }`
 * poles, `paving` is each street segment as a ground strip. Capped at FILL_MAX each.
 */
export function townFill(town) {
  const out = { paving: [], houses: [], fences: [], fields: [], lamps: [] };
  if (!town) return out;
  const sets = (town.sets || []).map((set) => set.position);
  const clear = (x, z) => sets.every(([sx, sz]) => Math.hypot(x - sx, z - sz) > SET_CLEARANCE);
  const push = (list, item) => { if (list.length < TOWN_LIMITS.FILL_MAX) list.push(item); };
  for (const street of town.streets || []) {
    const rand = mulberry32((town.seed || 1) ^ hashString(street.id));
    const half = street.width / 2;
    for (let i = 1; i < street.points.length; i += 1) {
      const [ax, az] = street.points[i - 1];
      const [bx, bz] = street.points[i];
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 0.5) continue;
      const ux = (bx - ax) / length;
      const uz = (bz - az) / length;
      // Side normal (to the right of travel when looking from a to b).
      const nx = -uz;
      const nz = ux;
      const yaw = round((Math.atan2(ux, uz) * 180) / Math.PI);
      push(out.paving, { position: [round((ax + bx) / 2), 0.01, round((az + bz) / 2)], size: [street.width, 0.02, round(length)], rotationDegrees: yaw, kind: street.kind });
      if (street.kind === 'road') {
        for (let d = LAMP_STEP / 2; d < length; d += LAMP_STEP) {
          const x = ax + ux * d + nx * (half + 1);
          const z = az + uz * d + nz * (half + 1);
          push(out.lamps, { position: [round(x), 0, round(z)], rotationDegrees: yaw });
        }
      }
      for (const sign of [1, -1]) {
        if (street.sides === 'houses') {
          for (let d = HOUSE_STEP / 2; d < length; d += HOUSE_STEP) {
            if (rand() < 0.12) continue;
            const w = 9 + rand() * 4;
            const depth = 9 + rand() * 4;
            const h = 4.5 + rand() * 3;
            const back = half + 7 + depth / 2 + rand() * 3;
            const x = ax + ux * d + nx * sign * back;
            const z = az + uz * d + nz * sign * back;
            if (clear(x, z)) push(out.houses, { position: [round(x), round(h / 2), round(z)], size: [round(w), round(h), round(depth)], rotationDegrees: yaw });
          }
        } else if (street.sides === 'fence') {
          for (let d = 0; d < length; d += FENCE_POST_STEP * 20) {
            const run = Math.min(FENCE_POST_STEP * 20, length - d);
            const mid = d + run / 2;
            const x = ax + ux * mid + nx * sign * (half + 2);
            const z = az + uz * mid + nz * sign * (half + 2);
            if (clear(x, z)) push(out.fences, { position: [round(x), 0.75, round(z)], size: [0.08, 1.5, round(run)], rotationDegrees: yaw });
          }
        } else if (street.sides === 'fields') {
          const x = ax + ux * (length / 2) + nx * sign * (half + 60);
          const z = az + uz * (length / 2) + nz * sign * (half + 60);
          push(out.fields, { position: [round(x), 0.02, round(z)], size: [118, 0.02, round(length)], rotationDegrees: yaw });
        }
      }
    }
  }
  return out;
}

/** The town's sets with no catalog place loaded for them, by id (`loadedPlaces`: `{ [ingredientId]: { ingredient } | null }`). */
export function townProblems(town, loadedPlaces = {}) {
  const problems = [];
  for (const set of town?.sets || []) {
    const entry = loadedPlaces[set.ingredientId];
    if (entry === undefined) continue;
    if (!entry?.ingredient) problems.push({ setId: set.id, problem: 'This environment was removed from the catalog' });
    else if (!entry.ingredient.payload?.greybox) problems.push({ setId: set.id, problem: `${entry.ingredient.name} has no greybox yet` });
  }
  return problems;
}

// Sky and light by clock time (minutes after midnight): day, golden hour, dusk, night, dawn.
const SKY_KEYS = [
  { at: 0, sky: [10, 13, 24], sun: 0, ambient: 0.16, elevation: -30 },
  { at: 300, sky: [10, 13, 24], sun: 0, ambient: 0.16, elevation: -18 },
  { at: 345, sky: [52, 58, 92], sun: 0.15, ambient: 0.3, elevation: -4 },
  { at: 390, sky: [236, 160, 110], sun: 0.7, ambient: 0.5, elevation: 4 },
  { at: 480, sky: [150, 190, 230], sun: 1.4, ambient: 0.85, elevation: 25 },
  { at: 1080, sky: [150, 190, 230], sun: 1.4, ambient: 0.85, elevation: 25 },
  { at: 1170, sky: [240, 150, 90], sun: 0.8, ambient: 0.55, elevation: 5 },
  { at: 1215, sky: [70, 60, 100], sun: 0.2, ambient: 0.32, elevation: -4 },
  { at: 1260, sky: [22, 26, 46], sun: 0, ambient: 0.2, elevation: -14 },
  { at: 1440, sky: [10, 13, 24], sun: 0, ambient: 0.16, elevation: -30 },
];
const hex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * The sky at a clock time: `{ sky, sunIntensity, ambient, sunElevation, sunAzimuth, lampsOn }`.
 * The sun rises in the east and sets in the west (azimuth in compass degrees).
 */
export function townSkyAt(clockMinutes) {
  const t = ((Number(clockMinutes) || 0) % 1440 + 1440) % 1440;
  const right = SKY_KEYS.findIndex((key) => key.at > t);
  const b = SKY_KEYS[right];
  const a = SKY_KEYS[right - 1];
  const f = (t - a.at) / (b.at - a.at);
  const mix = (x, y) => x + (y - x) * f;
  const ambient = mix(a.ambient, b.ambient);
  return {
    sky: hex(a.sky.map((v, i) => mix(v, b.sky[i]))),
    sunIntensity: round(mix(a.sun, b.sun)),
    ambient: round(ambient),
    sunElevation: round(mix(a.elevation, b.elevation)),
    sunAzimuth: round(90 + ((t - 360) / 720) * 180),
    lampsOn: ambient < 0.45,
  };
}

/** "21:30" for minutes after midnight. */
export function townClockText(clockMinutes) {
  const t = ((Math.round(Number(clockMinutes) || 0) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
