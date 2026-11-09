import { activeMusicVideoSubjects } from './musicVideoCastSelection.js';
/**
 * The shot sheet: every shot's plan on one screen, read and edited without
 * rendering anything. A shot's sheet (`scene.shotSheet`) names what the shot is
 * meant to be: which camera we look through and who holds it, the view, where
 * and when it is, who is in it, what they do and what they feel. The project's
 * `cameras` list says which cameras exist in this video. A shot whose sheet
 * has `promptFromSheet` builds its prompts from the sheet: its frame and motion
 * prompts are then general prompts, and shotSheetPromptLines are the details
 * the still and clip composers add after them (musicVideoShotPrompt.js).
 * Otherwise the sheet is the director's plan beside the prompts and reaches no model.
 */
import { sungLyricTextWithin } from './musicVideoLyricAnchors.js';

export const SHOT_CAMERA_KINDS = ['in-world', 'observer'];
export const SHOT_CAMERA_MAX = 12;
// What a camera produces. A camera with neither set can shoot both.
export const SHOT_CAMERA_OUTPUTS = ['image', 'video'];
export const SHOT_SHEET_CHARACTERS_MAX = 24;
// Shots per AI request, so one reply stays short enough to read and retry.
export const SHOT_SHEET_PROPOSE_BATCH = 15;
// A holder value for an in-world camera left running with nobody behind it.
export const SHOT_CAMERA_SET_DOWN = 'Set down';

// The sheet's free-text columns, in reading order, with their character limits.
export const SHOT_SHEET_TEXT_FIELDS = [
  ['view', 1000], ['location', 200], ['timeOfDay', 100], ['light', 300], ['action', 2000], ['emotion', 300], ['notes', 2000],
];

const hasSheetValue = (value) => (Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? value.trim() !== '' : typeof value === 'boolean' ? value : value != null);

/** A sheet with nothing filled in is stored as null, so "not planned yet" stays one state. */
export function normalizeShotSheet(sheet) {
  if (!sheet || typeof sheet !== 'object') return null;
  const kept = Object.fromEntries(Object.entries(sheet).filter(([, value]) => hasSheetValue(value)));
  return Object.keys(kept).length ? kept : null;
}

/**
 * Whether the shot's selected frame was rendered from an earlier wording of its
 * frame prompt, so the picture no longer shows what the prompt says. A frame
 * with no recorded prompt (imported, or older than prompt recording) can't be
 * judged and reads as current. Takes record the composed prompt, which contains
 * the shot's own text whole, so any edit to that text shows.
 */
function selectedFrameOutdated(project, scene) {
  const framePrompt = typeof scene?.framePrompt === 'string' ? scene.framePrompt.trim() : '';
  // A sheet-built still records each ingredient's text, so an edited ingredient shows too.
  // The camera rule is composed even when the sheet does not drive the prompt.
  const parts = [framePrompt, ...shotSheetPromptLines(project, scene).map((line) => line.text), shotCameraRuleText(project, scene)].filter(Boolean);
  if (!parts.length || !scene?.referenceImageId) return false;
  const take = (Array.isArray(scene.takes) ? scene.takes : [])
    .find((entry) => entry?.kind === 'image' && entry.assetId === scene.referenceImageId);
  if (typeof take?.prompt !== 'string' || !take.prompt) return false;
  return parts.some((part) => !take.prompt.includes(part));
}

/** Whether a shot's prompts are built from its sheet (its frame and motion prompts are then general prompts). */
export const shotSheetDrivesPrompt = (scene) => scene?.shotSheet?.promptFromSheet === true;

const sheetText = (value) => (typeof value === 'string' ? value.trim() : '');
const listNames = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || '');

/**
 * The still-prompt ingredients a sheet-built shot sends, in reading order, each
 * `{ id, label, text }` so the composer can list it as its own labeled part:
 * camera (and who holds it), view, place and time, who, action, emotion, notes.
 * Empty columns add nothing. [] for a shot not built from its sheet.
 */
export function shotSheetPromptLines(project, scene) {
  if (!shotSheetDrivesPrompt(scene)) return [];
  const sheet = scene.shotSheet;
  const camera = sheet.cameraId ? (project?.cameras || []).find((entry) => entry?.id === sheet.cameraId) : null;
  const holder = sheetText(sheet.holder);
  const cameraText = camera
    ? camera.kind === 'observer' ? `${camera.name}, an unseen observer camera that nobody in the scene holds`
      : holder === SHOT_CAMERA_SET_DOWN ? `${camera.name}, set down with nobody holding it` : holder ? `${camera.name}, held by ${holder}` : camera.name
    : '';
  const place = [sheetText(sheet.location), sheetText(sheet.timeOfDay), sheetText(sheet.light) ? `lit by ${sheetText(sheet.light)}` : ''].filter(Boolean).join(', ');
  const who = (Array.isArray(sheet.characters) ? sheet.characters : []).map(sheetText).filter(Boolean);
  return [
    ['camera', 'Camera', cameraText],
    ['view', 'View', sheetText(sheet.view)],
    ['place', 'Place and time', place],
    ['who', 'Who', listNames(who)],
    ['action', 'Action', sheetText(sheet.action)],
    ['emotion', 'Emotion', sheetText(sheet.emotion)],
    ['notes', 'Notes', sheetText(sheet.notes)],
  ].filter(([, , text]) => text).map(([id, label, text]) => ({ id: `shot-sheet-${id}`, label, text: `${label}: ${text}.`.replace(/([.!?])\.$/, '$1') }));
}

const sheetCamera = (project, scene) => {
  const id = scene?.shotSheet?.cameraId;
  if (!id) return null;
  return (project?.cameras || []).find((entry) => entry?.id === id) || null;
};

const withoutTerminalPunctuation = (value) => String(value || '').trim().replace(/[.!?]+$/, '');

/**
 * The shot's camera as one prompt block: its name, kind and rule. An in-world
 * camera with an owner is the one taking the picture, so the block says it is
 * not in the frame. '' when the shot names no camera. Composed into the frame,
 * end frame and clip whether or not the sheet drives the prompt.
 */
export function shotCameraRuleText(project, scene) {
  const camera = sheetCamera(project, scene);
  const name = typeof camera?.name === 'string' ? camera.name.trim() : '';
  if (!name) return '';
  const parts = [`${name}, ${camera.kind === 'observer' ? 'an observer camera' : 'an in-world camera'}`];
  const owner = typeof camera.owner === 'string' ? camera.owner.trim() : '';
  if (camera.kind !== 'observer' && owner) parts.push('This camera is the one taking the picture, so it is not in the frame');
  const rule = typeof camera.rule === 'string' ? withoutTerminalPunctuation(camera.rule) : '';
  if (rule) parts.push(rule);
  return `Camera: ${parts.join('. ')}.`;
}

/**
 * A character's always-visible line is the camera taking this shot, so the
 * frame must not ask for it. True for the owner, and for whoever holds that
 * owner's in-world camera. A set-down camera still drops the owner's line;
 * it has no holder to drop.
 */
export function shotOmitsOwnedCameraDetail(project, scene, subjectName, detail) {
  const camera = sheetCamera(project, scene);
  const owner = typeof camera?.owner === 'string' ? camera.owner.trim() : '';
  if (!camera || camera.kind === 'observer' || !owner) return false;
  const who = String(subjectName || '').trim().toLowerCase();
  const holder = typeof scene?.shotSheet?.holder === 'string' ? scene.shotSheet.holder.trim() : '';
  const holderKey = holder.toLowerCase();
  const applies = who === owner.toLowerCase() || (holderKey && holderKey !== SHOT_CAMERA_SET_DOWN.toLowerCase() && who === holderKey);
  if (!applies) return false;
  const text = String(detail || '');
  const cameraName = typeof camera.name === 'string' ? camera.name.trim().toLowerCase() : '';
  return (cameraName.length >= 3 && text.toLowerCase().includes(cameraName)) || /\bcameras?\b/i.test(text);
}

/** What a shot is set to render: a photo or video, from its planned medium, else its picture layer. */
function shotOutput(scene, direction) {
  if (direction?.medium === 'still') return 'image';
  if (direction?.medium === 'generated-footage' || direction?.medium === 'existing-footage') return 'video';
  return scene.visualLayer === 'still' ? 'image' : 'video';
}

/** The sheet's rows: timed shots in song order, then untimed ones, each with its sung lyric, camera and frame state. */
export function shotSheetRows(project) {
  const scenes = (project?.scenes || []).filter(Boolean);
  const cameras = new Map((project?.cameras || []).map((camera) => [camera.id, camera]));
  const directions = new Map((project?.treatment?.shotDirections || []).map((direction) => [direction.sceneId, direction]));
  const timed = scenes.filter((scene) => Number.isFinite(scene.startSec)).sort((a, b) => a.startSec - b.startSec);
  const untimed = scenes.filter((scene) => !Number.isFinite(scene.startSec));
  return [...timed, ...untimed].map((scene) => {
    const sheet = scene.shotSheet || {};
    const sung = Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec)
      ? sungLyricTextWithin(project?.lyricCues, scene.startSec, scene.endSec) : null;
    return {
      scene, sheet,
      lyric: (sung || (typeof scene.lyricText === 'string' ? scene.lyricText : '') || '').trim(),
      camera: sheet.cameraId ? cameras.get(sheet.cameraId) || null : null,
      frameOutdated: selectedFrameOutdated(project, scene),
      hasDirection: directions.has(scene.sceneId),
      output: shotOutput(scene, directions.get(scene.sceneId)),
      // The picture layer can disagree with the plan, and a composed render reads the layer.
      layerOutput: scene.visualLayer === 'still' ? 'image' : 'video',
    };
  });
}

// Starting choices for the sheet's pick lists. The director can type anything; what they type is offered on other shots.
export const SHOT_SHEET_SUGGESTIONS = {
  view: ['Wide', 'Medium', 'Close-up', 'Point of view', 'Over the shoulder', 'Low angle', 'High angle', 'Side-on tracking', 'Following from behind', 'Arm\u2019s-length selfie', 'Locked off', 'Handheld'],
  timeOfDay: ['Pre-sunset', 'Golden hour', 'Sunset', 'Dusk', 'Blue hour', 'Night', 'Deep night', 'Dawn', 'Daylight'],
  light: ['Available light', 'Flash', 'Streetlight', 'Headlights', 'Porch light', 'Skylight', 'Lamp', 'Dark'],
  emotion: ['Joyful', 'Playful', 'Laughing', 'Free', 'Tender', 'Contemplative', 'Melancholy', 'Longing', 'Focused', 'Serious', 'Scared', 'Urgent', 'Defiant', 'Awed', 'At peace'],
};

/**
 * The choices a sheet column offers: the project's places for location, its
 * starting list for the others, then everything already typed on any shot,
 * so a video's own wording stays one pick away and spelled the same.
 */
export function shotSheetOptions(project, field) {
  const places = field === 'location'
    ? (project?.concept?.subjects || []).filter((subject) => subject?.kind === 'place' && subject.name).map((subject) => subject.name) : [];
  const used = (project?.scenes || []).map((scene) => scene?.shotSheet?.[field]).filter((value) => typeof value === 'string' && value.trim());
  return [...new Set([...places, ...(SHOT_SHEET_SUGGESTIONS[field] || []), ...used.map((value) => value.trim())])];
}

// The columns every shot needs before its plan is complete, with the label shown when one is empty.
const SHOT_SHEET_REQUIRED = [['cameraId', 'camera'], ['location', 'location'], ['timeOfDay', 'time of day'], ['emotion', 'emotion'], ['action', 'action']];

/**
 * What's wrong with a shot's plan, by rule alone: empty columns, an in-world
 * camera nobody holds or has set down, a camera since removed from the video,
 * and the same action as the shot before it, which is what a re-cut leaves.
 */
export function shotSheetProblems(row, previous = null) {
  const { sheet, camera } = row;
  const missing = SHOT_SHEET_REQUIRED.filter(([field]) => !sheet[field] || (typeof sheet[field] === 'string' && !sheet[field].trim())).map(([, label]) => label);
  if (!sheet.characters?.length) missing.push('who');
  const problems = missing.length ? [`Missing ${missing.join(', ')}`] : [];
  if (sheet.cameraId && !camera) problems.push('Its camera was removed from this video');
  if (camera?.kind === 'in-world' && !sheet.holder) problems.push(`Nobody holds the ${camera.name}`);
  if (camera?.output && (row.output !== camera.output || row.layerOutput !== camera.output)) {
    problems.push(`${camera.name} shoots ${camera.output === 'image' ? 'photos' : 'video'}, but this shot is set to ${row.output === camera.output ? row.layerOutput === 'image' ? 'a photo' : 'video' : row.output === 'image' ? 'a photo' : 'video'}`);
  }
  const action = sheet.action?.trim();
  if (action && action === previous?.sheet?.action?.trim()) problems.push('Same action as the shot before');
  return problems;
}

// The map's bars, top to bottom: what each one reads from a shot's row. A camera shows who has it, so a borrow reads as a change.
export const SHOT_SHEET_MAP_BARS = [
  ['location', 'Location', (row) => row.sheet.location?.trim() || ''],
  ['camera', 'Camera', (row) => (row.camera ? [row.camera.name, row.sheet.holder].filter(Boolean).join(' · ') : '')],
  ['timeOfDay', 'Time of day', (row) => row.sheet.timeOfDay?.trim() || ''],
];

/** The rows a stretch tapped on the map stands for, whichever list is showing them. */
export function shotSheetMapRows(rows, filter) {
  const bar = filter && SHOT_SHEET_MAP_BARS.find(([id]) => id === filter.bar);
  return bar ? rows.filter((row) => bar[2](row) === filter.value) : rows;
}

/**
 * One bar of the video's map: consecutive timed shots with the same value joined
 * into a stretch, with its span and shot count, for reading how the story moves
 * over the song. Shots with no value form their own stretches (`value: ''`).
 */
export function shotSheetStretches(rows, readValue) {
  const stretches = [];
  for (const row of rows) {
    const { scene } = row;
    if (!Number.isFinite(scene.startSec) || !Number.isFinite(scene.endSec)) continue;
    const value = readValue(row);
    const last = stretches.at(-1);
    if (last?.value === value) { last.endSec = scene.endSec; last.shots += 1; }
    else stretches.push({ value, startSec: scene.startSec, endSec: scene.endSec, shots: 1 });
  }
  return stretches;
}

/**
 * An AI backfill of a shot's sheet, filling only the columns that are empty:
 * whatever the director has set stays theirs, and Done is never touched.
 * Returns the merged sheet and which columns it filled.
 */
export function mergeShotSheetBackfill(sheet = {}, proposed = {}) {
  const filled = Object.keys(proposed).filter((field) => field !== 'checked' && field !== 'promptFromSheet' && hasSheetValue(proposed[field]) && !hasSheetValue(sheet?.[field]));
  return { sheet: { ...sheet, ...Object.fromEntries(filled.map((field) => [field, proposed[field]])) }, filled };
}

/**
 * The media changes that bring shots in line with their camera's output: the
 * planned medium and the picture layer. Footage already planned stays as it is
 * when it's on a video camera. A shot with no compiled direction has no medium to
 * plan yet, so only its layer changes.
 */
export function shotSheetMediaEdits(rows) {
  return rows.flatMap(({ scene, camera, output, layerOutput, hasDirection }) => {
    if (!camera?.output || (output === camera.output && layerOutput === camera.output)) return [];
    return [{
      sceneId: scene.sceneId,
      ...(hasDirection && output !== camera.output ? { medium: camera.output === 'image' ? 'still' : 'generated-footage' } : {}),
      ...(layerOutput !== camera.output ? { visualLayer: camera.output === 'image' ? 'still' : 'footage' } : {}),
    }];
  });
}

/**
 * A column set across a run of shots: the sheet each one saves, leaving out shots
 * it wouldn't change. With `onlyEmpty`, a value the director already set stays.
 * Clearing a column (a blank value) removes it. Done is left as it was.
 */
export function shotSheetBulkEdits(rows, field, value, { onlyEmpty = true } = {}) {
  const next = typeof value === 'string' ? value.trim() : value;
  return rows.flatMap(({ scene, sheet }) => {
    if (onlyEmpty && hasSheetValue(sheet[field])) return [];
    if ((sheet[field] ?? '') === (next ?? '')) return [];
    return [{ sceneId: scene.sceneId, shotSheet: normalizeShotSheet({ ...sheet, [field]: next }) }];
  });
}

/**
 * How many shots the director has marked Done on the sheet (stored as
 * `shotSheet.checked`, the box's earlier name). Null while no shot has a sheet
 * yet, so a video planned without the sheet keeps Shots' other done rules.
 */
export function shotSheetDoneProgress(project) {
  const scenes = (project?.scenes || []).filter(Boolean);
  if (!scenes.some((scene) => scene.shotSheet)) return null;
  const done = scenes.filter((scene) => scene.shotSheet?.checked === true).length;
  return { done, total: scenes.length, all: done === scenes.length };
}

/**
 * The sheets that mark every listed shot Done, leaving out shots already done.
 * Nothing else in a sheet changes.
 */
export function shotSheetMarkDoneEdits(rows) {
  return rows.flatMap(({ scene, sheet }) => (sheet?.checked === true ? [] : [{ sceneId: scene.sceneId, shotSheet: normalizeShotSheet({ ...sheet, checked: true }) }]));
}

/** The cast the sheet's character picker offers: the project's character subjects, by name. */
export function shotSheetCast(project) {
  return activeMusicVideoSubjects(project?.concept)
    .filter((subject) => subject?.kind === 'character' && subject.name)
    .map((subject) => subject.name);
}
