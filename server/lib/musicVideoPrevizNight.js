/**
 * The previz night: one story clock for a music video set in a world map
 * (lib/worldMap.js), so the people's whole journey is simulated over story
 * time and shots later sample moments of it.
 *
 * `project.previz.night` is `{ startClock, lengthMin, beats: [...] }`:
 * `startClock` is minutes after midnight when story minute 0 happens (19:40 =
 * 1180), `lengthMin` how long the night runs. A beat is one thing some of the
 * cast do: `{ id, kind, subjectIds, startMin, endMin, setId, toSetId, pace }`
 * in story minutes. `stay` keeps them at world set `setId`, drifting between
 * that set's figure marks; `travel` moves them along the world's paths from
 * `setId` to `toSetId` at constant speed (`pace`: walk, run or ride). Between
 * beats a person holds where the last one left them. Nothing here is stored
 * per moment: every pose is computed from the beats.
 *
 * Positions are world meters `[x, y, z]` (y = 0 ground); facing 0 looks along
 * +Z, as in the greyboxes. Browser-safe and pure.
 */
import { activeMusicVideoSubjects, musicVideoPrevizForActiveCast } from './musicVideoCastSelection.js';
import { NIGHT_BEATS_MAX, NIGHT_PACE_METERS_PER_MIN } from './musicVideoPrevizLimits.js';

const round = (n) => Math.round(n * 1000) / 1000 + 0;
const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const textOf = (value) => (typeof value === 'string' ? value.trim() : '');
const RIDE_WORDS = /\b(bikes?|bicycles?|cycl(?:e|es|ing)|rid(?:e|es|ing)|pedal\w*)\b/i;
const SIDE_BY_SIDE = 1.2;
const STAY_RADIUS = 2;
const WANDER = 1.2;
const MIN_TRAVEL_MIN = 2;

/** The project's night as the active cast sees it (lib/musicVideoCastSelection.js), or null when it has none. */
export function previzNight(project) {
  const night = musicVideoPrevizForActiveCast(project)?.night;
  return night && Array.isArray(night.beats) && Number.isFinite(night.lengthMin) ? night : null;
}

/** The story clock (minutes after midnight, 0–1439) at story minute `storyMin`. */
export function nightClockAt(night, storyMin) {
  return (((night?.startClock || 0) + storyMin) % 1440 + 1440) % 1440;
}

/** The story minute a clock time (minutes after midnight) falls on, counting past midnight. */
export function nightMinuteOfClock(night, clockMinutes) {
  return ((clockMinutes - (night?.startClock || 0)) % 1440 + 1440) % 1440;
}

// The active cast: one entry per character, the director's chosen alternate (lib/musicVideoCastSelection.js).
const characters = (project) => activeMusicVideoSubjects(project?.concept).filter((subject) => subject?.kind === 'character');
const setById = (world, id) => (world?.sets || []).find((set) => set.id === id) || null;

/** A point in a set's own greybox coordinates (`[x, z]`) placed in the world. */
function setToWorld(set, [x, z]) {
  const t = rad(set.rotationDegrees || 0);
  return [set.position[0] + x * Math.cos(t) + z * Math.sin(t), set.position[1] - x * Math.sin(t) + z * Math.cos(t)];
}

const keyOf = ([x, z]) => `${Math.round(x * 2)},${Math.round(z * 2)}`;

/**
 * The way along the world's paths from one set to another, as ground points
 * `[[x, z], ...]` starting and ending at the sets: the shortest route over the
 * path network, joined at each set's nearest path point. Path points within 2 m
 * of each other count as one junction. A straight line when nothing connects.
 */
function worldRoute(world, fromSetId, toSetId) {
  const from = setById(world, fromSetId);
  const to = setById(world, toSetId);
  if (!from || !to) return [];
  const a = from.position;
  const b = to.position;
  const nodes = new Map();
  const node = (p) => {
    for (const [key, entry] of nodes) if (Math.hypot(entry.p[0] - p[0], entry.p[1] - p[1]) <= 2) return key;
    const key = keyOf(p);
    nodes.set(key, { p, edges: new Map() });
    return key;
  };
  const link = (k1, k2) => {
    if (k1 === k2) return;
    const d = Math.hypot(nodes.get(k1).p[0] - nodes.get(k2).p[0], nodes.get(k1).p[1] - nodes.get(k2).p[1]);
    nodes.get(k1).edges.set(k2, d);
    nodes.get(k2).edges.set(k1, d);
  };
  for (const path of world?.paths || []) {
    let previous = null;
    for (const point of path.points) {
      const key = node(point);
      if (previous) link(previous, key);
      previous = key;
    }
  }
  if (!nodes.size) return [a, b];
  const nearest = (p) => [...nodes.entries()].reduce((best, [key, entry]) => {
    const d = Math.hypot(entry.p[0] - p[0], entry.p[1] - p[1]);
    return !best || d < best.d ? { key, d } : best;
  }, null).key;
  const start = nearest(a);
  const goal = nearest(b);
  const dist = new Map([[start, 0]]);
  const prev = new Map();
  const open = new Set([start]);
  while (open.size) {
    const current = [...open].reduce((best, key) => (best === null || dist.get(key) < dist.get(best) ? key : best), null);
    open.delete(current);
    if (current === goal) break;
    for (const [next, d] of nodes.get(current).edges) {
      const via = dist.get(current) + d;
      if (via < (dist.get(next) ?? Infinity)) { dist.set(next, via); prev.set(next, current); open.add(next); }
    }
  }
  if (!dist.has(goal)) return [a, b];
  const chain = [goal];
  while (chain[0] !== start) chain.unshift(prev.get(chain[0]));
  const points = [a, ...chain.map((key) => nodes.get(key).p), b];
  return points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 0.01);
}

const routeLength = (points) => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);

/** Where along `points` the fraction `f` (0–1) of the way lands, and which way it heads. */
function alongRoute(points, f) {
  if (points.length < 2) return { at: points[0] || [0, 0], heading: 0 };
  const total = routeLength(points);
  let remaining = Math.min(1, Math.max(0, f)) * total;
  for (let i = 1; i < points.length; i += 1) {
    const [ax, az] = points[i - 1];
    const [bx, bz] = points[i];
    const length = Math.hypot(bx - ax, bz - az);
    if (remaining <= length || i === points.length - 1) {
      const t = length ? Math.min(1, remaining / length) : 0;
      return { at: [ax + (bx - ax) * t, az + (bz - az) * t], heading: deg(Math.atan2(bx - ax, bz - az)) };
    }
    remaining -= length;
  }
  return { at: points.at(-1), heading: 0 };
}

const hash = (text) => [...String(text)].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
// Slow, repeatable drift so a person at a stay moves a little, the same on every replay.
const drift = (t, seed) => Math.sin(t * 0.9 + seed) * 0.6 + Math.sin(t * 2.3 + seed * 1.7) * 0.4;

/** Where the people of a stay stand: the set's figure marks, else a ring around its middle. */
function stayMarks(set, greybox, count) {
  const anchors = (greybox?.anchors || []).filter((anchor) => anchor.kind === 'figure');
  return Array.from({ length: count }, (_, i) => {
    const anchor = anchors[i];
    if (anchor) return { at: setToWorld(set, [anchor.position[0], anchor.position[2]]), facing: (anchor.facingDegrees || 0) + (set.rotationDegrees || 0) };
    const angle = (i / Math.max(1, count)) * Math.PI * 2;
    const local = [Math.sin(angle) * STAY_RADIUS, Math.cos(angle) * STAY_RADIUS];
    return { at: setToWorld(set, local), facing: null };
  });
}

function stayPose(beat, set, greybox, subjectId, storyMin) {
  const people = beat.subjectIds || [];
  const index = Math.max(0, people.indexOf(subjectId));
  const marks = stayMarks(set, greybox, people.length || 1);
  const mark = marks[index];
  const seed = hash(subjectId) % 100;
  const at = [mark.at[0] + drift(storyMin / 3, seed) * WANDER, mark.at[1] + drift(storyMin / 3, seed + 13) * WANDER];
  const center = marks.reduce((sum, m) => [sum[0] + m.at[0] / marks.length, sum[1] + m.at[1] / marks.length], [0, 0]);
  const facing = mark.facing ?? (people.length > 1 ? deg(Math.atan2(center[0] - at[0], center[1] - at[1])) : (set.rotationDegrees || 0));
  return { position: [round(at[0]), 0, round(at[1])], facingDegrees: round(facing), pose: 'stand', setId: set.id };
}

function travelPose(world, beat, subjectId, storyMin, routes) {
  const key = `${beat.setId}>${beat.toSetId}`;
  if (!routes.has(key)) routes.set(key, worldRoute(world, beat.setId, beat.toSetId));
  const points = routes.get(key);
  const span = beat.endMin - beat.startMin;
  const { at, heading } = alongRoute(points, span > 0 ? (storyMin - beat.startMin) / span : 1);
  const people = beat.subjectIds || [];
  const slot = Math.max(0, people.indexOf(subjectId)) - (people.length - 1) / 2;
  // Side by side across the way they travel.
  const across = [Math.cos(rad(heading)), -Math.sin(rad(heading))];
  return {
    position: [round(at[0] + across[0] * slot * SIDE_BY_SIDE), 0, round(at[1] + across[1] * slot * SIDE_BY_SIDE)],
    facingDegrees: round(heading), pose: beat.pace === 'ride' ? 'ride' : 'stand', setId: null,
  };
}

/**
 * Where one person is at story minute `storyMin`: `{ position, facingDegrees,
 * pose, setId, beatId }`, or null when no beat names them. Before their first
 * beat they wait at its start; after a beat ends they hold where it left them
 * (at a travel's destination, standing). `places` is the loaded catalog places
 * by id, for each set's figure marks.
 */
function nightPoseAt(project, world, places, subjectId, storyMin, routes) {
  const night = previzNight(project);
  if (!night || !world) return null;
  const beats = night.beats.filter((beat) => (beat.subjectIds || []).includes(subjectId)).sort((a, b) => a.startMin - b.startMin);
  if (!beats.length) return null;
  let beat = beats.find((entry) => entry.startMin <= storyMin && storyMin < entry.endMin);
  let t = storyMin;
  let arrived = false;
  if (!beat) {
    const before = beats.filter((entry) => entry.endMin <= storyMin).at(-1);
    beat = before || beats[0];
    t = before ? before.endMin : beat.startMin;
    arrived = !!before && before.kind === 'travel';
  }
  const greyboxOf = (set) => places?.[set?.ingredientId]?.ingredient?.payload?.greybox || null;
  if (beat.kind === 'travel' && !arrived) {
    const pose = travelPose(world, beat, subjectId, t, routes);
    return { ...pose, beatId: beat.id };
  }
  const set = setById(world, beat.kind === 'travel' ? beat.toSetId : beat.setId);
  if (!set) return null;
  return { ...stayPose(beat.kind === 'travel' ? { ...beat, subjectIds: beat.subjectIds } : beat, set, greyboxOf(set), subjectId, storyMin), beatId: beat.id };
}

// Routes per world object, so playback at 24+ fps never re-solves the path network.
const ROUTES = new WeakMap();
const routesFor = (world) => {
  if (!ROUTES.has(world)) ROUTES.set(world, new Map());
  return ROUTES.get(world);
};

/** Everyone the night names, where they are at `storyMin`, with their names. */
export function nightActorsAt(project, world, places, storyMin) {
  if (!world) return [];
  const routes = routesFor(world);
  return characters(project)
    .map((subject) => {
      const pose = nightPoseAt(project, world, places, subject.id, storyMin, routes);
      return pose && { subjectId: subject.id, name: subject.name, ...pose };
    })
    .filter(Boolean);
}

/** The world set a music video place is, by its catalog link. */
function worldSetForPlace(project, world, placeSubjectId) {
  const subject = (project?.concept?.subjects || []).find((entry) => entry.id === placeSubjectId);
  return subject?.ingredientId ? (world?.sets || []).find((set) => set.ingredientId === subject.ingredientId) || null : null;
}

/**
 * A first night drawn from the shot list: the world sets the shots visit, in
 * song order (a place shot again right after counts once), become stays joined
 * by travels along the paths. A travel takes as long as its route needs at the
 * pace (riding when the shots or route maps talk of bikes), at least two
 * minutes; the rest of the night is shared between the stays by how many shots
 * each has. Everyone in the cast is in every beat. `placeOfShot(scene)` is the
 * place subject id a shot is set in. Returns `{ night, visits }`.
 */
export function draftNightFromShots(project, world, { placeOfShot, newId, startClock = 1200, lengthMin = 480 } = {}) {
  const shots = (project?.scenes || [])
    .filter((scene) => Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) && scene.endSec > scene.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const visits = [];
  for (const scene of shots) {
    const set = worldSetForPlace(project, world, placeOfShot(scene));
    if (!set) continue;
    if (visits.at(-1)?.setId === set.id) visits.at(-1).shots += 1;
    else visits.push({ setId: set.id, shots: 1 });
  }
  const rides = shots.some((scene) => RIDE_WORDS.test(textOf(scene.shotSheet?.action)))
    || (project?.routeMaps || []).some((map) => RIDE_WORDS.test(textOf(map.travel)));
  const pace = rides ? 'ride' : 'walk';
  const subjectIds = characters(project).map((subject) => subject.id);
  const travels = visits.slice(1).map((visit, i) => {
    const meters = routeLength(worldRoute(world, visits[i].setId, visit.setId));
    return Math.max(MIN_TRAVEL_MIN, Math.ceil(meters / NIGHT_PACE_METERS_PER_MIN[pace]));
  });
  const travelTotal = travels.reduce((sum, n) => sum + n, 0);
  const stayTotal = Math.max(visits.length, lengthMin - travelTotal);
  const shotTotal = visits.reduce((sum, visit) => sum + visit.shots, 0) || 1;
  const beats = [];
  let clock = 0;
  visits.forEach((visit, i) => {
    if (beats.length >= NIGHT_BEATS_MAX) return;
    const stay = Math.max(1, Math.round((stayTotal * visit.shots) / shotTotal));
    beats.push({ id: newId(), kind: 'stay', subjectIds, startMin: clock, endMin: clock + stay, setId: visit.setId, toSetId: null, pace: null });
    clock += stay;
    if (i < travels.length && beats.length < NIGHT_BEATS_MAX) {
      beats.push({ id: newId(), kind: 'travel', subjectIds, startMin: clock, endMin: clock + travels[i], setId: visit.setId, toSetId: visits[i + 1].setId, pace });
      clock += travels[i];
    }
  });
  return { night: { startClock, lengthMin: Math.max(lengthMin, clock), beats }, visits: visits.length };
}

/** What is wrong with a beat, as short lines: a set gone from the world, a travel going nowhere, a person in two beats at once. */
export function nightBeatProblems(project, world, beat) {
  const problems = [];
  if (!setById(world, beat.setId)) problems.push('Its set is not on the world map');
  if (beat.kind === 'travel') {
    if (!setById(world, beat.toSetId)) problems.push('Pick where they travel to');
    else if (beat.toSetId === beat.setId) problems.push('It travels to where it starts');
  }
  if (!(beat.subjectIds || []).length) problems.push('Nobody is in it');
  const ids = new Set(characters(project).map((subject) => subject.id));
  if ((beat.subjectIds || []).some((id) => !ids.has(id))) problems.push('Names someone no longer in the video');
  const clash = (previzNight(project)?.beats || []).find((other) => other.id !== beat.id
    && other.startMin < beat.endMin && beat.startMin < other.endMin
    && (other.subjectIds || []).some((id) => (beat.subjectIds || []).includes(id)));
  if (clash) problems.push('Overlaps another beat for the same person');
  return problems;
}
