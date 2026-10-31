/**
 * Start a Video from a storyboard — the board's panels as Video (Creative
 * Director) shots: one shot per panel in board order, its intent and prompt
 * from the panel's own words, its length from the panel's seconds (or the
 * default hold) in whole seconds up to the Video shot maximum. A beat with no
 * panels still gives one shot from its words, so no beat is dropped. Shared by
 * the drawer's preview (in the browser) and the write (on the server), so the
 * shots written are the ones shown. No model call.
 *
 * Browser-safe: no node-only imports.
 */

import { STORYBOARD_DEFAULT_HOLD_SEC } from './storyboardSongBrief.js';
import { STORYBOARD_MUSICAL_ROLE_LABELS } from './storyboardVocabulary.js';

// Bounds of the Video treatment schema (creativeDirectorValidation.js).
export const STORYBOARD_VIDEO_LIMITS = Object.freeze({
  shotMaxSec: 10, totalMinSec: 5, totalMaxSec: 600, shots: 120, cast: 50,
});
const TEXT = { intent: 1000, logline: 500, synopsis: 5000, script: 50000 };

const FRAMING_WORDS = Object.freeze({
  'extreme-wide': 'Extreme wide shot', wide: 'Wide shot', full: 'Full shot', 'medium-wide': 'Medium wide shot',
  medium: 'Medium shot', 'medium-close': 'Medium close-up', close: 'Close-up',
  'extreme-close': 'Extreme close-up', insert: 'Insert shot', 'over-the-shoulder': 'Over-the-shoulder shot', 'two-shot': 'Two-shot', pov: 'POV shot',
});
const ANGLE_WORDS = Object.freeze({
  'eye-level': 'Eye-level angle', high: 'High angle', low: 'Low angle',
  'birds-eye': "Bird's-eye view", 'worms-eye': "Worm's-eye view", dutch: 'Dutch angle',
});
const FACING_WORDS = Object.freeze({
  front: 'Subject faces the camera head-on', 'three-quarter': 'Subject in three-quarter view', profile: 'Subject in side profile',
  'three-quarter-back': 'Subject turned mostly away from the camera', back: 'Subject seen from behind, facing away from the camera',
});
const COMPOSITION_WORDS = Object.freeze({
  center: 'Subject centered in frame', 'left-third': 'Subject on the left third of the frame', 'right-third': 'Subject on the right third of the frame',
  'cut-left': 'Subject at the left edge, partly out of frame', 'cut-right': 'Subject at the right edge, partly out of frame', 'low-in-frame': 'Subject low in frame, empty space above',
});

const clip = (text, max) => String(text || '').trim().slice(0, max);
const sentence = (text) => (/[.!?…]["')\]]?$/.test(text) ? text : `${text}.`);
const beatTitle = (beat, index) => clip(beat.title || STORYBOARD_MUSICAL_ROLE_LABELS[beat.musicalRole] || `Beat ${index + 1}`, 120);

/** A panel's Video prompt: its action, framing, angle, facing, composition and camera move, as written on the panel. */
function storyboardVideoPrompt(panel, fallback) {
  const action = clip(panel?.action, 4000) || clip(fallback, 4000);
  return [action, FRAMING_WORDS[panel?.framing], ANGLE_WORDS[panel?.angle], FACING_WORDS[panel?.facing],
    COMPOSITION_WORDS[panel?.composition], panel?.camera ? `Camera: ${clip(panel.camera, 400)}` : null]
    .filter(Boolean).map(sentence).join(' ');
}

/**
 * The Video plan for a board: `shots` (treatment scenes, each with the
 * `beatId`/`panelId` it came from, `trimmed` when the panel ran past the shot
 * maximum, and the catalog ids it shows), `totalSeconds`, the catalog ids
 * across the board (`catalogIds`, capped), the treatment text, and `problem`
 * when the board can't make a Video yet (null when it can).
 */
export function storyboardVideoPlan(board) {
  const L = STORYBOARD_VIDEO_LIMITS;
  const beats = board?.beats || [];
  const shots = [];
  const script = [];
  beats.forEach((beat, b) => {
    const title = beatTitle(beat, b);
    script.push(`${b + 1}. ${title}${beat.what ? ` — ${clip(beat.what, 2000)}` : ''}`);
    const words = clip(beat.what, 2000) || title;
    (beat.panels.length ? beat.panels : [null]).forEach((panel, p) => {
      const hold = panel?.seconds > 0 ? panel.seconds : STORYBOARD_DEFAULT_HOLD_SEC;
      const prompt = storyboardVideoPrompt(panel, words);
      shots.push({
        sceneId: `scene-${shots.length + 1}`,
        order: shots.length,
        beatId: beat.id,
        panelId: panel?.id || null,
        label: beat.panels.length > 1 ? `${title} · ${p + 1}/${beat.panels.length}` : title,
        intent: clip(panel?.action, TEXT.intent) || clip(words, TEXT.intent),
        prompt,
        durationSeconds: Math.min(L.shotMaxSec, Math.max(1, Math.round(hold))),
        trimmed: hold > L.shotMaxSec + 0.5,
        catalogIds: panel ? [...new Set([...(panel.castIds || []), ...(panel.environmentIds || []), ...(panel.objectIds || [])])] : [],
      });
      if (panel) script.push(`   ${b + 1}.${p + 1} ${prompt}${panel.dialogue ? ` "${clip(panel.dialogue, 2000)}"` : ''}`);
    });
  });
  const totalSeconds = shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  const catalogIds = [...new Set(shots.flatMap((shot) => shot.catalogIds))].slice(0, L.cast);
  let problem = null;
  if (!beats.length) problem = 'Add beats and panels first; each panel becomes a shot.';
  else if (shots.length > L.shots) problem = `The board makes ${shots.length} shots; a video holds at most ${L.shots}.`;
  else if (totalSeconds < L.totalMinSec) problem = `The shots run ${totalSeconds} s; a video needs at least ${L.totalMinSec} s. Give the panels more seconds.`;
  else if (totalSeconds > L.totalMaxSec) problem = `The shots run ${totalSeconds} s; a video runs at most ${L.totalMaxSec} s.`;
  const name = clip(board?.name, 200) || 'Untitled storyboard';
  return {
    shots,
    totalSeconds,
    catalogIds,
    problem,
    logline: clip(board?.logline, TEXT.logline) || name,
    synopsis: clip(board?.plot, TEXT.synopsis)
      || clip(beats.map((beat, b) => sentence(clip(beat.what, 2000) || beatTitle(beat, b))).join(' '), TEXT.synopsis) || name,
    script: clip(script.join('\n'), TEXT.script) || name,
  };
}
