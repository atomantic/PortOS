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
// A holder value for an in-world camera left running with nobody behind it.
export const SHOT_CAMERA_SET_DOWN = 'Set down';

// The sheet's free-text columns, in reading order, with their character limits.
export const SHOT_SHEET_TEXT_FIELDS = [
  ['view', 1000], ['location', 200], ['light', 300], ['action', 2000], ['emotion', 300], ['notes', 2000],
];

const hasSheetValue = (value) => (Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? value.trim() !== '' : value != null);

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

/** The cast the sheet's character picker offers: the project's character subjects, by name. */
export function shotSheetCast(project) {
  return (project?.concept?.subjects || [])
    .filter((subject) => subject?.kind === 'character' && subject.name)
    .map((subject) => subject.name);
}
