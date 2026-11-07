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
 *   holder. `aimSubjectId` is who the camera keeps in frame.
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

/** The project's previz, or null when it has none. */
export function projectPreviz(project) {
  const previz = project?.previz;
  return previz && Array.isArray(previz.cuts) && previz.cuts.length ? previz : null;
}

const characters = (project) => (project?.concept?.subjects || []).filter((subject) => subject?.kind === 'character');
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
  const picked = project?.previz?.pawnColors || {};
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

/** Everyone a cut stands on its set: the people it shows, then the camera's holder. */
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

/**
 * Build or refresh the previz from the shot list. Every timed shot gets one
 * linked cut; a shot that already has one keeps it with its picks (place,
 * camera, holder, cast, aim), cuts whose shot is gone are dropped, and unlinked
 * cuts are kept. Tracks are seeded only for people with no track yet on that
 * set, so hand-made blocking survives a refresh. `loadedPlaces` is the linked
 * catalog places by ingredient id. Returns `{ previz, added, removed }`.
 */
export function backfillPrevizFromShots(project, loadedPlaces = {}) {
  const current = project?.previz && Array.isArray(project.previz.cuts) ? project.previz : { cuts: [], tracks: [] };
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

  const trackKey = (subjectId, placeSubjectId) => `${placeSubjectId}\u0000${subjectId}`;
  const tracks = new Map((current.tracks || []).map((track) => [trackKey(track.subjectId, track.placeSubjectId), track]));
  const seeded = new Map();
  for (const cut of added) {
    if (!cut.placeSubjectId) continue;
    const scene = shots.find((entry) => entry.sceneId === cut.sceneId);
    const greybox = previzPlaceGreybox(project, cut.placeSubjectId, loadedPlaces);
    const people = cutPeople(cut).filter((id) => !tracks.has(trackKey(id, cut.placeSubjectId)));
    if (!people.length) continue;
    const pose = shotRides(project, scene, cut.placeSubjectId) ? 'ride' : 'stand';
    const marks = seedMarks(cut, greybox, people);
    for (const id of people) {
      const key = trackKey(id, cut.placeSubjectId);
      const track = seeded.get(key) || { subjectId: id, placeSubjectId: cut.placeSubjectId, keys: [] };
      const mark = marks.get(id);
      track.keys.push({ timeSec: cut.startSec, position: mark.position, facingDegrees: mark.facingDegrees, pose });
      if (cut.endSec - HOLD_EPSILON > cut.startSec) track.keys.push({ timeSec: round(cut.endSec - HOLD_EPSILON), position: mark.position, facingDegrees: mark.facingDegrees, pose });
      seeded.set(key, track);
    }
  }
  const newTracks = [...seeded.values()].map((track) => {
    const keys = [...track.keys].sort((a, b) => a.timeSec - b.timeSec)
      .filter((key, i, all) => i === 0 || key.timeSec > all[i - 1].timeSec).slice(0, PREVIZ_KEYS_MAX);
    return { ...track, keys };
  });
  const allTracks = [...tracks.values(), ...newTracks].slice(0, PREVIZ_TRACKS_MAX);
  return { previz: { ...current, cuts: allCuts, tracks: allTracks }, added: added.length, removed };
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

/**
 * Everything the player draws at song time `t`: the cut on screen, its place's
 * greybox, each person on that set (`visible` false for the holder and anyone
 * the cut leaves out), and the camera. A held camera rides on its holder at the
 * saved camera's height (else eye height) and looks at the aim target, else the
 * way the holder faces; an unheld camera stays on its saved greybox camera and
 * turns only to keep the aim target in frame. null between cuts.
 */
export function previzFrameAt(project, loadedPlaces, t) {
  const entry = previzCutAt(project, t);
  if (!entry) return null;
  const { cut, timing } = entry;
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
    camera = { position, target: aim || ahead };
  } else if (view) {
    camera = { position: view.position, target: aim || view.target };
  } else {
    const shown = actors.filter((actor) => actor.visible);
    const center = shown.length
      ? [0, 1, 2].map((i) => shown.reduce((sum, actor) => sum + actor.position[i], 0) / shown.length)
      : [0, 0, 0];
    camera = { position: [center[0], 1.6, center[2] + 6], target: aim || [center[0], 1.2, center[2]] };
  }
  if (camera.position.every((v, i) => Math.abs(v - camera.target[i]) < 1e-6)) camera.target = [camera.target[0], camera.target[1], camera.target[2] + 1];
  return {
    cut, timing, greybox, actors,
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
