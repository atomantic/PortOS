/**
 * Greybox previz for a Music Video: one 3D blocking timeline over the song,
 * played in the browser over each linked place's greybox (catalog
 * `payload.greybox`), so cameras and blocking can be directed before any image
 * is rendered. Nothing here calls a model or renders a file.
 *
 * `project.previz` is `{ cuts: [...], tracks: [...] }`:
 * - a cut is one shot of the previz: `{ id, sceneId, startSec, endSec,
 *   placeSubjectId, viewShotId, holderSubjectId, visibleSubjectIds, aimSubjectId }`.
 *   `sceneId` links it to a shot, whose live timing then wins over the cut's own,
 *   so retiming shots keeps the previz in step. `viewShotId` is a saved greybox
 *   camera of the place (its framing and lens). `holderSubjectId` is the character
 *   holding the camera: the camera rides on that character's track, so it moves
 *   when they do. `visibleSubjectIds` null means everyone on the set except the
 *   holder. `aimSubjectId` is who the camera keeps in frame; with `turnToAim`
 *   the camera starts on its own aim and swings to them during the cut. On a previz with a
 *   world and a timeline (lib/musicVideoPrevizTimeline.js), `storyMin` is the story
 *   minute the cut starts on that timeline: the cut then plays the simulated timeline
 *   from there at real speed (one song second = one story second), and an unheld
 *   camera stands at `cameraSpot` (`[x, z]` world meters) with a long lens.
 * - a track is where one character is in one place over time:
 *   `{ subjectId, placeSubjectId, keys: [{ timeSec, position, facingDegrees, pose, vehicleSubjectId }] }`,
 *   absolute song seconds, linearly interpolated, held before the first and after
 *   the last key. `pose` is stand, walk, run, crouch, sit or 'ride'; 'ride' draws the figure on a proxy of the vehicle `vehicleSubjectId`
 *   names (a catalog object listed in `previz.vehicles`).
 *   A track may also be a cast object's (a prop): it is drawn as a simple proxy
 *   (car, bike lying on its side, or a small box) in each cut whose shot names it,
 *   and carries no pose.
 *
 * A cut on its set is lit by the story clock: the timeline's clock at the cut's
 * `storyMin`, else the time of day its shot sheet states; neither = daylight.
 *
 * Units are the greybox's: meters, Y up, floor y=0; facing 0 looks along +Z.
 * Browser-safe and pure.
 */
import { aspectRatio, DEFAULT_FOCAL_LENGTH_MM } from './greyboxCapture.js';
import { isPreMusicShot } from './musicVideoColdOpen.js';
import { musicVideoShotPlaceId, projectRouteMaps } from './musicVideoRouteMaps.js';
import { SHOT_CAMERA_SET_DOWN } from './musicVideoShotSheet.js';
import { activeMusicVideoSubjects, musicVideoPrevizForActiveCast } from './musicVideoCastSelection.js';
import { timelineActorsAt, timelineClockAt, previzTimeline, previzVehicleInText, previzVehicles, suggestPrevizVehicles } from './musicVideoPrevizTimeline.js';
import { PREVIZ_ACTION_PATHS, PREVIZ_CUTS_MAX, PREVIZ_KEYS_MAX, PREVIZ_PAWN_COLORS, PREVIZ_TRACKS_MAX } from './musicVideoPrevizLimits.js';
import { escapeRegExp } from './textUtils.js';

const EYE_HEIGHT = { stand: 1.6, walk: 1.6, run: 1.5, crouch: 1.0, sit: 1.2, ride: 1.75 };
const CHEST_HEIGHT = { stand: 1.25, walk: 1.25, run: 1.2, crouch: 0.8, sit: 0.95, ride: 1.4 };
const FIGURE_SPACING = 0.9;
// The end key of a cut sits this far before the cut's end, so a figure holds its mark for
// the whole cut instead of sliding toward where it stands in the next one.
const HOLD_EPSILON = 0.001;

const textOf = (value) => (typeof value === 'string' ? value.trim() : '');
const round = (n) => Math.round(n * 1000) / 1000;
const rad = (deg) => (deg * Math.PI) / 180;
const facingDir = (deg) => [Math.sin(rad(deg)), 0, Math.cos(rad(deg))];
const facingToward = (from, to) => round((Math.atan2(to[0] - from[0], to[2] - from[2]) * 180) / Math.PI);

/** The project's previz as the active cast sees it (alternates read as the chosen entry), or null when it has none. */
export function projectPreviz(project) {
  const previz = musicVideoPrevizForActiveCast(project);
  return previz && Array.isArray(previz.cuts) && previz.cuts.length ? previz : null;
}

// The active cast: one entry per character, the director's chosen alternate (lib/musicVideoCastSelection.js).
const characters = (project) => activeMusicVideoSubjects(project?.concept).filter((subject) => subject?.kind === 'character');
const places = (project) => (project?.concept?.subjects || []).filter((subject) => subject?.kind === 'place');
const castObjects = (project) => (project?.concept?.subjects || []).filter((subject) => subject?.kind === 'object');

/** A character subject by the name a shot sheet writes (case and spacing ignored). */
function characterByName(project, name) {
  const wanted = textOf(name).toLowerCase();
  if (!wanted) return null;
  return characters(project).find((subject) => textOf(subject.name).toLowerCase() === wanted) || null;
}

/**
 * Each character's and each vehicle's pawn color, `{ [subjectId]: { figure } }` (palette
 * entries): the director's picks, else the next color no one has, characters first in cast
 * order, then vehicles in the order listed.
 */
export function previzPawnColors(project) {
  const picked = musicVideoPrevizForActiveCast(project)?.pawnColors || {};
  const byId = new Map(PREVIZ_PAWN_COLORS.map((color) => [color.id, color]));
  const taken = new Set(Object.values(picked).map((entry) => entry?.figure).filter(Boolean));
  const free = PREVIZ_PAWN_COLORS.filter((color) => !taken.has(color.id));
  let next = 0;
  const pawns = [...characters(project).map((subject) => subject.id), ...previzVehicles(project).map((vehicle) => vehicle.subjectId)];
  return Object.fromEntries(pawns.map((id, at) => [id, {
    figure: byId.get(picked[id]?.figure) || free[next++] || PREVIZ_PAWN_COLORS[at % PREVIZ_PAWN_COLORS.length],
  }]));
}

/** The pawn fields an actor carries for the vehicle it rides: its object id, name and color (null when on foot). */
function vehicleOf(project, colors, vehicleSubjectId) {
  const vehicle = vehicleSubjectId ? previzVehicles(project).find((entry) => entry.subjectId === vehicleSubjectId) : null;
  return vehicle ? { vehicleSubjectId: vehicle.subjectId, vehicleName: vehicle.name, vehicleColor: colors[vehicle.subjectId]?.figure.hex || null } : { vehicleSubjectId: null, vehicleName: null, vehicleColor: null };
}

/** The place's greybox and its saved cameras, from the loaded catalog places (`{ [ingredientId]: { ingredient, media } }`). */
export function previzPlaceGreybox(project, placeSubjectId, loadedPlaces = {}) {
  const subject = places(project).find((place) => place.id === placeSubjectId);
  const entry = subject?.ingredientId ? loadedPlaces[subject.ingredientId] : null;
  const greybox = entry?.ingredient?.type === 'place' ? entry.ingredient.payload?.greybox : null;
  return greybox && typeof greybox === 'object' ? greybox : null;
}

/**
 * The sets cuts play on that have no greybox, `[{ subject, cuts }]` in cast
 * order with how many cuts use each. A set whose catalog place is still loading
 * is left out, so a loading set never reads as missing.
 */
export function previzSetsWithoutGreybox(project, loadedPlaces = {}) {
  const previz = projectPreviz(project);
  if (!previz) return [];
  const counts = new Map();
  for (const cut of previz.cuts) {
    if (cut.placeSubjectId) counts.set(cut.placeSubjectId, (counts.get(cut.placeSubjectId) || 0) + 1);
  }
  return places(project)
    .filter((subject) => counts.has(subject.id))
    .filter((subject) => !subject.ingredientId || loadedPlaces[subject.ingredientId] !== undefined)
    .filter((subject) => !previzPlaceGreybox(project, subject.id, loadedPlaces))
    .map((subject) => ({ subject, cuts: counts.get(subject.id) }));
}

/** A cut's span on the song clock: its linked shot's live timing, else its own. null when untimed. */
export function previzCutTiming(project, cut) {
  const scene = cut?.sceneId ? (project?.scenes || []).find((entry) => entry.sceneId === cut.sceneId) : null;
  const startSec = scene ? scene.startSec : cut?.startSec;
  const endSec = scene ? scene.endSec : cut?.endSec;
  return Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec ? { startSec, endSec } : null;
}

/** Cuts in song order with their live timing; untimed cuts are left out. */
function previzTimedCuts(project) {
  const previz = projectPreviz(project);
  if (!previz) return [];
  return previz.cuts
    .map((cut) => ({ cut, timing: previzCutTiming(project, cut) }))
    .filter((entry) => entry.timing)
    .sort((a, b) => a.timing.startSec - b.timing.startSec);
}

/** Whether every timed shot has a linked previz cut (the optional Previz step is done). */
export function previzCoversShots(project) {
  const previz = projectPreviz(project);
  if (!previz) return false;
  const linked = new Set(previz.cuts.map((cut) => cut.sceneId).filter(Boolean));
  const shots = timedShots(project);
  return shots.length > 0 && shots.every((scene) => linked.has(scene.sceneId));
}

/** The cut on screen at song time `t`: the last one that has started and not ended. */
function previzCutAt(project, t) {
  let found = null;
  for (const entry of previzTimedCuts(project)) {
    if (entry.timing.startSec <= t + 1e-6 && t < entry.timing.endSec) found = entry;
  }
  return found;
}

// Shots the previz can be built from: timed, on the song's clock, in song order.
const timedShots = (project) => (project?.scenes || [])
  .filter((scene) => !isPreMusicShot(scene) && Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) && scene.endSec > scene.startSec)
  .sort((a, b) => a.startSec - b.startSec);

const cutIdFor = (sceneId) => `cut-${String(sceneId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 56)}`;

/** Who a fresh cut shows and who holds its camera, read off the shot's sheet. */
function cutCastFromSheet(project, scene) {
  const sheet = scene.shotSheet || {};
  const camera = sheet.cameraId ? (project?.cameras || []).find((entry) => entry?.id === sheet.cameraId) : null;
  const holderName = camera?.kind === 'observer' || textOf(sheet.holder) === SHOT_CAMERA_SET_DOWN ? '' : sheet.holder;
  const holder = characterByName(project, holderName);
  const named = (Array.isArray(sheet.characters) ? sheet.characters : [])
    .map((name) => characterByName(project, name)?.id).filter(Boolean);
  const visible = [...new Set(named)].filter((id) => id !== holder?.id);
  return { holderSubjectId: holder?.id || null, visibleSubjectIds: visible.length ? visible : null };
}

/** A new cut for a shot. */
function cutFromShot(project, scene) {
  const placeSubjectId = musicVideoShotPlaceId(project, scene);
  const viewShotId = placeSubjectId && scene.setReference?.subjectId === placeSubjectId ? scene.setReference.greyboxShotId || null : null;
  const actionPath = detectCutActionPath(scene.shotSheet?.action);
  return {
    id: cutIdFor(scene.sceneId), sceneId: scene.sceneId, startSec: scene.startSec, endSec: scene.endSec,
    placeSubjectId: placeSubjectId || null, viewShotId, ...cutCastFromSheet(project, scene), aimSubjectId: null,
    ...(actionPath ? { actionPath } : {}),
  };
}

// Picks a sync derives from the shot sheet, grouped by what the director edits together.
const SHEET_PICK_GROUPS = [['placeSubjectId', 'viewShotId'], ['holderSubjectId'], ['visibleSubjectIds']];
const SHEET_PICKS = SHEET_PICK_GROUPS.flat();
const samePick = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A cut's picks refreshed from the sheet unless the director changed them.
 * `cut.synced` is what the last sync wrote; a group whose current value still
 * equals it was never hand-edited, so it follows the sheet. A cut with no
 * baseline for a group (made before this was tracked) is left alone unless it
 * already matches the sheet, which then becomes the baseline.
 */
function refreshCutFromSheet(project, scene, cut) {
  const fresh = cutFromShot(project, scene);
  const synced = { ...(cut.synced || {}) };
  const next = { ...cut };
  for (const group of SHEET_PICK_GROUPS) {
    const tracked = group.every((key) => key in synced);
    const unchanged = group.every((key) => samePick(cut[key], synced[key]));
    const matchesSheet = group.every((key) => samePick(cut[key], fresh[key]));
    if (!(tracked ? unchanged : matchesSheet)) continue;
    for (const key of group) {
      next[key] = fresh[key];
      synced[key] = fresh[key];
    }
  }
  return { ...next, synced };
}

/** The vehicle the shot shows its people riding: one its sheet's action names, else one named by the travel of the route its place is on. Null on foot. */
function shotVehicle(project, scene, placeSubjectId) {
  // "Bikes dropped on the lawn" and "a sedan passes" name a vehicle nobody in the shot is on: it stays a prop.
  const action = textOf(scene.shotSheet?.action);
  if (PARKED_TEXT.test(action) || (GOES_BY_TEXT.test(action) && !RIDING_VERB.test(action))) return null;
  return previzVehicleInText(project, scene.shotSheet?.action)
    || previzVehicleInText(project, ...projectRouteMaps(project).filter((map) => (map.stops || []).some((stop) => stop.subjectId === placeSubjectId)).map((map) => map.travel));
}

const CROUCH_TEXT = /\b(crouch\w*|squat\w*|kneel\w*|duck(?:s|ed|ing)?\s+(?:down|behind)|(?:hid(?:es|e|ing)|hunch\w*)\s+behind)\b/i;
const SIT_TEXT = /\b(sits?|sitting|sat|seated|perch(?:es|ed)?)\b/i;
const RUN_TEXT = /\b(runs?|running|ran|sprint\w*|dash(?:es|ed|ing)?|flees?|fleeing|fled|races|racing)\b/i;

/** The on-foot pose a shot's action words describe (crouch, sit, run), else null: a shot that names none keeps people standing. */
function previzPoseInText(text) {
  const words = textOf(text);
  if (CROUCH_TEXT.test(words)) return 'crouch';
  if (SIT_TEXT.test(words)) return 'sit';
  if (RUN_TEXT.test(words)) return 'run';
  return null;
}

// A vehicle that goes by the people, unless they are the ones riding ("they ride past").
const GOES_BY_TEXT = /\b(?:pass(?:es|ed|ing)?|(?:drives?|drove|rolls?|rolled|speeds?|sped|cruises?|cruised)\s+(?:by|past)|pulls?\s+up)\b/i;
const RIDING_VERB = /\b(?:rid(?:e|es|ing)|rode|pedal(?:s|ed|ing)?|cycl(?:es|ed|ing)|skat(?:e|es|ed|ing))\b/i;
// A vehicle set down rather than ridden.
const PARKED_TEXT = /\b(?:lying|lies|lie|laid|dropped|parked|abandoned|tipped over|lean(?:s|ed|ing)?\s+against|(?:on|in)\s+the\s+(?:grass|lawn|ground))\b/i;

// Time-of-day words a shot sheet may use, as minutes after midnight.
const CLOCK_WORDS = [
  [/\bmidnight\b/i, 0], [/\b(?:late night|small hours|wee hours)\b/i, 90], [/\b(?:pre-?dawn|before dawn)\b/i, 330],
  [/\b(?:dawn|first light|daybreak)\b/i, 360], [/\bsunrise\b/i, 390], [/\bmorning\b/i, 540], [/\b(?:noon|midday|daylight|daytime)\b/i, 720],
  [/\bafternoon\b/i, 900], [/\bgolden hour\b/i, 1110], [/\bsunset\b/i, 1150], [/\b(?:dusk|twilight|blue hour|nightfall)\b/i, 1190],
  [/\bevening\b/i, 1215], [/\bnight(?:time)?\b/i, 1320],
];
// "21:30", "9:30 pm", "9pm"; a bare number is not a time.
const CLOCK_TIME = /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm|a\.m\.|p\.m\.)?(?![\w:])/gi;

/**
 * The clock time (minutes after midnight) a shot sheet's words state, or null:
 * the earliest clock time or time-of-day word written, so "dusk into night" is dusk.
 */
function previzClockInText(text) {
  const words = textOf(text);
  if (!words) return null;
  let best = null;
  const offer = (index, minutes) => { if (!best || index < best.index) best = { index, minutes }; };
  for (const match of words.matchAll(CLOCK_TIME)) {
    const [, h, m, meridiem] = match;
    if (m === undefined && !meridiem) continue;
    let hour = Number(h);
    if (meridiem) {
      if (hour < 1 || hour > 12) continue;
      hour = (hour % 12) + (/^p/i.test(meridiem) ? 12 : 0);
    } else if (hour > 23) continue;
    offer(match.index, hour * 60 + Number(m || 0));
  }
  for (const [pattern, minutes] of CLOCK_WORDS) {
    const match = pattern.exec(words);
    if (match) offer(match.index, minutes);
  }
  return best ? best.minutes : null;
}

const CAR_NAME = /\b(?:cars?|sedans?|trucks?|vans?|jeeps?|taxis?|cabs?|bus|buses|suvs?|hatchbacks?|coupes?|wagons?|pickups?)\b/i;
const BIKE_NAME = /\b(?:bicycles?|bikes?|bmx|cruisers?|tricycles?|scooters?|motorcycles?|motorbikes?|mopeds?)\b/i;

/** The proxy a cast object is drawn as, by its name: a car, a bike (lying on its side), else a small box. */
function previzPropShape(name) {
  const words = textOf(name);
  if (CAR_NAME.test(words)) return 'car';
  if (BIKE_NAME.test(words)) return 'bike';
  return 'small';
}

const nameMatcher = (word) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}s?(?![\\p{L}\\p{N}])`, 'iu');

/** Whether a text names a cast object: its whole name, or its last word ("the found camcorder" names "Camcorder"; "Silver sedan" is named by "the sedan"). */
function objectNamedIn(subject, text) {
  const name = textOf(subject?.name);
  if (!name || !text) return false;
  const head = name.split(/\s+/).at(-1);
  return nameMatcher(name).test(text) || (head !== name && head.length >= 4 && nameMatcher(head).test(text));
}

// The words of a shot that say what is in it.
const shotWords = (scene) => ['view', 'action', 'light', 'notes'].map((field) => textOf(scene?.shotSheet?.[field])).filter(Boolean).join('\n');

/** The cast objects a shot names (its view, action, light or notes), minus the vehicle its people ride. */
function shotPropIds(project, scene, ridden) {
  const words = shotWords(scene);
  return castObjects(project).filter((subject) => subject.id !== ridden && objectNamedIn(subject, words)).map((subject) => subject.id);
}

/** Everyone a cut stands on its set: the people it picks to show, then the camera's holder. */
function cutPeople(cut) {
  return [...new Set([...(cut.visibleSubjectIds || []), ...(cut.holderSubjectId ? [cut.holderSubjectId] : [])])];
}

/**
 * Where each person stands at the start of a cut, from its saved greybox camera:
 * the camera's own figure marks in order, then a row across the view; the holder
 * stands where the camera is, facing what it looks at.
 */
/** Ground height under (x, z): the y of the greybox anchor nearest in plan, 0 when the set has none. */
function groundHeightAt(greybox, x, z) {
  let best = null;
  for (const anchor of greybox?.anchors || []) {
    const d = Math.hypot(anchor.position[0] - x, anchor.position[2] - z);
    if (!best || d < best.d) best = { d, y: anchor.position[1] || 0 };
  }
  return best ? best.y : 0;
}

/** Camera frustum vectors and tangent half-angles for a saved greybox shot. */
function cameraFrustum(view) {
  const cam = view?.position || [0, 1.6, 6];
  const target = view?.target || [0, 1.2, 0];
  const mm = view?.focalLengthMm || DEFAULT_FOCAL_LENGTH_MM;
  const aspect = aspectRatio(view?.aspect || '16:9');
  const dx = target[0] - cam[0];
  const dy = target[1] - cam[1];
  const dz = target[2] - cam[2];
  const dist = Math.hypot(dx, dy, dz) || 1;
  const fwd = [dx / dist, dy / dist, dz / dist];

  const rLen = Math.hypot(-fwd[2], fwd[0]);
  let right;
  let up;
  if (rLen < 1e-6) {
    right = [1, 0, 0];
    up = [0, 0, fwd[1] > 0 ? -1 : 1];
  } else {
    right = [-fwd[2] / rLen, 0, fwd[0] / rLen];
    up = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0],
    ];
  }
  const tanV = 12 / mm;
  const tanH = tanV * aspect;
  return { cam, target, fwd, right, up, tanV, tanH, dist };
}

/** Whether a figure standing on the ground at [x, y, z] falls inside the camera's view frustum. */
function isFigureInFrustum(pos, frustum, margin = 0.92) {
  const { cam, fwd, right, up, tanV, tanH } = frustum;
  const vx = pos[0] - cam[0];
  const vyFeet = pos[1] - cam[1];
  const vyChest = pos[1] + 1.25 - cam[1];
  const vyHead = pos[1] + 1.7 - cam[1];
  const vz = pos[2] - cam[2];

  const depth = vx * fwd[0] + vyChest * fwd[1] + vz * fwd[2];
  if (depth < 0.2 || depth > 2000) return false;

  const halfH = depth * tanV * margin;
  const halfW = depth * tanH * margin;

  const xCam = vx * right[0] + vyChest * right[1] + vz * right[2];
  if (Math.abs(xCam) > halfW) return false;

  const yCamFeet = vx * up[0] + vyFeet * up[1] + vz * up[2];
  const yCamHead = vx * up[0] + vyHead * up[1] + vz * up[2];
  const yMin = Math.min(yCamFeet, yCamHead);
  const yMax = Math.max(yCamFeet, yCamHead);

  return yMax >= -halfH && yMin <= halfH;
}

/** Find a ground position guaranteed to fall inside the camera view, spaced across the row. */
function findInFrustumPosition(view, greybox, slot = 0, total = 1, nearPos = null) {
  const frustum = cameraFrustum(view);
  const { cam, target, tanH, dist } = frustum;
  const dir = [target[0] - cam[0], 0, target[2] - cam[2]];
  const flatDist = Math.hypot(dir[0], dir[2]) || 1;
  const fwdDir = [dir[0] / flatDist, 0, dir[2] / flatDist];
  const across = [fwdDir[2], 0, -fwdDir[0]];

  if (nearPos && isFigureInFrustum(nearPos, frustum)) {
    const nearDepth = Math.max(2, (nearPos[0] - cam[0]) * fwdDir[0] + (nearPos[2] - cam[2]) * fwdDir[2]);
    const halfW = nearDepth * tanH;
    for (const factor of [1.0, 0.75, 0.5, 0.3]) {
      const spacing = Math.min(FIGURE_SPACING, total > 1 ? (halfW * 0.7) / Math.max(0.5, (total - 1) / 2) : FIGURE_SPACING) * factor;
      for (const sign of [1, -1]) {
        const x = round(nearPos[0] + across[0] * slot * spacing * sign);
        const z = round(nearPos[2] + across[2] * slot * spacing * sign);
        const pos = [x, groundHeightAt(greybox, x, z), z];
        if (isFigureInFrustum(pos, frustum)) return pos;
      }
    }
  }

  const candidates = [dist, flatDist, dist * 0.8, dist * 0.6, dist * 0.4, 6, 10, 15, 20];
  for (const d of candidates) {
    if (d < 1) continue;
    const halfW = d * tanH;
    const spacing = Math.min(FIGURE_SPACING, total > 1 ? (halfW * 0.6) / Math.max(0.5, (total - 1) / 2) : FIGURE_SPACING);
    const x = round(cam[0] + fwdDir[0] * d + across[0] * slot * spacing);
    const z = round(cam[2] + fwdDir[2] * d + across[2] * slot * spacing);
    const pos = [x, groundHeightAt(greybox, x, z), z];
    if (isFigureInFrustum(pos, frustum)) return pos;
  }

  const halfW = dist * tanH;
  const spacing = Math.min(FIGURE_SPACING, total > 1 ? (halfW * 0.5) / Math.max(0.5, (total - 1) / 2) : FIGURE_SPACING);
  return [
    round(target[0] + across[0] * slot * spacing),
    groundHeightAt(greybox, target[0], target[2]),
    round(target[2] + across[2] * slot * spacing),
  ];
}

function seedMarks(cut, greybox, people) {
  const view = (greybox?.shots || []).find((shot) => shot.id === cut.viewShotId) || null;
  const frustum = cameraFrustum(view);
  const anchors = new Map((greybox?.anchors || []).map((anchor) => [anchor.id, anchor]));
  const marks = new Map();
  const shown = people.filter((id) => id !== cut.holderSubjectId);
  const figureMarks = (view?.figures || []).map((figure) => anchors.get(figure.anchorId)).filter((anchor) => anchor?.kind === 'figure');
  const cam = frustum.cam;
  const target = frustum.target;

  shown.forEach((id, i) => {
    const anchor = figureMarks[i];
    if (anchor) {
      const anchorPos = [anchor.position[0], anchor.position[1] || 0, anchor.position[2]];
      if (isFigureInFrustum(anchorPos, frustum)) {
        marks.set(id, { position: anchorPos, facingDegrees: anchor.facingDegrees ?? facingToward(anchorPos, cam) });
        return;
      }
    }
    const slot = i - (shown.length - 1) / 2;
    const refPos = figureMarks[0]?.position;
    const position = findInFrustumPosition(view, greybox, slot, shown.length, refPos);
    marks.set(id, { position, facingDegrees: facingToward(position, cam) });
  });
  if (cut.holderSubjectId) {
    marks.set(cut.holderSubjectId, { position: [cam[0], groundHeightAt(greybox, cam[0], cam[2]), cam[2]], facingDegrees: facingToward(cam, target) });
  }
  return marks;
}

/** Detect an in-set action path keyword from a shot sheet's action wording. */
function detectCutActionPath(action) {
  const text = textOf(action);
  if (!text) return null;
  if (/\b(?:circle|circular|loop)\b/i.test(text)) return 'circle';
  if (/\bpass(?:es|ed|ing)?\b/i.test(text) && (/\btowards?\b/i.test(text) || /\beither side\b/i.test(text))) return 'passes';
  if (/\baway\b/i.test(text)) return 'away';
  if (/\btowards?\b/i.test(text)) return 'toward';
  if (/\bpass(?:es|ed|ing)?\b/i.test(text)) return 'passes';
  return null;
}

/**
 * Build track keys for each person across a cut's duration, seeding an in-set action
 * path (start mark -> end mark, or a loop) from keywords or multiple figure marks.
 */
function seedCutKeys(cut, greybox, people, timing, actionPath, actionText, pose, vehicleSubjectId) {
  const view = (greybox?.shots || []).find((shot) => shot.id === cut.viewShotId) || null;
  const frustum = cameraFrustum(view);
  const anchors = new Map((greybox?.anchors || []).map((anchor) => [anchor.id, anchor]));
  const figureMarks = (view?.figures || []).map((figure) => anchors.get(figure.anchorId)).filter((anchor) => anchor?.kind === 'figure');
  const marks = seedMarks(cut, greybox, people);
  const keysByPerson = new Map();

  const cam = frustum.cam;
  const target = frustum.target;
  const dir = [target[0] - cam[0], 0, target[2] - cam[2]];
  const flatDist = Math.hypot(dir[0], dir[2]) || 1;
  const fwdDir = [dir[0] / flatDist, 0, dir[2] / flatDist];
  const across = [fwdDir[2], 0, -fwdDir[0]];

  const shown = people.filter((id) => id !== cut.holderSubjectId);
  const N = Math.max(1, shown.length);

  if (cut.holderSubjectId && marks.has(cut.holderSubjectId)) {
    const mark = marks.get(cut.holderSubjectId);
    const keys = [{ timeSec: timing.startSec, position: mark.position, facingDegrees: mark.facingDegrees, pose, ...(vehicleSubjectId ? { vehicleSubjectId } : {}) }];
    if (timing.endSec - HOLD_EPSILON > timing.startSec) {
      keys.push({ timeSec: round(timing.endSec - HOLD_EPSILON), position: mark.position, facingDegrees: mark.facingDegrees, pose, ...(vehicleSubjectId ? { vehicleSubjectId } : {}) });
    }
    keysByPerson.set(cut.holderSubjectId, keys);
  }

  shown.forEach((id, i) => {
    const slot = i - (N - 1) / 2;
    const baseMark = marks.get(id);
    const keys = [];

    if (actionPath === 'circle' || actionPath === 'loop' || /\b(?:circle|circular|loop)\b/i.test(actionText)) {
      const center = baseMark ? baseMark.position : findInFrustumPosition(view, greybox, 0, 1);
      const radius = 3.2;
      const isCCW = !/\bclockwise\b/i.test(actionText) || /\bcounter-?clockwise\b/i.test(actionText);
      const baseAngle = i * (2 * Math.PI / N);
      const cutSpan = timing.endSec - HOLD_EPSILON - timing.startSec;

      if (cutSpan >= 0.05) {
        const waypoints = [];
        for (let k = 0; k <= 4; k++) {
          const tSec = k === 0 ? timing.startSec : (k === 4 ? round(timing.endSec - HOLD_EPSILON) : round(timing.startSec + cutSpan * (k / 4)));
          const alpha = baseAngle + (isCCW ? 1 : -1) * (k / 4) * 2 * Math.PI;
          const x = round(center[0] + radius * Math.cos(alpha));
          const z = round(center[2] + radius * (isCCW ? -Math.sin(alpha) : Math.sin(alpha)));
          const y = groundHeightAt(greybox, x, z);
          const nextAlpha = alpha + (isCCW ? 1 : -1) * 0.1;
          const nx = center[0] + radius * Math.cos(nextAlpha);
          const nz = center[2] + radius * (isCCW ? -Math.sin(nextAlpha) : Math.sin(nextAlpha));
          const facing = facingToward([x, y, z], [nx, y, nz]);
          waypoints.push({ timeSec: tSec, position: [x, y, z], facingDegrees: facing });
        }
        if (waypoints.every((wp, idx, all) => idx === 0 || wp.timeSec > all[idx - 1].timeSec)) {
          waypoints.forEach((wp) => keys.push({ ...wp, pose, ...(vehicleSubjectId ? { vehicleSubjectId } : {}) }));
        }
      }
      if (!keys.length) {
        keys.push({ timeSec: timing.startSec, position: baseMark.position, facingDegrees: baseMark.facingDegrees, pose, ...(vehicleSubjectId ? { vehicleSubjectId } : {}) });
        if (timing.endSec - HOLD_EPSILON > timing.startSec) keys.push({ timeSec: round(timing.endSec - HOLD_EPSILON), position: baseMark.position, facingDegrees: baseMark.facingDegrees, pose, ...(vehicleSubjectId ? { vehicleSubjectId } : {}) });
      }
      keysByPerson.set(id, keys);
      return;
    }

    if (actionPath === 'away' || /\baway\b/i.test(actionText)) {
      let startPos, endPos;
      if (N === 1 && figureMarks.length >= 2) {
        const m0 = [figureMarks[0].position[0], figureMarks[0].position[1] || 0, figureMarks[0].position[2]];
        const m1 = [figureMarks[1].position[0], figureMarks[1].position[1] || 0, figureMarks[1].position[2]];
        const d0 = Math.hypot(m0[0] - cam[0], m0[2] - cam[2]);
        const d1 = Math.hypot(m1[0] - cam[0], m1[2] - cam[2]);
        startPos = d0 <= d1 ? m0 : m1;
        endPos = d0 <= d1 ? m1 : m0;
      } else {
        startPos = baseMark.position;
        const moveDist = Math.max(6, Math.min(18, flatDist * 0.8));
        const endX = round(startPos[0] + fwdDir[0] * moveDist);
        const endZ = round(startPos[2] + fwdDir[2] * moveDist);
        endPos = [endX, groundHeightAt(greybox, endX, endZ), endZ];
      }
      const facing = facingToward(startPos, endPos);
      keys.push({ timeSec: timing.startSec, position: startPos, facingDegrees: facing, pose, ...(vehicleSubjectId ? { vehicleSubjectId } : {}) });
      if (timing.endSec - HOLD_EPSILON > timing.startSec) {
        keys.push({ timeSec: round(timing.endSec - HOLD_EPSILON), position: endPos, facingDegrees: facing, pose, ...(vehicleSubjectId ? { vehicleSubjectId } : {}) });
      }
      keysByPerson.set(id, keys);
      return;
    }

    if (actionPath === 'toward' || actionPath === 'passes' || /\btowards?\b/i.test(actionText) || /\bpass(?:es|ed|ing)?\b/i.test(actionText)) {
      const isPasses = actionPath === 'passes' || /\bpass(?:es|ed|ing)?\b/i.test(actionText) || /\beither side\b/i.test(actionText);
      let startPos, endPos;
      if (N === 1 && figureMarks.length >= 2) {
        const m0 = [figureMarks[0].position[0], figureMarks[0].position[1] || 0, figureMarks[0].position[2]];
        const m1 = [figureMarks[1].position[0], figureMarks[1].position[1] || 0, figureMarks[1].position[2]];
        const d0 = Math.hypot(m0[0] - cam[0], m0[2] - cam[2]);
        const d1 = Math.hypot(m1[0] - cam[0], m1[2] - cam[2]);
        startPos = d0 >= d1 ? m0 : m1;
        endPos = d0 >= d1 ? m1 : m0;
      } else {
        const startDepth = Math.max(10, Math.min(25, flatDist + 4));
        const startX = round(cam[0] + fwdDir[0] * startDepth + across[0] * slot * FIGURE_SPACING * 1.5);
        const startZ = round(cam[2] + fwdDir[2] * startDepth + across[2] * slot * FIGURE_SPACING * 1.5);
        startPos = [startX, groundHeightAt(greybox, startX, startZ), startZ];
        if (isPasses) {
          const passOffset = slot === 0 ? 1.5 : (slot > 0 ? 1.5 + slot * 1.2 : -1.5 + slot * 1.2);
          const endX = round(cam[0] - fwdDir[0] * 1.0 + across[0] * passOffset);
          const endZ = round(cam[2] - fwdDir[2] * 1.0 + across[2] * passOffset);
          endPos = [endX, groundHeightAt(greybox, endX, endZ), endZ];
        } else {
          const endDepth = Math.max(3, startDepth * 0.35);
          const endX = round(cam[0] + fwdDir[0] * endDepth + across[0] * slot * FIGURE_SPACING);
          const endZ = round(cam[2] + fwdDir[2] * endDepth + across[2] * slot * FIGURE_SPACING);
          endPos = [endX, groundHeightAt(greybox, endX, endZ), endZ];
        }
      }
      const facing = facingToward(startPos, endPos);
      keys.push({ timeSec: timing.startSec, position: startPos, facingDegrees: facing, pose, ...(vehicleSubjectId ? { vehicleSubjectId } : {}) });
      if (timing.endSec - HOLD_EPSILON > timing.startSec) {
        keys.push({ timeSec: round(timing.endSec - HOLD_EPSILON), position: endPos, facingDegrees: facing, pose, ...(vehicleSubjectId ? { vehicleSubjectId } : {}) });
      }
      keysByPerson.set(id, keys);
      return;
    }

    if (N === 1 && figureMarks.length >= 2) {
      const startPos = [figureMarks[0].position[0], figureMarks[0].position[1] || 0, figureMarks[0].position[2]];
      const endPos = [figureMarks[1].position[0], figureMarks[1].position[1] || 0, figureMarks[1].position[2]];
      const facing = facingToward(startPos, endPos);
      keys.push({ timeSec: timing.startSec, position: startPos, facingDegrees: facing, pose, ...(vehicleSubjectId ? { vehicleSubjectId } : {}) });
      if (timing.endSec - HOLD_EPSILON > timing.startSec) {
        keys.push({ timeSec: round(timing.endSec - HOLD_EPSILON), position: endPos, facingDegrees: figureMarks[1].facingDegrees ?? facing, pose, ...(vehicleSubjectId ? { vehicleSubjectId } : {}) });
      }
      keysByPerson.set(id, keys);
      return;
    }

    const pos = baseMark.position;
    const facing = baseMark.facingDegrees;
    keys.push({ timeSec: timing.startSec, position: pos, facingDegrees: facing, pose, ...(vehicleSubjectId ? { vehicleSubjectId } : {}) });
    if (timing.endSec - HOLD_EPSILON > timing.startSec) {
      keys.push({ timeSec: round(timing.endSec - HOLD_EPSILON), position: pos, facingDegrees: facing, pose, ...(vehicleSubjectId ? { vehicleSubjectId } : {}) });
    }
    keysByPerson.set(id, keys);
  });

  return keysByPerson;
}

const trackKey = (subjectId, placeSubjectId) => `${placeSubjectId}\u0000${subjectId}`;

/**
 * Seed a mark for everyone the given cuts need on their sets (shown cast,
 * holder, aim target) who has no track there yet; existing tracks are never
 * changed. A person first seeded in this pass gets a mark in each later cut
 * of the pass too.
 */
function seedCutTracks(project, existingTracks, cuts, loadedPlaces) {
  const tracks = new Map(existingTracks.map((track) => [trackKey(track.subjectId, track.placeSubjectId), track]));
  const seeded = new Map();
  for (const cut of cuts) {
    const timing = previzCutTiming(project, cut);
    if (!cut.placeSubjectId || !timing) continue;
    const untracked = (id) => !tracks.has(trackKey(id, cut.placeSubjectId));
    const people = [...new Set([...cutPeople(cut), ...(cut.aimSubjectId ? [cut.aimSubjectId] : [])])]
      .filter((id) => characters(project).some((subject) => subject.id === id) && untracked(id));
    const scene = (project?.scenes || []).find((entry) => entry.sceneId === cut.sceneId) || {};
    const vehicleSubjectId = shotVehicle(project, scene, cut.placeSubjectId);
    // Props the shot names get a mark beside its people (a passing car passes with them).
    const props = shotPropIds(project, scene, vehicleSubjectId).filter(untracked);
    if (!people.length && !props.length) continue;
    const pose = vehicleSubjectId ? 'ride' : previzPoseInText(scene.shotSheet?.action) || 'stand';
    const greybox = previzPlaceGreybox(project, cut.placeSubjectId, loadedPlaces);
    const actionText = scene.shotSheet?.action || '';
    const actionPath = cut.actionPath || detectCutActionPath(actionText);
    const keysByPerson = seedCutKeys(cut, greybox, [...people, ...props], timing, actionPath, actionText, pose, vehicleSubjectId);
    const propSet = new Set(props);
    for (const id of [...people, ...props]) {
      const key = trackKey(id, cut.placeSubjectId);
      const track = seeded.get(key) || { subjectId: id, placeSubjectId: cut.placeSubjectId, keys: [] };
      const keys = (keysByPerson.get(id) || []).map((entry) => (propSet.has(id) ? { timeSec: entry.timeSec, position: entry.position, facingDegrees: entry.facingDegrees } : entry));
      track.keys.push(...keys);
      seeded.set(key, track);
    }
  }
  const fresh = [...seeded.values()].map((track) => ({
    ...track,
    keys: [...track.keys].sort((a, b) => a.timeSec - b.timeSec).filter((key, i, all) => i === 0 || key.timeSec > all[i - 1].timeSec).slice(0, PREVIZ_KEYS_MAX),
  }));
  return [...tracks.values(), ...fresh].slice(0, PREVIZ_TRACKS_MAX);
}

/**
 * The previz with one cut replaced by `next` and marks seeded for anyone that
 * cut now needs on its set, so a new set, holder, shown person or aim target
 * plays at once. A holder can't also be the camera's aim target.
 */
export function updatePrevizCut(project, next, loadedPlaces = {}) {
  const previz = projectPreviz(project);
  if (!previz) return null;
  const cut = next.aimSubjectId && next.aimSubjectId === next.holderSubjectId ? { ...next, aimSubjectId: null } : next;
  const before = previz.cuts.find((entry) => entry.id === cut.id);
  const cuts = previz.cuts.map((entry) => (entry.id === cut.id ? cut : entry));
  // Moved to another set with the default cast: the people it showed there come along.
  const seedAs = before && before.placeSubjectId !== cut.placeSubjectId && !Array.isArray(cut.visibleSubjectIds)
    ? { ...cut, visibleSubjectIds: previzCutVisibleIds(project, before) } : cut;
  return { ...previz, cuts, tracks: seedCutTracks({ ...project, previz: { ...previz, cuts } }, previz.tracks || [], [seedAs], loadedPlaces) };
}

/**
 * Build or refresh the previz from the shot list. Every timed shot gets one
 * linked cut; a shot that already has one keeps the picks the director changed
 * by hand, while place, holder and cast still matching what the last sync wrote
 * follow the shot sheet (see refreshCutFromSheet); aim is never synced. Cuts whose shot is gone are dropped, and unlinked
 * cuts are kept. Marks are seeded only for people with no track yet on that
 * set, so hand-made blocking survives a refresh. `loadedPlaces` is the linked
 * catalog places by ingredient id. Returns `{ previz, added, removed }`.
 */
export function backfillPrevizFromShots(sourceProject, loadedPlaces = {}) {
  const forCast = musicVideoPrevizForActiveCast(sourceProject);
  const base = forCast && Array.isArray(forCast.cuts) ? forCast : { cuts: [], tracks: [] };
  // A cast with no listed vehicle gets its obvious ones (a bicycle, a car) listed, so riding shots ride without a hand edit.
  const suggested = base.vehicles?.length ? [] : suggestPrevizVehicles({ ...sourceProject, previz: base });
  const current = suggested.length ? { ...base, vehicles: suggested } : base;
  const project = { ...sourceProject, previz: current };
  const shots = timedShots(project);
  const shotIds = new Set(shots.map((scene) => scene.sceneId));
  const linked = new Map(current.cuts.filter((cut) => cut.sceneId).map((cut) => [cut.sceneId, cut]));
  const added = [];
  const cuts = shots.map((scene) => {
    const existing = linked.get(scene.sceneId);
    if (existing) return { ...refreshCutFromSheet(project, scene, existing), startSec: scene.startSec, endSec: scene.endSec };
    const cut = cutFromShot(project, scene);
    cut.synced = Object.fromEntries(SHEET_PICKS.map((key) => [key, cut[key]]));
    added.push(cut);
    return cut;
  });
  const kept = current.cuts.filter((cut) => !cut.sceneId);
  const removed = current.cuts.filter((cut) => cut.sceneId && !shotIds.has(cut.sceneId)).length;
  const allCuts = [...cuts, ...kept].slice(0, PREVIZ_CUTS_MAX);

  // Every cut is seeded, not just new ones, so a cut whose picks changed since gets its people too.
  const tracks = seedCutTracks(project, current.tracks || [], allCuts, loadedPlaces);
  return { previz: { ...current, cuts: allCuts, tracks }, added: added.length, removed };
}

/**
 * The shots and cuts that play on a given set, in song order.
 * Reads existing previz cuts first; falls back to timed shots whose set reference or conditioning matches.
 */
function previzShotsOnSet(project, placeSubjectId) {
  const previz = projectPreviz(project);
  const scenes = project?.scenes || [];
  if (previz && Array.isArray(previz.cuts) && previz.cuts.length) {
    const setCuts = previz.cuts
      .filter((cut) => cut.placeSubjectId === placeSubjectId)
      .map((cut) => ({ cut, timing: previzCutTiming(project, cut) }))
      .sort((a, b) => (a.timing?.startSec ?? Infinity) - (b.timing?.startSec ?? Infinity));
    if (setCuts.length) {
      return setCuts.map(({ cut, timing }, cutIndex) => {
        const sceneIndex = cut.sceneId ? scenes.findIndex((s) => s.sceneId === cut.sceneId) : -1;
        const scene = sceneIndex >= 0 ? scenes[sceneIndex] : null;
        const shotNumber = sceneIndex >= 0 ? sceneIndex + 1 : cutIndex + 1;
        return { cut, scene, shotNumber, timing };
      });
    }
  }
  const setScenes = timedShots(project)
    .filter((scene) => musicVideoShotPlaceId(project, scene) === placeSubjectId);
  return setScenes.map((scene, i) => {
    const sceneIndex = scenes.findIndex((s) => s.sceneId === scene.sceneId);
    return {
      cut: null,
      scene,
      shotNumber: sceneIndex >= 0 ? sceneIndex + 1 : i + 1,
      timing: { startSec: scene.startSec, endSec: scene.endSec },
    };
  });
}

/**
 * An instruction to draft a greybox for `placeSubjectId` from the shots that play on it:
 * lists each shot in order with its sheet camera, holder and action, asking for one
 * saved camera per shot labeled "Shot N", plus figure marks.
 */
export function previzSetGreyboxDraftInstruction(project, placeSubjectId) {
  const items = previzShotsOnSet(project, placeSubjectId);
  const chars = characters(project);
  if (!items.length) {
    return 'Draft a 3D greybox layout for this set with saved cameras and figure marks.';
  }
  const lines = items.map(({ scene, cut, shotNumber }) => {
    const sheet = scene?.shotSheet || {};
    const cam = (project?.cameras || []).find((c) => c.id === sheet.cameraId);
    const cameraName = cam?.name || sheet.view || sheet.cameraId || '';
    const cameraText = cameraName ? `camera "${cameraName}"` : 'observer camera';
    const holderName = sheet.holder || (cut?.holderSubjectId ? chars.find((c) => c.id === cut.holderSubjectId)?.name : '') || '';
    const holderText = holderName ? `held by "${holderName}"` : 'observer camera';
    const action = sheet.action || scene?.prompt || scene?.framePrompt || '';
    const actionText = action ? `action: "${action}"` : '';
    const cast = (Array.isArray(sheet.characters) && sheet.characters.length
      ? sheet.characters
      : cutPeople(cut || {}).map((id) => chars.find((c) => c.id === id)?.name).filter(Boolean)
    ).filter(Boolean);
    const castText = cast.length ? `people: ${cast.join(', ')}` : '';
    const details = [cameraText, holderText, actionText, castText].filter(Boolean).join(', ');
    return `- Shot ${shotNumber}: ${details}`;
  });

  return [
    'Draft a 3D greybox layout for this set tailored to the following shots in order:',
    ...lines,
    '',
    'Requirements:',
    '- Provide one saved camera per shot labeled "Shot N" (e.g. Shot 1, Shot 2), positioned and aimed to frame the action.',
    '- Place figure mark anchors (kind: "figure") on the floor for the characters in each shot, and link them in that camera\'s figures array.',
  ].join('\n');
}

/**
 * Link each cut for a set to its corresponding camera in `greyboxShots` in order,
 * matching by label "Shot N" (or id), or falling back to the camera at that index.
 */
function linkPrevizCutsToCameras(cuts, greyboxShots = [], scenes = []) {
  return cuts.map((cut, i) => {
    const sceneIndex = cut.sceneId ? scenes.findIndex((s) => s.sceneId === cut.sceneId) : -1;
    const shotNumber = sceneIndex >= 0 ? sceneIndex + 1 : i + 1;
    const matched = greyboxShots.find((shot) => {
      const label = textOf(shot.label);
      const id = textOf(shot.id);
      return new RegExp(`\\bShot\\s*#?${shotNumber}\\b`, 'i').test(label)
        || new RegExp(`^shot[_-]?${shotNumber}$`, 'i').test(id);
    }) || greyboxShots[i] || null;
    return matched ? { ...cut, viewShotId: matched.id } : cut;
  });
}

/**
 * Apply a drafted or saved greybox for `placeSubjectId` to the project's previz:
 * links each cut on that set to its camera in order, drops that set's seeded tracks,
 * and syncs again so figure marks are seeded fresh from the new anchors.
 * Returns `{ previz, loadedPlaces }`.
 */
export function applyPrevizGreybox(project, placeSubjectId, greybox, loadedPlaces = {}) {
  const forCast = musicVideoPrevizForActiveCast(project);
  let current = forCast && Array.isArray(forCast.cuts) && forCast.cuts.length ? forCast : null;
  if (!current) {
    const initial = backfillPrevizFromShots(project, loadedPlaces);
    current = initial.previz;
  }
  const scenes = project?.scenes || [];

  const setCutIndices = [];
  const setCuts = [];
  (current.cuts || []).forEach((cut, index) => {
    if (cut.placeSubjectId === placeSubjectId) {
      setCutIndices.push(index);
      setCuts.push(cut);
    }
  });

  const linkedCuts = linkPrevizCutsToCameras(setCuts, greybox?.shots || [], scenes);
  const allCuts = [...(current.cuts || [])];
  setCutIndices.forEach((cutIndex, i) => {
    allCuts[cutIndex] = linkedCuts[i];
  });

  // Drop seeded tracks for this set so sync seeds them fresh from the new anchors
  const keptTracks = (current.tracks || []).filter((track) => track.placeSubjectId !== placeSubjectId);

  // Update loadedPlaces with this greybox so backfillPrevizFromShots can find the new anchors
  const subject = places(project).find((place) => place.id === placeSubjectId);
  const nextPlaces = { ...loadedPlaces };
  if (subject?.ingredientId) {
    const existingEntry = loadedPlaces[subject.ingredientId] || {};
    nextPlaces[subject.ingredientId] = {
      ...existingEntry,
      ingredient: {
        ...(existingEntry.ingredient || {}),
        id: subject.ingredientId,
        type: 'place',
        name: subject.name,
        payload: {
          ...(existingEntry.ingredient?.payload || {}),
          greybox,
        },
      },
    };
  }

  const { previz } = backfillPrevizFromShots(
    { ...project, previz: { ...current, cuts: allCuts, tracks: keptTracks } },
    nextPlaces,
  );
  return { previz, loadedPlaces: nextPlaces };
}

/** A track's pose at `t`: interpolated position and facing, the earlier key's pose. */
function samplePrevizTrack(track, t) {
  const keys = track?.keys || [];
  if (!keys.length) return null;
  const right = keys.findIndex((key) => key.timeSec > t);
  if (right === 0) return keys[0];
  if (right === -1) return keys.at(-1);
  const a = keys[right - 1];
  const b = keys[right];
  const f = (t - a.timeSec) / (b.timeSec - a.timeSec);
  const mix = (x, y) => x + (y - x) * f;
  let turn = ((b.facingDegrees - a.facingDegrees) % 360 + 540) % 360 - 180;
  if (!Number.isFinite(turn)) turn = 0;
  return { timeSec: t, position: a.position.map((v, i) => mix(v, b.position[i])), facingDegrees: a.facingDegrees + turn * f, pose: a.pose, vehicleSubjectId: a.vehicleSubjectId };
}

/** Whom a cut shows: its picks, else everyone on its set but the holder. */
export function previzCutVisibleIds(project, cut) {
  if (Array.isArray(cut?.visibleSubjectIds)) return cut.visibleSubjectIds;
  const previz = projectPreviz(project);
  const people = new Set(characters(project).map((subject) => subject.id));
  return (previz?.tracks || [])
    .filter((track) => track.placeSubjectId === cut?.placeSubjectId && track.subjectId !== cut?.holderSubjectId && people.has(track.subjectId))
    .map((track) => track.subjectId);
}

/** The story camera a cut shoots with (its linked shot's sheet camera), or null. */
function previzCutStoryCamera(project, cut) {
  const scene = cut?.sceneId ? (project?.scenes || []).find((entry) => entry.sceneId === cut.sceneId) : null;
  const cameraId = scene?.shotSheet?.cameraId;
  return cameraId ? (project?.cameras || []).find((camera) => camera?.id === cameraId) || null : null;
}

// Smooth, repeatable noise: a sum of sines, so a paused or re-seeked frame looks the same every time.
const wobble = (t, seed) => Math.sin(t * 1.7 + seed) * 0.5 + Math.sin(t * 4.3 + seed * 2.1) * 0.3 + Math.sin(t * 9.1 + seed * 3.7) * 0.2;

/** The camera after its story camera's previz style: handheld shake, documentary drift, or none. */
function styledCamera(camera, style, t, riding) {
  if (style !== 'handheld' && style !== 'documentary') return camera;
  const handheld = style === 'handheld';
  const amp = handheld ? (riding ? 0.07 : 0.035) : 0.02;
  const speed = handheld ? 1 : 0.25;
  const shake = (seed) => wobble(t * speed, seed) * amp;
  return {
    position: camera.position.map((v, i) => v + shake(i + 1)),
    target: camera.target.map((v, i) => v + shake(i + 7) * (handheld ? 4 : 6)),
  };
}

/**
 * Where the camera looks: at the keep-in-frame target, or, for a cut that turns
 * to it (`turnToAim`), from its own aim at the start over to the target by the
 * last quarter of the cut (eased), as a camera swung toward someone.
 */
function aimedTarget(cut, timing, t, own, aim) {
  if (!aim) return own;
  if (!cut.turnToAim) return aim;
  const span = timing.endSec - timing.startSec;
  const f = Math.min(1, Math.max(0, span > 0 ? ((t - timing.startSec) / span) * 2 - 0.5 : 1));
  const eased = f * f * (3 - 2 * f);
  return own.map((v, i) => v + (aim[i] - v) * eased);
}

// A selfie cut shows its holder regardless of the in-shot picks (the Previz step strips the holder from them): the camera is held out at arm's length, facing back at its holder.
const SELFIE_DISTANCE = 0.6;
function selfieCamera(holder, height) {
  const eye = [holder.position[0], holder.position[1] + height, holder.position[2]];
  const dir = facingDir(holder.facingDegrees);
  return { position: [eye[0] + dir[0] * SELFIE_DISTANCE, eye[1], eye[2] + dir[2] * SELFIE_DISTANCE], target: eye };
}


const TIMELINE_HELD_LENS = 35;
const TIMELINE_OBSERVER_LENS = 85;
// An observer with no spot picked stands this far off the people, to their right.
const OBSERVER_DISTANCE = 30;

/** The cut's frame on the timeline: everyone where the simulation has them, seen from the holder or the camera spot. */
function timelineFrame(project, cut, timing, songTime, t, style, storyCamera, timelineWorld) {
  const timeline = previzTimeline(project);
  const storyMin = cut.storyMin + (t - timing.startSec) / 60;
  const visibleIds = Array.isArray(cut.visibleSubjectIds) ? new Set(cut.visibleSubjectIds) : null;
  const colors = previzPawnColors(project);
  const actors = timelineActorsAt(project, timelineWorld.world, timelineWorld.places, storyMin).map((actor) => ({
    subjectId: actor.subjectId, name: actor.name, position: actor.position, facingDegrees: actor.facingDegrees, pose: actor.pose,
    color: colors[actor.subjectId].figure.hex, ...vehicleOf(project, colors, actor.vehicleSubjectId),
    holder: actor.subjectId === cut.holderSubjectId,
    visible: actor.subjectId === cut.holderSubjectId ? !!cut.selfie : (!visibleIds || visibleIds.has(actor.subjectId)),
  }));
  const aimActor = cut.aimSubjectId ? actors.find((actor) => actor.subjectId === cut.aimSubjectId) : null;
  const aim = aimActor ? [aimActor.position[0], aimActor.position[1] + CHEST_HEIGHT[aimActor.pose], aimActor.position[2]] : null;
  const holder = actors.find((actor) => actor.holder) || null;
  const shown = actors.filter((actor) => actor.visible);
  const center = shown.length ? [0, 1, 2].map((i) => shown.reduce((sum, actor) => sum + actor.position[i], 0) / shown.length) : null;
  let camera;
  if (holder) {
    const position = [holder.position[0], holder.position[1] + EYE_HEIGHT[holder.pose], holder.position[2]];
    const dir = facingDir(holder.facingDegrees);
    camera = cut.selfie
      ? selfieCamera(holder, EYE_HEIGHT[holder.pose])
      : { position, target: aimedTarget(cut, timing, t, [position[0] + dir[0] * 5, position[1], position[2] + dir[2] * 5], aim) };
  } else {
    const middle = center ? [center[0], 1.2, center[2]] : [0, 1.2, 0];
    const look = aim || middle;
    let spot = Array.isArray(cut.cameraSpot) ? cut.cameraSpot : null;
    if (!spot) {
      const lead = shown[0] || actors[0];
      const right = lead ? [Math.cos(rad(lead.facingDegrees)), -Math.sin(rad(lead.facingDegrees))] : [1, 0];
      spot = [look[0] + right[0] * OBSERVER_DISTANCE, look[2] + right[1] * OBSERVER_DISTANCE];
    }
    camera = { position: [spot[0], 1.6, spot[1]], target: aimedTarget(cut, timing, t, middle, aim) };
  }
  camera = styledCamera(camera, style, songTime, holder?.pose === 'ride');
  if (camera.position.every((v, i) => Math.abs(v - camera.target[i]) < 1e-6)) camera.target = [camera.target[0], camera.target[1], camera.target[2] + 1];
  return {
    cut, timing, greybox: null, world: timelineWorld.world, worldPlaces: timelineWorld.places, storyMin, clockMinutes: timelineClockAt(timeline, storyMin),
    actors, props: [], style, storyCamera,
    camera: { ...camera, focalLengthMm: holder ? TIMELINE_HELD_LENS : TIMELINE_OBSERVER_LENS, aspect: '16:9' },
  };
}

const PROP_COLOR = '#9aa0a8';

/** The props a cut shows on its set at `t`: each cast object with a track there that its shot names (every one when the cut has no shot). */
function cutProps(project, cut, t, colors) {
  const scene = cut.sceneId ? (project?.scenes || []).find((entry) => entry.sceneId === cut.sceneId) : null;
  const words = scene ? shotWords(scene) : null;
  const objects = new Map(castObjects(project).map((subject) => [subject.id, subject]));
  return (projectPreviz(project)?.tracks || [])
    .filter((track) => track.placeSubjectId === cut.placeSubjectId && objects.has(track.subjectId))
    .filter((track) => words === null || objectNamedIn(objects.get(track.subjectId), words))
    .map((track) => {
      const sample = samplePrevizTrack(track, t);
      const name = textOf(objects.get(track.subjectId).name);
      return sample && {
        subjectId: track.subjectId, name, position: sample.position, facingDegrees: sample.facingDegrees,
        shape: previzPropShape(name), color: colors[track.subjectId]?.figure.hex || PROP_COLOR,
      };
    })
    .filter(Boolean);
}

/** The clock a cut on its set is lit by: the timeline's at the cut's story minute, else its shot sheet's time of day; null = plain daylight. */
function cutClockMinutes(project, cut, timing, t) {
  const timeline = previzTimeline(project);
  if (timeline && Number.isFinite(cut.storyMin)) return timelineClockAt(timeline, cut.storyMin + (t - timing.startSec) / 60);
  const sheet = cut.sceneId ? (project?.scenes || []).find((entry) => entry.sceneId === cut.sceneId)?.shotSheet : null;
  return previzClockInText(sheet?.timeOfDay) ?? previzClockInText(sheet?.light);
}

/** Whether a cut plays on the timeline rather than on its set's own blocking. */
function previzCutOnTimeline(project, cut, world) {
  return !!(world && previzTimeline(project) && Number.isFinite(cut?.storyMin));
}

/**
 * Everything the player draws at song time `t`: the cut on screen, its place's
 * greybox, each person on that set (`visible` false for the holder and anyone
 * the cut leaves out), and the camera. A held camera rides on its holder at the
 * saved camera's height (else eye height) and looks at the aim target, else the
 * way the holder faces; an unheld camera stays on its saved greybox camera and
 * turns only to keep the aim target in frame. The cut's story camera (its shot
 * sheet camera) sets the style: handheld shake, a still that holds the cut's
 * first frame, or a slow documentary drift. null between cuts. With
 * `timelineWorld` (`{ world, places }`, the previz world and its loaded sets) a cut
 * with a story time plays the simulated timeline instead (frame `world` set,
 * `greybox` null).
 */
export function previzFrameAt(project, loadedPlaces, songTime, timelineWorld = null) {
  const entry = previzCutAt(project, songTime);
  if (!entry) return null;
  const { cut, timing } = entry;
  const storyCamera = previzCutStoryCamera(project, cut);
  const style = storyCamera?.previzStyle || 'steady';
  // A still camera shows its cut's first frame for the whole cut.
  const t = style === 'still' ? timing.startSec : songTime;
  if (previzCutOnTimeline(project, cut, timelineWorld?.world)) return timelineFrame(project, cut, timing, songTime, t, style, storyCamera, timelineWorld);
  const greybox = cut.placeSubjectId ? previzPlaceGreybox(project, cut.placeSubjectId, loadedPlaces) : null;
  const view = (greybox?.shots || []).find((shot) => shot.id === cut.viewShotId) || null;
  const visible = new Set(previzCutVisibleIds(project, cut));
  const names = new Map(characters(project).map((subject) => [subject.id, subject.name]));
  const colors = previzPawnColors(project);
  const actors = (projectPreviz(project)?.tracks || [])
    .filter((track) => track.placeSubjectId === cut.placeSubjectId && names.has(track.subjectId))
    .map((track) => {
      const pose = samplePrevizTrack(track, t);
      return pose && {
        subjectId: track.subjectId, name: names.get(track.subjectId), position: pose.position, facingDegrees: pose.facingDegrees,
        pose: pose.pose || 'stand', color: colors[track.subjectId].figure.hex, ...vehicleOf(project, colors, pose.vehicleSubjectId), visible: track.subjectId === cut.holderSubjectId ? !!cut.selfie : visible.has(track.subjectId), holder: track.subjectId === cut.holderSubjectId,
      };
    })
    .filter(Boolean);
  const aimActor = cut.aimSubjectId ? actors.find((actor) => actor.subjectId === cut.aimSubjectId) : null;
  const aim = aimActor ? [aimActor.position[0], aimActor.position[1] + CHEST_HEIGHT[aimActor.pose], aimActor.position[2]] : null;
  const holder = cut.holderSubjectId ? actors.find((actor) => actor.holder) : null;
  let camera;
  if (holder) {
    // The view's y values are absolute; measure them from the ground under the view so the holder's feet set the height.
    const viewGround = view ? groundHeightAt(greybox, view.position[0], view.position[2]) : 0;
    const height = view ? view.position[1] - viewGround : EYE_HEIGHT[holder.pose];
    const position = [holder.position[0], holder.position[1] + height, holder.position[2]];
    const reach = view ? Math.hypot(view.target[0] - view.position[0], view.target[2] - view.position[2]) || 5 : 5;
    const dir = facingDir(holder.facingDegrees);
    const ahead = [position[0] + dir[0] * reach, view ? view.target[1] - viewGround + holder.position[1] : position[1], position[2] + dir[2] * reach];
    camera = cut.selfie ? selfieCamera(holder, height) : { position, target: aimedTarget(cut, timing, t, ahead, aim) };
  } else if (view) {
    camera = { position: view.position, target: aimedTarget(cut, timing, t, view.target, aim) };
  } else {
    const shown = actors.filter((actor) => actor.visible);
    const center = shown.length
      ? [0, 1, 2].map((i) => shown.reduce((sum, actor) => sum + actor.position[i], 0) / shown.length)
      : [0, 0, 0];
    camera = { position: [center[0], 1.6, center[2] + 6], target: aimedTarget(cut, timing, t, [center[0], 1.2, center[2]], aim) };
  }
  camera = styledCamera(camera, style, songTime, holder?.pose === 'ride');
  if (camera.position.every((v, i) => Math.abs(v - camera.target[i]) < 1e-6)) camera.target = [camera.target[0], camera.target[1], camera.target[2] + 1];
  return {
    cut, timing, greybox, actors, props: cutProps(project, cut, t, colors), clockMinutes: cutClockMinutes(project, cut, timing, t), style, storyCamera,
    camera: { ...camera, focalLengthMm: view?.focalLengthMm || 35, aspect: view?.aspect || '16:9' },
  };
}

/** What keeps a cut from playing, as short lines: no place, a place with no greybox, a removed camera or person. */
export function previzCutProblems(project, cut, loadedPlaces = {}) {
  const problems = [];
  if (!previzCutTiming(project, cut)) problems.push('Not timed');
  if (!cut.placeSubjectId) return [...problems, 'No set picked'];
  const place = places(project).find((subject) => subject.id === cut.placeSubjectId);
  if (!place) return [...problems, 'Its set was removed from the video'];
  const entry = place.ingredientId ? loadedPlaces[place.ingredientId] : undefined;
  if (entry === undefined && place.ingredientId) return problems;
  const greybox = previzPlaceGreybox(project, cut.placeSubjectId, loadedPlaces);
  if (!greybox) problems.push(`${place.name} has no greybox yet`);
  else if (cut.viewShotId && !(greybox.shots || []).some((shot) => shot.id === cut.viewShotId)) problems.push('Its greybox camera was removed');
  const ids = new Set(characters(project).map((subject) => subject.id));
  if ([...(cut.visibleSubjectIds || []), cut.holderSubjectId, cut.aimSubjectId].some((id) => id && !ids.has(id))) problems.push('Names someone no longer in the video');
  return problems;
}

/**
 * Gives cuts a story time on the timeline: shots in song order walk through the
 * timeline's stays in order, and each run of shots at one set shares the next stay
 * there, spread evenly across it. `onlyUnplaced` keeps cuts that already have a
 * time. Returns `{ previz, placed }`.
 */
export function placePrevizCutsOnTimeline(project, world, { onlyUnplaced = false } = {}) {
  const previz = projectPreviz(project);
  const timeline = previzTimeline(project);
  if (!previz || !timeline || !world) return { previz: previz || project?.previz || null, placed: 0 };
  const stays = timeline.beats.filter((beat) => beat.kind === 'stay').sort((a, b) => a.startMin - b.startMin);
  const setOfCut = (cut) => {
    const subject = places(project).find((entry) => entry.id === cut.placeSubjectId);
    return subject?.ingredientId ? (world.sets || []).find((set) => set.ingredientId === subject.ingredientId)?.id || null : null;
  };
  const ordered = previzTimedCuts(project);
  const runs = [];
  for (const { cut } of ordered) {
    const setId = setOfCut(cut);
    if (runs.at(-1)?.setId === setId) runs.at(-1).cuts.push(cut);
    else runs.push({ setId, cuts: [cut] });
  }
  const times = new Map();
  let at = 0;
  for (const run of runs) {
    if (!run.setId) continue;
    const index = stays.findIndex((stay, i) => i >= at && stay.setId === run.setId);
    if (index === -1) continue;
    at = index + 1;
    const stay = stays[index];
    const span = stay.endMin - stay.startMin;
    run.cuts.forEach((cut, i) => times.set(cut.id, round(stay.startMin + (span * i) / run.cuts.length)));
  }
  let placed = 0;
  const cuts = previz.cuts.map((cut) => {
    if (!times.has(cut.id) || (onlyUnplaced && Number.isFinite(cut.storyMin))) return cut;
    placed += 1;
    return { ...cut, storyMin: times.get(cut.id) };
  });
  return { previz: { ...previz, cuts }, placed };
}
