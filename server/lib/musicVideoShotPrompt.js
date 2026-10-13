/**
 * The model input for a Music Video shot's clip and its start and end frames
 * (#11317): the director's own text, then each block PortOS adds as a labeled
 * addition the UI lists as a chip. Shared by the shot card (its "Sent to the model" view), the board's
 * renders and the server's video submit, so what the card shows is what the
 * submit sends.
 *
 * A take that hears no audio is composed without the blocks it cannot use: no
 * project look (the reference frame already carries it, and a silent i2v model
 * acts style words out literally) and no lyric, word or onset timings. Nothing
 * is removed from the director's text.
 */
import { AUDIO_REACTIVE_PERFORMANCE_GUARD, MOTION_CONTINUITY_CLAUSE } from './musicVideoMotion.js';
import { musicVideoCreativeContext, musicVideoDirectorLook } from './musicVideoCreativeContext.js';
import { shotCameraPrompt } from './cameraMovements.js';
import { shotActionPrompt } from './musicVideoActionContract.js';
import { approximateMotionCues } from './musicVideoShotTiming.js';

/**
 * The project-wide visual direction: palette and camera rules from the visual
 * spec (#8965). Typography is excluded (#8992): it belongs to the composited
 * text layer, not to the image or video model's prompt.
 */
export function visualDirection(spec) {
  if (!spec) return '';
  return [
    spec.palette?.length ? `color palette ${spec.palette.join(' ')}` : '',
    spec.cameraRules?.trim() ? `camera: ${spec.cameraRules.trim()}` : '',
  ].filter(Boolean).join('; ');
}

/** The director's text for a shot's clip: its shot prompt, else its frame prompt. */
export const authoredShotPrompt = (scene) => scene?.prompt?.trim() || scene?.framePrompt?.trim() || '';

const addition = (id, label, text) => {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  return trimmed ? { id, label, text: trimmed } : null;
};

/**
 * `{ prompt, promptAdditions }` for one clip. `authored` is the director's text
 * (the shot card's box, or the scene's saved prompt). `asTyped` is the shot
 * card's Render, which adds no project look or treatment direction. `hears` is
 * whether the take hears song audio (lip-sync, supplied song audio or an
 * audio-reactive LoRA); `offsetSec` re-times the shot actions to a performance
 * take's padded song slice; `fixes` is an autonomous run's repair note.
 */
export function musicVideoShotModelInput(project, scene, {
  authored = authoredShotPrompt(scene), asTyped = false, hears = false, backend = null,
  audioReactive = false, offsetSec = 0, fixes = '',
} = {}) {
  const text = typeof authored === 'string' ? authored.trim() : '';
  const look = !asTyped && hears ? [
    addition('project-style', 'Project style', project?.concept?.style),
    addition('creative-context', 'Production bible', musicVideoCreativeContext(project?.concept, { moodBoard: false, look: musicVideoDirectorLook(project) })),
    addition('visual-direction', 'Palette and camera rules', visualDirection(project?.visualSpec)),
  ] : [];
  const direction = asTyped ? [] : [
    addition('shot-direction', 'Shot direction', scene?.direction?.motionClause),
    addition('lighting-continuity', 'Lighting continuity', MOTION_CONTINUITY_CLAUSE),
  ];
  // A take that hears no audio cannot land a move on the downbeat; the shot card's camera stays as shown.
  const cameraSpec = !hears && !asTyped && scene?.camera?.onBeat ? { ...scene.camera, onBeat: false } : scene?.camera;
  const camera = addition('camera-move', 'Camera move', shotCameraPrompt(cameraSpec));
  const actions = addition('shot-actions', 'Shot actions', project ? shotActionPrompt(project, scene, { offsetSec, heard: hears }) : '');
  const tail = audioReactive
    ? [addition('audio-reactive-guard', 'Audio-reactive guard', AUDIO_REACTIVE_PERFORMANCE_GUARD)]
    : [
      addition('phrase-timing', 'Phrase timing (approximate)', backend === 'grok' ? approximateMotionCues(project?.phrases, scene?.startSec, scene?.endSec) : ''),
      addition('repair-notes', 'Repair notes', fixes ? `Fix these problems from the previous take while preserving the shot intent: ${fixes}` : ''),
    ];

  const firstLine = [text, ...[...look, ...direction].filter(Boolean).map((item) => item.text)].filter(Boolean).join(', ');
  const body = [firstLine, camera?.text, actions?.text].filter(Boolean).join('\n');
  const prompt = [body, ...tail.filter(Boolean).map((item) => item.text)].filter(Boolean).join('. ');
  return { prompt, promptAdditions: [...look, ...direction, camera, actions, ...tail].filter(Boolean) };
}

/** A refine edit's wrapper around the director's instruction ("[instruction]" marks where it goes). */
const refineWrapper = (instruction) => `Edit the reference image: ${instruction}. Keep everything else exactly as it is: composition, framing, subject, lighting, color and film look.`;
const REWORK_FRAME = 'Start from the first reference image and rework it to match this prompt.';
const KEEP_REFERENCE = 'Keep the reference image\'s composition, subject and framing; change only what this prompt describes.';

/** The director's text for a shot's start or end frame. */
export const authoredFramePromptText = (scene, slot = 'start') => (slot === 'end'
  ? scene?.endFramePrompt?.trim() || ''
  : scene?.framePrompt?.trim() || scene?.prompt?.trim() || '');

/**
 * `{ prompt, promptAdditions }` for a shot's still: its start frame (`slot`
 * 'start') or style-break end frame ('end'). `fromFrame` is a render that
 * reworks a picked frame (the first reference image); `refine` makes `authored`
 * an edit instruction for that frame, wrapped and sent with nothing else.
 * `repairs` (plate mismatches) and `fixes` (a stills review's notes) are an
 * autonomous run's repair notes. The frame text keeps the project look the
 * mood board's own style block joins later (imageGen/prepareParams.js).
 */
export function musicVideoFrameModelInput(project, scene, {
  slot = 'start', authored = authoredFramePromptText(scene, slot), fromFrame = false, refine = false,
  repairs = [], fixes = '',
} = {}) {
  const text = typeof authored === 'string' ? authored.trim() : '';
  if (!text) return { prompt: '', promptAdditions: [] };
  if (refine) {
    return { prompt: refineWrapper(text), promptAdditions: [addition('edit-instructions', 'Edit instructions', refineWrapper('[instruction]'))] };
  }
  if (slot === 'end' && fromFrame) {
    return { prompt: `${text}. ${KEEP_REFERENCE}`, promptAdditions: [addition('keep-reference', 'Keep the start frame', KEEP_REFERENCE)] };
  }
  const look = [
    addition('project-style', 'Project style', project?.concept?.style),
    addition('creative-context', 'Production bible', musicVideoCreativeContext(project?.concept, { look: musicVideoDirectorLook(project) })),
    addition('visual-direction', 'Palette and camera rules', visualDirection(project?.visualSpec)),
    ...(slot === 'end' ? [] : [addition('frame-direction', 'Frame direction', scene?.direction?.frameClause)]),
  ].filter(Boolean);
  const firstLine = [text, ...look.map((item) => item.text)].join(', ');
  if (slot === 'end') return { prompt: firstLine, promptAdditions: look };
  const unmet = [...new Set(repairs)];
  const tail = [
    addition('shot-actions', 'Shot actions', project ? shotActionPrompt(project, scene, { frame: true }) : ''),
    fromFrame ? addition('rework-frame', 'Rework the picked frame', REWORK_FRAME) : null,
    addition('plate-repairs', 'Plate repairs', unmet.length ? `Repair these visible plate mismatches while preserving the shot intent:\n${unmet.join('\n')}` : ''),
    addition('repair-notes', 'Repair notes', fixes ? `Fix these visible problems from the previous still while preserving the shot intent:\n${fixes}` : ''),
  ].filter(Boolean);
  return { prompt: [firstLine, ...tail.map((item) => item.text)].join('\n'), promptAdditions: [...look, ...tail] };
}
