/**
 * The model input for a Music Video shot's clip (#11317): the director's own
 * text, then each block PortOS adds as a labeled addition the UI lists as a
 * chip. Shared by the shot card (its "Sent to the model" view), the board's
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
  const camera = addition('camera-move', 'Camera move', shotCameraPrompt(scene?.camera));
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
