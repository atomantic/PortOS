/**
 * World map of an Environment (catalog `place`, `payload.world`): one map that
 * places other Environments (the sets, each with its own greybox) and joins
 * them with paths, so a music video's previz can follow people through a
 * whole world instead of one set at a time: a town, a ship, a planet, a golf
 * course. Filler (buildings, fences, open ground, lamps) is generated from each
 * path and the world's seed, never stored.
 *
 * `{ version: 1, seed, setting, sets: [{ id, ingredientId, position: [x, z], rotationDegrees }],
 *    paths: [{ id, kind, sides, width, points: [[x, z], ...] }] }`
 * `setting` decides the light: outdoors (sky and sun by time of day), indoors,
 * or space (absent = outdoors).
 * Units are meters on the ground plane; north is -Z and east is +X, as in the
 * greyboxes. A set's rotation turns its greybox about Y (0 = as modeled).
 * Browser-safe and pure; the save schema lives in worldMapValidation.js.
 */
import { ROUTE_MAP_HEADINGS } from './musicVideoRouteMapLimits.js';

export const WORLD_VERSION = 1;
export const WORLD_LIMITS = Object.freeze({
  SETS: 60,
  PATHS: 80,
  PATH_POINTS: 64,
  COORD: 5000,
  WIDTH_MAX: 40,
  FILL_MAX: 2400,
});
// What a path is: a paved road (with lamps), a footpath, a dirt track, or an indoor corridor (with ceiling lights).
export const WORLD_PATH_KINDS = Object.freeze(['road', 'footpath', 'track', 'corridor']);
// What lines a path: buildings (rooms, on a corridor), a fence (a rail), open ground (fields, lawns, bare floor), or nothing.
export const WORLD_PATH_SIDES = Object.freeze(['buildings', 'fence', 'open', 'none']);
// A road's street infrastructure: overhead pole line with wires, lamps and house drops (the default, also for roads saved before this field), buried lines with streetlight posts only, a sparse rural pole line with wires and no lamps or drops, or none.
export const WORLD_ROAD_INFRASTRUCTURE = Object.freeze(['overhead', 'buried', 'rural', 'none']);
export const WORLD_POLE_SIDES = Object.freeze(['right', 'left']);
export const WORLD_POLE_SPACING = Object.freeze({ min: 10, max: 200 });
export const WORLD_PATH_DEFAULT_WIDTH = Object.freeze({ road: 9, footpath: 2.5, track: 4, corridor: 3 });
// Where the world is, which decides its light.
export const WORLD_SETTINGS = Object.freeze(['outdoor', 'indoor', 'space']);

/** An empty world. */
export const blankWorld = (seed = 1) => ({ version: WORLD_VERSION, seed, sets: [], paths: [] });

/** The place's world map, or null. */
export function placeWorld(ingredient) {
  const world = ingredient?.payload?.world;
  return world && typeof world === 'object' && Array.isArray(world.sets) && Array.isArray(world.paths) ? world : null;
}

const round = (n) => Math.round(n * 100) / 100 + 0;
const HEADING_DEGREES = Object.fromEntries(ROUTE_MAP_HEADINGS.map((heading, i) => [heading, i * 45]));
// Compass degrees (0 = north, 90 = east) to a ground direction: north is -Z.
const compassDir = (deg) => [Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)];
// A greybox's facing 0 looks along +Z (south); a set turned to face compass `deg` rotates by 180 - deg.
const facingRotation = (deg) => ((180 - deg) % 360 + 360) % 360;
const STOP_SPACING = 120;
const SIDE_PATH_LENGTH = 80;
const ROUTE_GAP = 220;

const SET_SIZE = 30;
const SET_GAP = 20;

/**
 * A set's footprint in its own greybox coordinates, `{ x, z, w, d }` meters
 * (corner and size), from its greybox's boxes and planes; a 30 m square when it
 * has none.
 */
export function worldSetFootprint(greybox) {
  const parts = (greybox?.parts || []).filter((part) => part.type === 'box' || part.type === 'plane');
  if (!parts.length) return { x: -SET_SIZE / 2, z: -SET_SIZE / 2, w: SET_SIZE, d: SET_SIZE };
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const part of parts) {
    for (const [x, , z] of partCorners(part)) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  }
  return { x: minX, z: minZ, w: Math.max(2, maxX - minX), d: Math.max(2, maxZ - minZ) };
}

// A box's or plane's corners in its greybox, turned as the viewer draws it
// (three.js 'XYZ' Euler). A plane lies flat until turned, so a backdrop stood
// upright covers only its width on the ground, not its height.
function partCorners(part) {
  const [w, h, d] = part.type === 'plane' ? [part.size[0], 0, part.size[1]] : part.size;
  const [rx, ry, rz] = (part.rotationDegrees || [0, 0, 0]).map((deg) => (deg * Math.PI) / 180);
  const [px, py, pz] = part.position || [0, 0, 0];
  const corners = [];
  for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
    let [x, y, z] = [sx * w, sy * h, sz * d];
    [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
    [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
    [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
    corners.push([px + x, py + y, pz + z]);
  }
  return corners;
}

// How far a set placed at the origin with `rotationDegrees` reaches along world direction `dir`: [min, max].
function reachAlong(box, rotationDegrees, dir) {
  const t = (rotationDegrees * Math.PI) / 180;
  const along = [[box.x, box.z], [box.x + box.w, box.z], [box.x, box.z + box.d], [box.x + box.w, box.z + box.d]]
    .map(([x, z]) => [x * Math.cos(t) + z * Math.sin(t), -x * Math.sin(t) + z * Math.cos(t)])
    .map(([x, z]) => x * dir[0] + z * dir[1]);
  return [Math.min(...along), Math.max(...along)];
}

/**
 * A first world drawn from a music video's route maps: each route's stops laid
 * out along one road in its heading, at least STOP_SPACING apart and never
 * overlapping (`footprints`: `{ [ingredientId]: worldSetFootprint }` of the
 * loaded greyboxes), turned to face the way
 * of travel; side paths branch off where a stop names one; a later route that
 * starts at a placed set continues from it. The video's other places line up
 * beside the routes so they can be dragged into place. Sets need a catalog
 * link (`ingredientId`); `skipped` names the places that have none. `newId`
 * mints ids.
 */
export function draftWorldFromRouteMaps(project, { newId, seed = 1, footprints = {} } = {}) {
  const places = (project?.concept?.subjects || []).filter((subject) => subject?.kind === 'place');
  const bySubject = new Map(places.map((subject) => [subject.id, subject]));
  const world = blankWorld(seed);
  const placedAt = new Map();
  const skipped = new Set();
  const boxOf = (subject) => footprints[subject?.ingredientId] || worldSetFootprint(null);
  const place = (subject, position, compass) => {
    if (!subject.ingredientId) { skipped.add(subject.name || subject.id); return null; }
    if (placedAt.has(subject.ingredientId)) return placedAt.get(subject.ingredientId);
    if (world.sets.length >= WORLD_LIMITS.SETS) return null;
    const at = position.map(round);
    world.sets.push({ id: newId(), ingredientId: subject.ingredientId, position: at, rotationDegrees: facingRotation(compass) });
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
    const turn = facingRotation(compass);
    stops.forEach(({ stop, subject }, i) => {
      // Far enough on that this set's near edge clears the last one's far edge.
      const step = i === 0 ? 0 : Math.max(STOP_SPACING,
        reachAlong(boxOf(stops[i - 1].subject), turn, dir)[1] - reachAlong(boxOf(subject), turn, dir)[0] + SET_GAP);
      const at = i === 0 ? cursor : [cursor[0] + dir[0] * step, cursor[1] + dir[1] * step];
      const placed = place(subject, at, compass) || at.map(round);
      cursor = placed;
      road.push(placed);
      for (const feature of stop.features || []) {
        if (feature.kind !== 'side-street' || feature.side === 'ahead' || world.paths.length >= WORLD_LIMITS.PATHS) continue;
        const side = feature.side === 'left' ? left : [-left[0], -left[1]];
        world.paths.push({ id: newId(), kind: 'road', sides: 'buildings', width: WORLD_PATH_DEFAULT_WIDTH.road, points: [placed, [placed[0] + side[0] * SIDE_PATH_LENGTH, placed[1] + side[1] * SIDE_PATH_LENGTH].map(round)] });
      }
    });
    const points = road.filter((p, i) => i === 0 || p[0] !== road[i - 1][0] || p[1] !== road[i - 1][1]);
    if (points.length >= 2 && world.paths.length < WORLD_LIMITS.PATHS) {
      world.paths.push({ id: newId(), kind: 'road', sides: 'buildings', width: WORLD_PATH_DEFAULT_WIDTH.road, points: points.slice(0, WORLD_LIMITS.PATH_POINTS) });
    }
  }
  // Places no route visits: a row south of everything, to drag into place.
  const loose = places.filter((subject) => subject.ingredientId && !placedAt.has(subject.ingredientId));
  const southmost = Math.max(0, ...[...placedAt.values()].map((p) => p[1]));
  // Each one's width side by side along the row, clear of the routes by the deepest of them.
  const widths = loose.map((subject) => Math.max(60, boxOf(subject).w + SET_GAP));
  const deepest = Math.max(0, ...loose.map((subject) => boxOf(subject).d));
  const total = widths.reduce((sum, w) => sum + w, 0);
  let x = -total / 2;
  loose.forEach((subject, i) => {
    place(subject, [x + widths[i] / 2, southmost + 150 + deepest / 2], 0);
    x += widths[i];
  });
  for (const subject of places) if (!subject.ingredientId) skipped.add(subject.name || subject.id);
  return { world, skipped: [...skipped] };
}

// Deterministic PRNG, so a world's filler is the same on every device and every load.
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

const BUILDING_STEP = 24;
const LAMP_STEP = 36;
const POLE_HEIGHT = 10.5;
const LAMP_HEIGHT = 8;
const FENCE_POST_STEP = 3;
const RURAL_POLE_STEP = 90;
const LAMP_POST_HEIGHT = 6;
// Filler stays clear of a placed set's center by this much, so the set itself shows.
const SET_CLEARANCE = 30;

/**
 * The generated filler along every path, as flat lists the viewer instances.
 * Boxes are `{ position: [x, y, z], size: [w, h, d], rotationDegrees }` (yaw):
 * `buildings`, `fences`, `doors`, `poles` (utility poles, house masts and
 * corridor light posts), `arms` (crossarms and lamp arms), `lamps` (lamp heads),
 * and the ground strips `paving`, `driveways` and `open`. `wires` are segments
 * `[x1, y1, z1, x2, y2, z2]`. A road follows real infrastructure (#15328) per its
 * `infrastructure` (overhead by default, else buried, rural or none): one
 * pole line on its `poleSide` (right by default), wires pole to pole, lamps on arms over the road, a
 * service drop from the nearest pole to each house's roof mast, and every house
 * faces the road with a front door and a driveway. Capped at FILL_MAX each.
 */
export function worldFill(world) {
  const out = { paving: [], driveways: [], buildings: [], doors: [], fences: [], open: [], poles: [], arms: [], lamps: [], wires: [] };
  if (!world) return out;
  const sets = (world.sets || []).map((set) => set.position);
  const clear = (x, z) => sets.every(([sx, sz]) => Math.hypot(x - sx, z - sz) > SET_CLEARANCE);
  const push = (list, item) => { if (list.length < WORLD_LIMITS.FILL_MAX) list.push(item); };
  for (const path of world.paths || []) {
    const rand = mulberry32((world.seed || 1) ^ hashString(path.id));
    const half = path.width / 2;
    const road = path.kind === 'road';
    const infrastructure = road ? path.infrastructure || 'overhead' : null;
    const wired = infrastructure === 'overhead' || infrastructure === 'rural';
    const poleSign = path.poleSide === 'left' ? -1 : 1;
    const poleStep = Math.max(WORLD_POLE_SPACING.min, path.poleSpacing || (infrastructure === 'rural' ? RURAL_POLE_STEP : LAMP_STEP));
    // This road's utility poles in order, and the roof masts their drops feed.
    const poleTops = [];
    const masts = [];
    for (let i = 1; i < path.points.length; i += 1) {
      const [ax, az] = path.points[i - 1];
      const [bx, bz] = path.points[i];
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 0.5) continue;
      const ux = (bx - ax) / length;
      const uz = (bz - az) / length;
      // Side normal (to the right of travel when looking from a to b).
      const nx = -uz;
      const nz = ux;
      const yaw = round((Math.atan2(ux, uz) * 180) / Math.PI);
      push(out.paving, { position: [round((ax + bx) / 2), 0.01, round((az + bz) / 2)], size: [path.width, 0.02, round(length)], rotationDegrees: yaw, kind: path.kind });
      if (path.kind === 'corridor') {
        for (let d = LAMP_STEP / 2; d < length; d += LAMP_STEP) {
          const x = ax + ux * d + nx * (half + 1);
          const z = az + uz * d + nz * (half + 1);
          push(out.poles, { position: [round(x), 2.5, round(z)], size: [0.15, 5, 0.15], rotationDegrees: yaw });
          push(out.lamps, { position: [round(x), 5, round(z)], size: [0.5, 0.25, 0.5], rotationDegrees: yaw });
        }
      } else if (infrastructure === 'buried') {
        // Lines are underground: only free-standing streetlight posts with a short arm over the road.
        for (let d = poleStep / 2; d < length; d += poleStep) {
          const x = ax + ux * d + nx * poleSign * (half + 1.5);
          const z = az + uz * d + nz * poleSign * (half + 1.5);
          push(out.poles, { position: [round(x), LAMP_POST_HEIGHT / 2, round(z)], size: [0.2, LAMP_POST_HEIGHT, 0.2], rotationDegrees: yaw });
          push(out.arms, { position: [round(x - nx * poleSign * 0.9), LAMP_POST_HEIGHT - 0.1, round(z - nz * poleSign * 0.9)], size: [1.8, 0.1, 0.1], rotationDegrees: yaw });
          push(out.lamps, { position: [round(x - nx * poleSign * 1.8), LAMP_POST_HEIGHT - 0.2, round(z - nz * poleSign * 1.8)], size: [0.6, 0.2, 0.3], rotationDegrees: yaw });
        }
      } else if (wired) {
        // One pole line on the chosen side; overhead adds the lamp arm reaching over the road, rural is poles and wires only.
        for (let d = poleStep / 2; d < length; d += poleStep) {
          const x = ax + ux * d + nx * poleSign * (half + 1.5);
          const z = az + uz * d + nz * poleSign * (half + 1.5);
          push(out.poles, { position: [round(x), POLE_HEIGHT / 2, round(z)], size: [0.3, POLE_HEIGHT, 0.3], rotationDegrees: yaw });
          push(out.arms, { position: [round(x), POLE_HEIGHT - 0.4, round(z)], size: [2.4, 0.12, 0.12], rotationDegrees: yaw });
          if (infrastructure === 'overhead') {
            push(out.arms, { position: [round(x - nx * poleSign * 1.4), LAMP_HEIGHT, round(z - nz * poleSign * 1.4)], size: [2.8, 0.1, 0.1], rotationDegrees: yaw });
            push(out.lamps, { position: [round(x - nx * poleSign * 2.8), LAMP_HEIGHT - 0.1, round(z - nz * poleSign * 2.8)], size: [0.7, 0.2, 0.35], rotationDegrees: yaw });
          }
          poleTops.push({ x, z, nx, nz });
        }
      }
      for (const sign of [1, -1]) {
        if (path.sides === 'buildings') {
          for (let d = BUILDING_STEP / 2; d < length; d += BUILDING_STEP) {
            if (rand() < 0.12) continue;
            const w = 9 + rand() * 4;
            const depth = 9 + rand() * 4;
            const h = 4.5 + rand() * 3;
            // Rooms open straight off a corridor; houses sit back behind a yard.
            const back = half + depth / 2 + (path.kind === 'corridor' ? 0.2 : 7 + rand() * 3);
            const x = ax + ux * d + nx * sign * back;
            const z = az + uz * d + nz * sign * back;
            if (!clear(x, z)) continue;
            push(out.buildings, { position: [round(x), round(h / 2), round(z)], size: [round(w), round(h), round(depth)], rotationDegrees: yaw });
            if (!road) continue;
            // The front (size x is across the road) faces it: a door mid-wall, a driveway beside it to the road edge.
            const fx = x - nx * sign * (w / 2);
            const fz = z - nz * sign * (w / 2);
            push(out.doors, { position: [round(fx - nx * sign * 0.1), 1.05, round(fz - nz * sign * 0.1)], size: [0.2, 2.1, 1], rotationDegrees: yaw });
            const yard = back - w / 2 - half;
            const dx = fx + ux * (depth / 2 - 2) - nx * sign * (yard / 2);
            const dz = fz + uz * (depth / 2 - 2) - nz * sign * (yard / 2);
            push(out.driveways, { position: [round(dx), 0.015, round(dz)], size: [round(yard), 0.02, 3.5], rotationDegrees: yaw });
            if (infrastructure !== 'overhead') continue;
            masts.push([fx, h, fz]);
            push(out.poles, { position: [round(fx), round(h + 0.6), round(fz)], size: [0.08, 1.2, 0.08], rotationDegrees: yaw });
          }
        } else if (path.sides === 'fence') {
          for (let d = 0; d < length; d += FENCE_POST_STEP * 20) {
            const run = Math.min(FENCE_POST_STEP * 20, length - d);
            const mid = d + run / 2;
            const x = ax + ux * mid + nx * sign * (half + 2);
            const z = az + uz * mid + nz * sign * (half + 2);
            if (clear(x, z)) push(out.fences, { position: [round(x), 0.75, round(z)], size: [0.08, 1.5, round(run)], rotationDegrees: yaw });
          }
        } else if (path.sides === 'open') {
          const x = ax + ux * (length / 2) + nx * sign * (half + 60);
          const z = az + uz * (length / 2) + nz * sign * (half + 60);
          push(out.open, { position: [round(x), 0.02, round(z)], size: [118, 0.02, round(length)], rotationDegrees: yaw });
        }
      }
    }
    // Primary wires run crossarm to crossarm along the line; each house's drop comes from its nearest pole.
    for (let i = 1; i < poleTops.length; i += 1) {
      const a = poleTops[i - 1];
      const b = poleTops[i];
      for (const offset of [-1, 1]) {
        push(out.wires, [a.x + a.nx * offset, POLE_HEIGHT - 0.3, a.z + a.nz * offset, b.x + b.nx * offset, POLE_HEIGHT - 0.3, b.z + b.nz * offset].map(round));
      }
    }
    for (const [mx, my, mz] of masts) {
      const pole = poleTops.reduce((best, p) => (!best || Math.hypot(p.x - mx, p.z - mz) < Math.hypot(best.x - mx, best.z - mz) ? p : best), null);
      if (pole) push(out.wires, [pole.x, POLE_HEIGHT - 0.5, pole.z, mx, my + 1.2, mz].map(round));
    }
  }
  return out;
}

/** The world's sets with no catalog place loaded for them, by id (`loadedPlaces`: `{ [ingredientId]: { ingredient } | null }`). */
export function worldProblems(world, loadedPlaces = {}) {
  const problems = [];
  for (const set of world?.sets || []) {
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

// Light that does not follow the clock: under a roof (lamps always on), or in space (one hard sun, black sky).
const FIXED_LIGHT = {
  indoor: { sky: '#15161a', sunIntensity: 0, ambient: 0.55, sunElevation: 60, sunAzimuth: 0, lampsOn: true },
  space: { sky: '#000000', sunIntensity: 1.6, ambient: 0.08, sunElevation: 30, sunAzimuth: 120, lampsOn: false },
};

/**
 * The light at a clock time: `{ sky, sunIntensity, ambient, sunElevation, sunAzimuth, lampsOn }`.
 * Outdoors the sun rises in the east and sets in the west (azimuth in compass
 * degrees); indoors and in space the light is fixed.
 */
export function worldSkyAt(clockMinutes, setting = 'outdoor') {
  if (FIXED_LIGHT[setting]) return { ...FIXED_LIGHT[setting] };
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

/** A unit vector toward the sun of a `worldSkyAt` light, kept a little above the horizon so it never lights from below. */
export function worldSunDirection(sky) {
  const az = (sky.sunAzimuth * Math.PI) / 180;
  const el = (sky.sunElevation * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.max(0.05, Math.sin(el)), -Math.cos(az) * Math.cos(el)];
}

/** "21:30" for minutes after midnight. */
export function worldClockText(clockMinutes) {
  const t = ((Math.round(Number(clockMinutes) || 0) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
