/**
 * Music Video route maps: an ordered path through several of the video's
 * places (a bike ride down five street stretches, a walk from the car park to
 * the rink), with the way the travellers face, so shots on different stretches
 * keep one direction of travel and one sun.
 *
 * `project.routeMaps[]` is `{ id, name, heading, travel, stops: [{ id, subjectId, note }] }`.
 * A stop names a place subject of the video (`concept.subjects`, usually
 * linked to a catalog environment). Which shots are on a stop is never stored:
 * a shot is on the stop of the place it is set in (its picked set, else the
 * first set reference it sends), so re-planning shots keeps the map current.
 *
 * Each shot on a route gets one labeled "Route" addition in its frame and clip
 * prompts (lib/musicVideoShotPrompt.js). The map itself is drawn from these
 * records in the UI and is never sent as a reference image. Pure.
 */
import { musicVideoConditioningReferences } from './musicVideoConditioning.js';
import { musicVideoReferenceSubjectIds } from './musicVideoCastSelection.js';
import { ROUTE_MAP_HEADINGS, ROUTE_MAP_STOPS_MAX } from './musicVideoRouteMapLimits.js';

const textOf = (value) => (typeof value === 'string' ? value.trim() : '');

/** The project's route maps, tolerating a record with none. */
export const projectRouteMaps = (project) => (Array.isArray(project?.routeMaps) ? project.routeMaps : []);

const placeSubjects = (project) => (project?.concept?.subjects || []).filter((subject) => subject?.kind === 'place');

/**
 * The place a shot is set in: its picked set, else the first place among the
 * references it sends. null when it shows no place of the video.
 */
function shotPlaceId(project, scene) {
  const places = placeSubjects(project);
  if (!places.length || !scene) return null;
  const isPlace = (id) => places.some((place) => place.id === id);
  if (isPlace(scene.setReference?.subjectId)) return scene.setReference.subjectId;
  for (const reference of musicVideoConditioningReferences(project, scene)) {
    const id = musicVideoReferenceSubjectIds(project, reference).find(isPlace);
    if (id) return id;
  }
  return null;
}

/** The route stop a shot is on: `{ map, stop, index }`, or null. The first map naming its place wins. */
function routeMapStopForShot(project, scene) {
  const placeId = shotPlaceId(project, scene);
  if (!placeId) return null;
  for (const map of projectRouteMaps(project)) {
    const index = (map.stops || []).findIndex((stop) => stop.subjectId === placeId);
    if (index >= 0) return { map, stop: map.stops[index], index };
  }
  return null;
}

/** Shots in song order, numbered as the Shots list numbers them (1-based). */
const orderedShots = (project) => [...(project?.scenes || [])]
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  .map((scene, at) => ({ scene, number: at + 1 }));

/**
 * Each stop's shots: `{ [stopId]: number[] }` (1-based shot numbers). A shot
 * whose place is on an earlier map counts there only, as in its prompt.
 */
export function routeMapStopShots(project, map) {
  const byStop = Object.fromEntries((map?.stops || []).map((stop) => [stop.id, []]));
  for (const { scene, number } of orderedShots(project)) {
    const found = routeMapStopForShot(project, scene);
    if (found?.map.id === map?.id) byStop[found.stop.id].push(number);
  }
  return byStop;
}

/** "1-5, 8" for a list of shot numbers. */
export function shotRangesText(numbers = []) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs = [];
  for (const n of sorted) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

/**
 * Stops for a new route, read off the shots: every place the shots visit, in
 * the order they first appear (a place the shots come back to keeps its first
 * position). `fromShot`/`toShot` (1-based, inclusive) limit it to a stretch of
 * the video. `newId` mints each stop's id.
 */
export function draftRouteMapStops(project, { fromShot = 1, toShot = Infinity, newId } = {}) {
  const seen = new Set();
  const stops = [];
  for (const { scene, number } of orderedShots(project)) {
    if (number < fromShot || number > toShot) continue;
    const placeId = shotPlaceId(project, scene);
    if (!placeId || seen.has(placeId)) continue;
    seen.add(placeId);
    stops.push({ id: newId(), subjectId: placeId, note: '' });
    if (stops.length >= ROUTE_MAP_STOPS_MAX) break;
  }
  return stops;
}

/** Route maps with stops whose place is no longer in the video, or that are named twice: `[{ mapId, stopId, problem }]`. */
export function routeMapProblems(project) {
  const places = new Set(placeSubjects(project).map((place) => place.id));
  const problems = [];
  for (const map of projectRouteMaps(project)) {
    const seen = new Set();
    for (const stop of map.stops || []) {
      if (!places.has(stop.subjectId)) problems.push({ mapId: map.id, stopId: stop.id, problem: 'missing-place' });
      else if (seen.has(stop.subjectId)) problems.push({ mapId: map.id, stopId: stop.id, problem: 'repeated-place' });
      seen.add(stop.subjectId);
    }
  }
  return problems;
}

const placeName = (project, subjectId) => placeSubjects(project).find((place) => place.id === subjectId)?.name || null;

/**
 * The text of a shot's "Route" addition: where on the route it is, which way
 * they travel and what lies either side, so neighbouring shots agree. '' off a
 * route, or on a route of one stop.
 */
export function routeMapShotText(project, scene) {
  const found = routeMapStopForShot(project, scene);
  if (!found) return '';
  const { map, stop } = found;
  const stops = (map.stops || []).filter((entry) => placeName(project, entry.subjectId));
  const at = stops.findIndex((entry) => entry.id === stop.id);
  if (stops.length < 2 || at < 0) return '';
  const here = placeName(project, stop.subjectId);
  const name = textOf(map.name);
  const travel = textOf(map.travel);
  const heading = ROUTE_MAP_HEADINGS.includes(map.heading) ? map.heading : null;
  const before = at > 0 ? placeName(project, stops[at - 1].subjectId) : null;
  const after = at < stops.length - 1 ? placeName(project, stops[at + 1].subjectId) : null;
  const note = textOf(stop.note);
  return [
    `This shot is on ${name ? `the route "${name}"` : 'a route'}, stop ${at + 1} of ${stops.length}: ${here}${note ? ` (${note})` : ''}.`,
    heading ? `Direction of travel: ${heading}.` : '',
    travel ? `${travel.replace(/[.\s]+$/, '')}.` : '',
    before ? `They came from ${before}.` : 'This is where the route starts.',
    after ? `${after} comes next.` : 'This is the end of the route.',
  ].filter(Boolean).join(' ');
}
