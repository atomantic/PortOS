/**
 * The shot sheet: every shot's plan on one screen, read and edited without
 * rendering anything. A shot's sheet (`scene.shotSheet`) names what the shot is
 * meant to be: which camera we look through and who holds it, the view, where
 * and when it is, who is in it, what they do and what they feel. The project's
 * `cameras` list says which cameras exist in this video. The sheet is the
 * director's plan beside the frame and motion prompts: nothing here reaches a
 * model on its own.
 */
import { sungLyricTextWithin } from './musicVideoLyricAnchors.js';

export const SHOT_CAMERA_KINDS = ['in-world', 'observer'];
export const SHOT_CAMERA_MAX = 12;
export const SHOT_SHEET_CHARACTERS_MAX = 24;
// Shots per AI request, so one reply stays short enough to read and retry.
export const SHOT_SHEET_PROPOSE_BATCH = 15;
// A holder value for an in-world camera left running with nobody behind it.
export const SHOT_CAMERA_SET_DOWN = 'Set down';

// The sheet's free-text columns, in reading order, with their character limits.
export const SHOT_SHEET_TEXT_FIELDS = [
  ['view', 1000], ['location', 200], ['light', 300], ['action', 2000], ['emotion', 300], ['notes', 2000],
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
 * judged and reads as current. Takes record the composed prompt, which leads
 * with or contains the shot's own text, so this looks for that text within it.
 */
export function selectedFrameOutdated(scene) {
  const framePrompt = typeof scene?.framePrompt === 'string' ? scene.framePrompt.trim() : '';
  if (!framePrompt || !scene?.referenceImageId) return false;
  const take = (Array.isArray(scene.takes) ? scene.takes : [])
    .find((entry) => entry?.kind === 'image' && entry.assetId === scene.referenceImageId);
  if (typeof take?.prompt !== 'string' || !take.prompt) return false;
  return !take.prompt.includes(framePrompt.slice(0, 120));
}

/** The sheet's rows: timed shots in song order, then untimed ones, each with its sung lyric, camera and frame state. */
export function shotSheetRows(project) {
  const scenes = (project?.scenes || []).filter(Boolean);
  const cameras = new Map((project?.cameras || []).map((camera) => [camera.id, camera]));
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
      frameOutdated: selectedFrameOutdated(scene),
    };
  });
}

// Starting choices for the sheet's pick lists. The director can type anything; what they type is offered on other shots.
export const SHOT_SHEET_SUGGESTIONS = {
  view: ['Wide', 'Medium', 'Close-up', 'Point of view', 'Over the shoulder', 'Low angle', 'High angle', 'Side-on tracking', 'Following from behind', 'Arm\u2019s-length selfie', 'Locked off', 'Handheld'],
  light: ['Golden hour', 'Sunset', 'Dusk', 'Blue hour', 'Night', 'Deep night', 'Dawn', 'Daylight', 'Flash', 'Streetlight', 'Headlights'],
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
const SHOT_SHEET_REQUIRED = [['cameraId', 'camera'], ['location', 'location'], ['light', 'time and light'], ['emotion', 'emotion'], ['action', 'action']];

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
  const action = sheet.action?.trim();
  if (action && action === previous?.sheet?.action?.trim()) problems.push('Same action as the shot before');
  return problems;
}

/**
 * An AI backfill of a shot's sheet, filling only the columns that are empty:
 * whatever the director has set stays theirs, and Checked is never touched.
 * Returns the merged sheet and which columns it filled.
 */
export function mergeShotSheetBackfill(sheet = {}, proposed = {}) {
  const filled = Object.keys(proposed).filter((field) => field !== 'checked' && hasSheetValue(proposed[field]) && !hasSheetValue(sheet?.[field]));
  return { sheet: { ...sheet, ...Object.fromEntries(filled.map((field) => [field, proposed[field]])) }, filled };
}

/** The cast the sheet's character picker offers: the project's character subjects, by name. */
export function shotSheetCast(project) {
  return (project?.concept?.subjects || [])
    .filter((subject) => subject?.kind === 'character' && subject.name)
    .map((subject) => subject.name);
}
