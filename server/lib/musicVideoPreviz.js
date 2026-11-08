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
 *   world and a night (lib/musicVideoPrevizNight.js), `storyMin` is the story
 *   minute the cut starts on that night: the cut then plays the simulated night
 *   from there at real speed (one song second = one story second), and an unheld
 *   camera stands at `cameraSpot` (`[x, z]` world meters) with a long lens.
 * - a track is where one character is in one place over time:
 *   `{ subjectId, placeSubjectId, keys: [{ timeSec, position, facingDegrees, pose }] }`,
 *   absolute song seconds, linearly interpolated, held before the first and after
 *   the last key. `pose: 'ride'` draws the figure on a bike proxy.
 *
 * Units are the greybox's: meters, Y up, floor y=0; facing 0 looks along +Z.
 * Browser-safe and pure.
 */
import { isPreMusicShot } from './musicVideoColdOpen.js';
import { musicVideoShotPlaceId, projectRouteMaps } from './musicVideoRouteMaps.js';
import { SHOT_CAMERA_SET_DOWN } from './musicVideoShotSheet.js';
import { activeMusicVideoSubjects, musicVideoPrevizForActiveCast } from './musicVideoCastSelection.js';
import { nightActorsAt, nightClockAt, previzNight } from './musicVideoPrevizNight.js';
import { PREVIZ_CUTS_MAX, PREVIZ_KEYS_MAX, PREVIZ_PAWN_COLORS, PREVIZ_TRACKS_MAX } from './musicVideoPrevizLimits.js';

const EYE_HEIGHT = { stand: 1.6, ride: 1.75 };
const CHEST_HEIGHT = { stand: 1.25, ride: 1.4 };
const FIGURE_SPACING = 0.9;
// The end key of a cut sits this far before the cut's end, so a figure holds its mark for
// the whole cut instead of sliding toward where it stands in the next one.
const HOLD_EPSILON = 0.001;
const RIDE_WORDS = /\b(bikes?|bicycles?|cycl(?:e|es|ing)|rid(?:e|es|ing)|pedal\w*)\b/i;

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

/** A character subject by the name a shot sheet writes (case and spacing ignored). */
function characterByName(project, name) {
  const wanted = textOf(name).toLowerCase();
  if (!wanted) return null;
  return characters(project).find((subject) => textOf(subject.name).toLowerCase() === wanted) || null;
}

/**
 * Each character's pawn colors, `{ [subjectId]: { figure, bike } }` (palette
 * entries): the director's picks, else the next color no one has, in cast order.
 * A bike defaults to its rider's color.
 */
export function previzPawnColors(project) {
  const picked = musicVideoPrevizForActiveCast(project)?.pawnColors || {};
  const byId = new Map(PREVIZ_PAWN_COLORS.map((color) => [color.id, color]));
  const taken = new Set(Object.values(picked).map((entry) => entry?.figure).filter(Boolean));
  const free = PREVIZ_PAWN_COLORS.filter((color) => !taken.has(color.id));
  let next = 0;
  return Object.fromEntries(characters(project).map((subject, at) => {
    const own = picked[subject.id] || {};
    const figure = byId.get(own.figure) || free[next++] || PREVIZ_PAWN_COLORS[at % PREVIZ_PAWN_COLORS.length];
    return [subject.id, { figure, bike: byId.get(own.bike) || figure }];
  }));
}

/** The place's greybox and its saved cameras, from the loaded catalog places (`{ [ingredientId]: { ingredient, media } }`). */
export function previzPlaceGreybox(project, placeSubjectId, loadedPlaces = {}) {
  const subject = places(project).find((place) => place.id === placeSubjectId);
  const entry = subject?.ingredientId ? loadedPlaces[subject.ingredientId] : null;
  const greybox = entry?.ingredient?.type === 'place' ? entry.ingredient.payload?.greybox : null;
  return greybox && typeof greybox === 'object' ? greybox : null;
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
  return {
    id: cutIdFor(scene.sceneId), sceneId: scene.sceneId, startSec: scene.startSec, endSec: scene.endSec,
    placeSubjectId: placeSubjectId || null, viewShotId, ...cutCastFromSheet(project, scene), aimSubjectId: null,
  };
}

/** Whether the shot shows its people on bikes: its sheet's action, else the route its place is on. */
function shotRides(project, scene, placeSubjectId) {
  if (RIDE_WORDS.test(textOf(scene.shotSheet?.action))) return true;
  return projectRouteMaps(project).some((map) => (map.stops || []).some((stop) => stop.subjectId === placeSubjectId) && RIDE_WORDS.test(textOf(map.travel)));
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
function seedMarks(cut, greybox, people) {
  const view = (greybox?.shots || []).find((shot) => shot.id === cut.viewShotId) || null;
  const anchors = new Map((greybox?.anchors || []).map((anchor) => [anchor.id, anchor]));
  const marks = new Map();
  const shown = people.filter((id) => id !== cut.holderSubjectId);
  const figureMarks = (view?.figures || []).map((figure) => anchors.get(figure.anchorId)).filter((anchor) => anchor?.kind === 'figure');
  const cam = view?.position || [0, 1.6, 6];
  const target = view?.target || [0, 1.2, 0];
  const flat = [target[0] - cam[0], 0, target[2] - cam[2]];
  const length = Math.hypot(flat[0], flat[2]) || 1;
  const dir = [flat[0] / length, 0, flat[2] / length];
  const distance = Math.min(6, Math.max(2, length));
  const center = [cam[0] + dir[0] * distance, 0, cam[2] + dir[2] * distance];
  const across = [dir[2], 0, -dir[0]];
  const rowCount = Math.max(0, shown.length - figureMarks.length);
  shown.forEach((id, i) => {
    const anchor = figureMarks[i];
    if (anchor) {
      marks.set(id, { position: [anchor.position[0], 0, anchor.position[2]], facingDegrees: anchor.facingDegrees ?? 0 });
      return;
    }
    const slot = i - figureMarks.length - (rowCount - 1) / 2;
    const position = [round(center[0] + across[0] * slot * FIGURE_SPACING), 0, round(center[2] + across[2] * slot * FIGURE_SPACING)];
    marks.set(id, { position, facingDegrees: facingToward(position, cam) });
  });
  if (cut.holderSubjectId) {
    marks.set(cut.holderSubjectId, { position: [cam[0], 0, cam[2]], facingDegrees: facingToward(cam, target) });
  }
  return marks;
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
    const people = [...new Set([...cutPeople(cut), ...(cut.aimSubjectId ? [cut.aimSubjectId] : [])])]
      .filter((id) => characters(project).some((subject) => subject.id === id) && !tracks.has(trackKey(id, cut.placeSubjectId)));
    if (!people.length) continue;
    const scene = (project?.scenes || []).find((entry) => entry.sceneId === cut.sceneId) || {};
    const pose = shotRides(project, scene, cut.placeSubjectId) ? 'ride' : 'stand';
    const marks = seedMarks(cut, previzPlaceGreybox(project, cut.placeSubjectId, loadedPlaces), people);
    for (const id of people) {
      const key = trackKey(id, cut.placeSubjectId);
      const track = seeded.get(key) || { subjectId: id, placeSubjectId: cut.placeSubjectId, keys: [] };
      const mark = marks.get(id);
      track.keys.push({ timeSec: timing.startSec, position: mark.position, facingDegrees: mark.facingDegrees, pose });
      if (timing.endSec - HOLD_EPSILON > timing.startSec) track.keys.push({ timeSec: round(timing.endSec - HOLD_EPSILON), position: mark.position, facingDegrees: mark.facingDegrees, pose });
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
 * linked cut; a shot that already has one keeps it with its picks (place,
 * camera, holder, cast, aim), cuts whose shot is gone are dropped, and unlinked
 * cuts are kept. Marks are seeded only for people with no track yet on that
 * set, so hand-made blocking survives a refresh. `loadedPlaces` is the linked
 * catalog places by ingredient id. Returns `{ previz, added, removed }`.
 */
export function backfillPrevizFromShots(project, loadedPlaces = {}) {
  const forCast = musicVideoPrevizForActiveCast(project);
  const current = forCast && Array.isArray(forCast.cuts) ? forCast : { cuts: [], tracks: [] };
  const shots = timedShots(project);
  const shotIds = new Set(shots.map((scene) => scene.sceneId));
  const linked = new Map(current.cuts.filter((cut) => cut.sceneId).map((cut) => [cut.sceneId, cut]));
  const added = [];
  const cuts = shots.map((scene) => {
    const existing = linked.get(scene.sceneId);
    if (existing) return { ...existing, startSec: scene.startSec, endSec: scene.endSec };
    const cut = cutFromShot(project, scene);
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
  return { timeSec: t, position: a.position.map((v, i) => mix(v, b.position[i])), facingDegrees: a.facingDegrees + turn * f, pose: a.pose };
}

/** Whom a cut shows: its picks, else everyone on its set but the holder. */
export function previzCutVisibleIds(project, cut) {
  if (Array.isArray(cut?.visibleSubjectIds)) return cut.visibleSubjectIds;
  const previz = projectPreviz(project);
  return (previz?.tracks || [])
    .filter((track) => track.placeSubjectId === cut?.placeSubjectId && track.subjectId !== cut?.holderSubjectId)
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

const NIGHT_HELD_LENS = 35;
const NIGHT_OBSERVER_LENS = 85;
// An observer with no spot picked stands this far off the people, to their right.
const OBSERVER_DISTANCE = 30;

/** The cut's frame on the night: everyone where the simulation has them, seen from the holder or the camera spot. */
function nightFrame(project, cut, timing, songTime, t, style, storyCamera, nightWorld) {
  const night = previzNight(project);
  const storyMin = cut.storyMin + (t - timing.startSec) / 60;
  const visibleIds = Array.isArray(cut.visibleSubjectIds) ? new Set(cut.visibleSubjectIds) : null;
  const colors = previzPawnColors(project);
  const actors = nightActorsAt(project, nightWorld.world, nightWorld.places, storyMin).map((actor) => ({
    subjectId: actor.subjectId, name: actor.name, position: actor.position, facingDegrees: actor.facingDegrees, pose: actor.pose,
    color: colors[actor.subjectId].figure.hex, bikeColor: colors[actor.subjectId].bike.hex,
    holder: actor.subjectId === cut.holderSubjectId,
    visible: actor.subjectId !== cut.holderSubjectId && (!visibleIds || visibleIds.has(actor.subjectId)),
  }));
  const aimActor = cut.aimSubjectId ? actors.find((actor) => actor.subjectId === cut.aimSubjectId) : null;
  const aim = aimActor ? [aimActor.position[0], CHEST_HEIGHT[aimActor.pose], aimActor.position[2]] : null;
  const holder = actors.find((actor) => actor.holder) || null;
  const shown = actors.filter((actor) => actor.visible);
  const center = shown.length ? [0, 1, 2].map((i) => shown.reduce((sum, actor) => sum + actor.position[i], 0) / shown.length) : null;
  let camera;
  if (holder) {
    const position = [holder.position[0], EYE_HEIGHT[holder.pose], holder.position[2]];
    const dir = facingDir(holder.facingDegrees);
    camera = { position, target: aimedTarget(cut, timing, t, [position[0] + dir[0] * 5, position[1], position[2] + dir[2] * 5], aim) };
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
    cut, timing, greybox: null, world: nightWorld.world, worldPlaces: nightWorld.places, storyMin, clockMinutes: nightClockAt(night, storyMin),
    actors, style, storyCamera,
    camera: { ...camera, focalLengthMm: holder ? NIGHT_HELD_LENS : NIGHT_OBSERVER_LENS, aspect: '16:9' },
  };
}

/** Whether a cut plays on the night rather than on its set's own blocking. */
function previzCutOnNight(project, cut, world) {
  return !!(world && previzNight(project) && Number.isFinite(cut?.storyMin));
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
 * `nightWorld` (`{ world, places }`, the previz world and its loaded sets) a cut
 * with a story time plays the simulated night instead (frame `world` set,
 * `greybox` null).
 */
export function previzFrameAt(project, loadedPlaces, songTime, nightWorld = null) {
  const entry = previzCutAt(project, songTime);
  if (!entry) return null;
  const { cut, timing } = entry;
  const storyCamera = previzCutStoryCamera(project, cut);
  const style = storyCamera?.previzStyle || 'steady';
  // A still camera shows its cut's first frame for the whole cut.
  const t = style === 'still' ? timing.startSec : songTime;
  if (previzCutOnNight(project, cut, nightWorld?.world)) return nightFrame(project, cut, timing, songTime, t, style, storyCamera, nightWorld);
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
        pose: pose.pose || 'stand', color: colors[track.subjectId].figure.hex, bikeColor: colors[track.subjectId].bike.hex, visible: visible.has(track.subjectId) && track.subjectId !== cut.holderSubjectId, holder: track.subjectId === cut.holderSubjectId,
      };
    })
    .filter(Boolean);
  const aimActor = cut.aimSubjectId ? actors.find((actor) => actor.subjectId === cut.aimSubjectId) : null;
  const aim = aimActor ? [aimActor.position[0], aimActor.position[1] + CHEST_HEIGHT[aimActor.pose], aimActor.position[2]] : null;
  const holder = cut.holderSubjectId ? actors.find((actor) => actor.holder) : null;
  let camera;
  if (holder) {
    const height = view ? view.position[1] : EYE_HEIGHT[holder.pose];
    const position = [holder.position[0], holder.position[1] + height, holder.position[2]];
    const reach = view ? Math.hypot(view.target[0] - view.position[0], view.target[2] - view.position[2]) || 5 : 5;
    const dir = facingDir(holder.facingDegrees);
    const ahead = [position[0] + dir[0] * reach, view ? view.target[1] : position[1], position[2] + dir[2] * reach];
    camera = { position, target: aimedTarget(cut, timing, t, ahead, aim) };
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
    cut, timing, greybox, actors, style, storyCamera,
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
 * Gives cuts a story time on the night: shots in song order walk through the
 * night's stays in order, and each run of shots at one set shares the next stay
 * there, spread evenly across it. `onlyUnplaced` keeps cuts that already have a
 * time. Returns `{ previz, placed }`.
 */
export function placePrevizCutsOnNight(project, world, { onlyUnplaced = false } = {}) {
  const previz = projectPreviz(project);
  const night = previzNight(project);
  if (!previz || !night || !world) return { previz: previz || project?.previz || null, placed: 0 };
  const stays = night.beats.filter((beat) => beat.kind === 'stay').sort((a, b) => a.startMin - b.startMin);
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
