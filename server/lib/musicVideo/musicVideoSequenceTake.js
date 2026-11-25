/**
 * Sequence takes (#16128): one reference-to-video take for 2-6 consecutive board shots, filed whole on
 * each shot with its own in-point.
 *
 * Music Video sequence takes (#16128): the director picks a run of consecutive
 * shots and renders them as ONE take on a reference-to-video model, written as
 * numbered shots with hard cuts. Identity and look hold better inside one take
 * than across separately rendered clips.
 *
 * Unlike sequence coverage (musicVideoSequenceCoverage.js), nothing is cut. The
 * whole clip is filed as a candidate take on every covered shot, each with its
 * own proposed in-point (seconds into the clip). Picking the take on a shot sets
 * that shot's `offsetFrames` to the in-point, so each shot plays its own window
 * of the one file and nudging one shot's offset moves no other shot.
 *
 * Pure (no I/O), so the board composes and labels exactly what the server sends.
 */

import { getFalVideoModel, FAL_VIDEO_MODELS } from '../falVideoModels.js';
import { falReferenceImageName } from '../storyboardGuidance.js';
import { authoredShotPrompt, visualDirection } from './musicVideoShotPrompt.js';
import { shotCameraPrompt } from '../cameraMovements.js';
import { isPerformanceScene } from './musicVideoShotTiming.js';
import { isContinuingScene } from './musicVideoSourceTake.js';
import { CLIP_OFFSET_FRAMES_RANGE, CLIP_TIMING_FPS } from './musicVideoLayers.js';

export const SEQUENCE_TAKE_MIN_SHOTS = 2;
export const SEQUENCE_TAKE_MAX_SHOTS = 6;
// A detected cut this close to where the plan expects a shot change is taken as that change.
const CUT_MATCH_SEC = 1.25;
const EPS = 1e-6;
const round3 = (n) => Math.round(n * 1000) / 1000;
const sceneKey = (scene) => scene?.sceneId ?? null;
const text = (value) => (typeof value === 'string' ? value.trim() : '');

const rendersSequenceTakes = (model) => model?.kind === 'ref2v' && Boolean(model.referenceImages);

/** Hosted models that can render a sequence take: fal reference-to-video models that take reference images. */
export const SEQUENCE_TAKE_MODELS = Object.freeze(FAL_VIDEO_MODELS.filter(rendersSequenceTakes));

/** Why `modelId` cannot render a sequence take, or null when it can. */
export function sequenceTakeModelProblem(modelId) {
  const model = getFalVideoModel(modelId);
  if (!model) return 'Pick a curated fal.ai reference-to-video model for a sequence take.';
  if (!rendersSequenceTakes(model)) return `${model.label} renders one shot from one frame; a sequence take needs a reference-to-video model.`;
  return null;
}

/** The model a project's sequence takes default to: its fal model when that is a reference model. */
export function defaultSequenceTakeModelId(project) {
  const configured = project?.videoSettings?.falModelId;
  if (configured && !sequenceTakeModelProblem(configured)) return configured;
  return SEQUENCE_TAKE_MODELS[0]?.id ?? null;
}

const timelineOrder = (scenes) => (Array.isArray(scenes) ? scenes : [])
  .filter((scene) => sceneKey(scene))
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

const spanOf = (scene) => (Number.isFinite(scene?.startSec) && Number.isFinite(scene?.endSec) && scene.endSec > scene.startSec
  ? scene.endSec - scene.startSec : null);

function memberProblem(scene) {
  const name = scene.label || 'A shot';
  if (isPerformanceScene(scene)) return `${name} is a performance shot; it renders against its own song slice`;
  if ((scene.visualLayer ?? 'footage') !== 'footage') return `${name} is not a footage shot`;
  if (isContinuingScene(scene)) return `${name} plays another shot's take`;
  if (spanOf(scene) == null) return `${name} has no timed span`;
  return null;
}

/**
 * The run `sceneIds` names: 2-6 shots, consecutive in board order, each a timed
 * footage shot of its own. `{ ok: true, members, durationSec }` or
 * `{ ok: false, code, reason }`.
 */
export function sequenceTakeRun(project, sceneIds) {
  const ids = Array.isArray(sceneIds) ? sceneIds : [];
  if (ids.length < SEQUENCE_TAKE_MIN_SHOTS || ids.length > SEQUENCE_TAKE_MAX_SHOTS) {
    return { ok: false, code: 'SEQUENCE_TAKE_RUN_SIZE', reason: `Pick ${SEQUENCE_TAKE_MIN_SHOTS} to ${SEQUENCE_TAKE_MAX_SHOTS} consecutive shots.` };
  }
  if (new Set(ids).size !== ids.length) return { ok: false, code: 'SEQUENCE_TAKE_NOT_CONSECUTIVE', reason: 'A shot is listed twice.' };
  const ordered = timelineOrder(project?.scenes);
  const first = ordered.findIndex((scene) => scene.sceneId === ids[0]);
  if (first < 0 || ids.some((id) => !ordered.some((scene) => scene.sceneId === id))) {
    return { ok: false, code: 'SEQUENCE_TAKE_SCENE_MISSING', reason: 'A picked shot is no longer on the board. Reload and pick again.' };
  }
  const members = ordered.slice(first, first + ids.length);
  if (members.length !== ids.length || members.some((scene, i) => scene.sceneId !== ids[i])) {
    return { ok: false, code: 'SEQUENCE_TAKE_NOT_CONSECUTIVE', reason: 'The picked shots must be consecutive on the board, in order.' };
  }
  for (const scene of members) {
    const problem = memberProblem(scene);
    if (problem) return { ok: false, code: 'SEQUENCE_TAKE_SHOT_INELIGIBLE', reason: `${problem}, so it cannot join a sequence take.` };
  }
  return { ok: true, members, durationSec: round3(members.reduce((sum, scene) => sum + spanOf(scene), 0)) };
}

/**
 * Where each shot falls in the planned take: back to back from 0, each its own
 * length. Song gaps between shots are not rendered, so the windows are cumulative.
 */
function planSequenceTakeWindows(members) {
  let at = 0;
  return (members || []).map((scene) => {
    const startSec = round3(at);
    at += spanOf(scene) ?? 0;
    return { sceneId: sceneKey(scene), startSec, endSec: round3(at) };
  });
}

/**
 * The run's references, in send order: each shot's frame (shot n is reference
 * n), then the shots' character, set and prop references once each, by file.
 * `frames` are `[{ sceneId, key, label }]` in shot order; `extras` are
 * `[{ key, label, role }]` per shot, in order. Over the model's cap, the extras
 * past it are left out and counted in `omitted`; the frames never are.
 */
export function unionSequenceTakeReferences({ frames = [], extras = [], max = Infinity }) {
  const seen = new Set();
  const references = [];
  for (const frame of frames) {
    const key = frame.treatmentKey || frame.key;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ ...frame, kind: 'frame' });
  }
  let omitted = 0;
  for (const ref of extras.flat()) {
    if (!ref?.key || seen.has(ref.key)) continue;
    seen.add(ref.key);
    if (references.length >= max) { omitted += 1; continue; }
    references.push({ ...ref, kind: 'reference' });
  }
  return { references, omitted, overCap: frames.length > max };
}

const fmt = (n) => `${round3(n)}`;

function referenceLine(name, ref) {
  const label = text(ref.label) || 'a reference';
  if (ref.role === 'set') return `${name} is the set "${label}": keep its place, period and light.`;
  if (ref.role === 'prop') return `${name} is the prop sheet: objects from it look exactly as shown.`;
  if (ref.role === 'wardrobe') return `${name} is the wardrobe sheet "${label}": dress the people as shown.`;
  // A shared comparison sheet (musicVideoLinkedCastReferences `comparison`) shows two or more people.
  if (ref.comparison?.names?.length > 1) return `${name} is ${label}: keep each person's exact face, hair and wardrobe from their own figure on it in every shot.`;
  return `${name} is ${label}: keep this exact face, hair and wardrobe in every shot.`;
}

/**
 * `{ prompt, promptAdditions }` for one sequence take. The shots' own clip
 * prompts are the director's text; the structure, reference map, look and
 * camera lines are labeled additions, each written once for the whole take.
 * `references` come from `unionSequenceTakeReferences`. `seconds` is the length
 * requested; when the model's minimum makes it longer than the run, the shot
 * times are stretched to fill it, so the prompt never names a time past its end.
 */
export function composeSequenceTakePrompt({ project, members, modelId, references = [], seconds = null }) {
  const model = getFalVideoModel(modelId);
  const planned = planSequenceTakeWindows(members);
  const runSec = planned.at(-1)?.endSec ?? 0;
  const stretch = Number.isFinite(seconds) && runSec > 0 && seconds > runSec ? seconds / runSec : 1;
  const windows = planned.map((w) => ({ ...w, startSec: round3(w.startSec * stretch), endSec: round3(w.endSec * stretch) }));
  const total = windows.at(-1)?.endSec ?? 0;
  const nameOf = (index) => falReferenceImageName(model, index) || `Image ${index + 1}`;
  const frameIndex = new Map(references.map((ref, i) => [ref.kind === 'frame' ? ref.sceneId : null, i]).filter(([id]) => id));
  const additions = [];
  const add = (id, label, value) => {
    const body = text(value);
    if (!body) return null;
    additions.push({ id, label, text: body });
    return body;
  };
  const structure = add('sequence-take', 'One take, hard cuts',
    `One take of ${members.length} shots separated by hard cuts, ${fmt(total)}s in all. The same people, faces, wardrobe and place carry through every shot; each shot starts on a hard cut, never a dissolve.`);
  const frameNames = members.map((scene) => frameIndex.get(sceneKey(scene))).filter(Number.isInteger).map(nameOf);
  const map = add('reference-map', 'Reference images', [
    frameNames.length ? `${frameNames.join(', ')} ${frameNames.length === 1 ? 'is' : 'are'} the opening frame${frameNames.length === 1 ? '' : 's'} of the shot${frameNames.length === 1 ? '' : 's'} below, in order.` : '',
    ...references.map((ref, i) => (ref.kind === 'reference' ? referenceLine(nameOf(i), ref) : '')),
  ].filter(Boolean).join(' '));
  const style = add('project-style', 'Project style', project?.concept?.style);
  const direction = add('visual-direction', 'Palette and camera rules', visualDirection(project?.visualSpec));
  const shots = members.map((scene, i) => {
    const window = windows[i];
    const frame = frameIndex.has(sceneKey(scene)) ? `${nameOf(frameIndex.get(sceneKey(scene)))}. ` : '';
    const camera = add(`shot-${i + 1}-camera`, `Shot ${i + 1} camera move`, shotCameraPrompt(scene.camera));
    const own = authoredShotPrompt(scene);
    return `Shot ${i + 1} (${fmt(window.startSec)}-${fmt(window.endSec)}s): ${frame}${[own, camera].filter(Boolean).join(' ')}`.trim();
  });
  add('shot-headers', 'Shot numbers, times and frames', 'Each shot line starts "Shot n (start-end s): Image n." and shots are joined by "Hard cut."');
  const prompt = [structure, map, style, direction, shots.join('\nHard cut.\n')].filter(Boolean).join('\n');
  return { prompt, promptAdditions: additions, windows: planned };
}

/**
 * Propose each shot's in-point in the returned clip. Each planned shot change
 * (scaled to the clip's real length) takes the nearest detected cut within
 * CUT_MATCH_SEC, else stays where planned, and the shot's window is centred in
 * the segment it lands in, so neither cut's transition frames show. `cutsSec` is
 * null when detection failed (every in-point is then planned).
 *
 * Returns `[{ sceneId, offsetSec, offsetFrames, from: 'start'|'cut'|'planned' }]`
 * snapped to the 24 fps grid, or `{ ok: false, reason }` when the clip cannot
 * hold a shot's own length.
 */
export function proposeSequenceTakeOffsets({ windows = [], cutsSec = null, clipSec }) {
  if (!windows.length || !Number.isFinite(clipSec) || clipSec <= 0) return { ok: false, reason: 'the take has no readable length' };
  const plannedTotal = windows.at(-1).endSec;
  const scale = plannedTotal > 0 && clipSec > plannedTotal ? clipSec / plannedTotal : 1;
  const cuts = (Array.isArray(cutsSec) ? cutsSec : []).filter((t) => Number.isFinite(t) && t > EPS && t < clipSec - EPS).sort((a, b) => a - b);
  const used = new Set();
  const boundaries = [{ at: 0, from: 'start' }];
  for (let i = 1; i < windows.length; i += 1) {
    const expected = windows[i].startSec * scale;
    let best = null;
    for (const cut of cuts) {
      if (used.has(cut) || cut <= boundaries.at(-1).at + EPS) continue;
      const distance = Math.abs(cut - expected);
      if (distance <= CUT_MATCH_SEC && (best == null || distance < Math.abs(best - expected))) best = cut;
    }
    if (best != null) used.add(best);
    boundaries.push(best != null ? { at: best, from: 'cut' } : { at: Math.max(expected, boundaries.at(-1).at), from: 'planned' });
  }
  const offsets = [];
  for (let i = 0; i < windows.length; i += 1) {
    const need = windows[i].endSec - windows[i].startSec;
    if (need > clipSec + EPS) return { ok: false, reason: `the take is ${round3(clipSec)}s, shorter than one ${round3(need)}s shot` };
    const segStart = boundaries[i].at;
    const segEnd = i + 1 < boundaries.length ? boundaries[i + 1].at : clipSec;
    const centred = segStart + Math.max(0, (segEnd - segStart - need) / 2);
    const latest = Math.max(0, clipSec - need);
    const frames = Math.min(Math.floor(latest * CLIP_TIMING_FPS + EPS), Math.round(Math.min(latest, Math.max(0, centred)) * CLIP_TIMING_FPS));
    offsets.push({ sceneId: windows[i].sceneId, offsetSec: round3(frames / CLIP_TIMING_FPS), offsetFrames: frames, from: boundaries[i].from });
  }
  return { ok: true, offsets };
}

/** The `sequence` block a take keeps, bounded and typed, or null when the input is not one. */
export function sequenceTakeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const sceneIds = Array.isArray(input.sceneIds) ? input.sceneIds.filter((id) => typeof id === 'string' && id).slice(0, SEQUENCE_TAKE_MAX_SHOTS).map((id) => id.slice(0, 200)) : [];
  const frames = Number.isInteger(input.offsetFrames) ? input.offsetFrames : null;
  if (sceneIds.length < SEQUENCE_TAKE_MIN_SHOTS || frames == null || frames < 0 || frames > CLIP_OFFSET_FRAMES_RANGE.max) return null;
  const index = Number.isInteger(input.index) && input.index >= 0 && input.index < sceneIds.length ? input.index : null;
  return {
    sceneIds,
    ...(index != null ? { index } : {}),
    offsetFrames: frames,
    from: ['start', 'cut', 'planned'].includes(input.from) ? input.from : 'planned',
  };
}

/** The `extend` block a child take keeps (its parent take and the in-point of its new footage), or null. */
export function extendTakeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const parent = typeof input.parentTakeId === 'string' ? input.parentTakeId.trim().slice(0, 128) : '';
  const frames = Number.isInteger(input.offsetFrames) ? input.offsetFrames : null;
  if (!parent || frames == null || frames < 0 || frames > CLIP_OFFSET_FRAMES_RANGE.max) return null;
  return { parentTakeId: parent, offsetFrames: frames };
}

const extendOf = (take) => (take?.kind === 'video' ? extendTakeRecord(take.extend) : null);

/**
 * In-point (frames) of the new footage in a hosted extension: the delivered clip either holds only the
 * extension (0) or the source joined with it, in which case the new footage starts `extensionSec` before the end.
 */
export function extendTakeInPointFrames({ deliveredSec, extensionSec }) {
  if (!(deliveredSec > 0) || !(extensionSec > 0)) return 0;
  const lead = deliveredSec - extensionSec;
  return lead > 0.5 ? Math.min(CLIP_OFFSET_FRAMES_RANGE.max, Math.round(lead * CLIP_TIMING_FPS)) : 0;
}

const sequenceOf = (take) => (take?.kind === 'video' ? sequenceTakeRecord(take.sequence) : null);

/**
 * The offset a shot takes when `take` becomes its clip: a sequence take's
 * in-point. Leaving a sequence take for another clip clears the in-point it set;
 * any other change keeps the director's own offset. `{}` (no change),
 * `{ offsetFrames: n }` or `{ offsetFrames: null }` (clear).
 */
export function sequenceTakeSelectionPatch(scene, take) {
  if (take?.kind !== 'video' || take.assetId === scene?.videoHistoryId) return {};
  const inPoint = sequenceOf(take) || extendOf(take);
  if (inPoint) return { offsetFrames: inPoint.offsetFrames || null };
  const current = (scene?.takes || []).find((t) => t?.kind === 'video' && t.assetId === scene?.videoHistoryId);
  return sequenceOf(current) || extendOf(current) ? { offsetFrames: null } : {};
}

/** A sequence take's short tag for its shot's take strip ("One take · 2/4 · in 2.21s"), or null. */
export function sequenceTakeLabel(take) {
  const sequence = sequenceOf(take);
  if (!sequence) return null;
  const position = sequence.index != null ? `${sequence.index + 1}/${sequence.sceneIds.length}` : `${sequence.sceneIds.length} shots`;
  return `One take · ${position} · in ${(sequence.offsetFrames / CLIP_TIMING_FPS).toFixed(2)}s`;
}

/** The longer description: which shots the take covers and how its in-point was found, or null. */
export function sequenceTakeSummary(take, scenes = []) {
  const sequence = sequenceOf(take);
  if (!sequence) return null;
  const where = sequence.from === 'cut' ? 'at its detected cut' : sequence.from === 'start' ? 'from the start' : 'where planned (no cut found)';
  const labels = sequence.sceneIds.map((id) => (scenes || []).find((scene) => scene.sceneId === id)?.label || 'a removed shot');
  return `One take across ${labels.join(', ')}. This shot plays from ${(sequence.offsetFrames / CLIP_TIMING_FPS).toFixed(2)}s, ${where}; nudge its Offset to move the window.`;
}
