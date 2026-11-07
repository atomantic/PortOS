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
import { productionMediumAddition } from './musicVideoProductionMedium.js';
import { peopleLightLine } from './musicVideoSnapshotLight.js';
import { falHearsAudioReference, getFalVideoModel } from './falVideoModels.js';
import { storyboardPanelShotText } from './storyboardRecipe.js';
import { musicVideoSubjectScaleText } from './musicVideoSubjectScale.js';
import { musicVideoReferenceSubjectIds } from './musicVideoCastSelection.js';
import { musicVideoConditioningReferences } from './musicVideoConditioning.js';
import { routeMapShotText } from './musicVideoRouteMaps.js';
import { shotSheetDrivesPrompt, shotSheetPromptLines } from './musicVideoShotSheet.js';

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

/**
 * A storyboard-linked shot's direction: its panel's action, which the
 * storyboard sync keeps current on the shot (`visualIntent`). '' off a panel.
 */
export const storyboardShotDirection = (scene) => (scene?.panelId ? scene?.visualIntent?.trim() || '' : '');

/**
 * The director's text for a shot's clip: its own shot prompt, else its
 * storyboard panel's direction (read live, so it follows panel edits), else
 * its frame prompt.
 */
export const authoredShotPrompt = (scene) => scene?.prompt?.trim() || storyboardShotDirection(scene)
  // A detail-built shot's frame prompt is the still's general prompt, so its clip never borrows it.
  || (shotSheetDrivesPrompt(scene) ? '' : scene?.framePrompt?.trim()) || '';

const addition = (id, label, text) => {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  return trimmed ? { id, label, text: trimmed } : null;
};

/**
 * What a reference model is told about the song slice it hears (and, where its
 * start frame is only a reference, that frame), in the names its prompt uses
 * for them; '' for a model that hears no audio reference.
 */
function audioReferencePrompt(modelId) {
  const model = getFalVideoModel(modelId);
  if (!falHearsAudioReference(model)) return '';
  const frame = model.image ? '' : `${model.referenceImages?.promptName || 'Image 1'} is the opening frame. `;
  return `${frame}${model.referenceAudio.promptName || 'Audio 1'} is the song playing under this shot: time the movement to its beat.`;
}

/**
 * `{ prompt, promptAdditions }` for one clip. `authored` is the director's text
 * (the shot card's box, or the scene's saved prompt). `asTyped` is the shot
 * card's Render, which adds no project look or treatment direction. `hears` is
 * whether the take hears song audio (lip-sync, supplied song audio or an
 * audio-reactive LoRA); `offsetSec` re-times the shot actions to a performance
 * take's padded song slice; `fixes` is an autonomous run's repair note.
 * `audioReferenceModelId` is the fal model of a music-driven take that hears
 * the song slice as a reference, which its prompt then names.
 */
function composeShotModelInput(project, scene, {
  authored = authoredShotPrompt(scene), asTyped = false, hears = false, backend = null,
  audioReactive = false, offsetSec = 0, fixes = '', audioReferenceModelId = null,
} = {}) {
  const text = typeof authored === 'string' ? authored.trim() : '';
  // A local renderer animates a start frame that already shows who and where, and its text
  // encoder is short (LTX-2: 1024 Gemma tokens), so the production bible would overflow it.
  const bible = backend !== 'local';
  const look = !asTyped && hears ? [
    addition('project-style', 'Project style', project?.concept?.style),
    bible ? addition('creative-context', 'Production bible', musicVideoCreativeContext(project?.concept, { moodBoard: false, look: musicVideoDirectorLook(project) })) : null,
    addition('visual-direction', 'Palette and camera rules', visualDirection(project?.visualSpec)),
  ] : [];
  const direction = asTyped ? [] : [
    addition('shot-direction', 'Shot direction', scene?.direction?.motionClause),
    addition('lighting-continuity', 'Lighting continuity', MOTION_CONTINUITY_CLAUSE),
    productionMediumAddition(project),
  ];
  // A take that hears no audio cannot land a move on the downbeat; the shot card's camera stays as shown.
  const cameraSpec = !hears && !asTyped && scene?.camera?.onBeat ? { ...scene.camera, onBeat: false } : scene?.camera;
  const camera = addition('camera-move', 'Camera move', shotCameraPrompt(cameraSpec));
  // Where the shot is on a route map, so neighbouring shots keep one direction of travel.
  const route = addition('route-map', 'Route', routeMapShotText(project, scene));
  const actions = addition('shot-actions', 'Shot actions', project ? shotActionPrompt(project, scene, { offsetSec, heard: hears }) : '');
  const tail = audioReactive
    ? [addition('audio-reactive-guard', 'Audio-reactive guard', AUDIO_REACTIVE_PERFORMANCE_GUARD)]
    : [
      addition('audio-reference', 'Song audio reference', audioReferenceModelId ? audioReferencePrompt(audioReferenceModelId) : ''),
      addition('phrase-timing', 'Phrase timing (approximate)', backend === 'grok' ? approximateMotionCues(project?.phrases, scene?.startSec, scene?.endSec) : ''),
      addition('repair-notes', 'Repair notes', fixes ? `Fix these problems from the previous take while preserving the shot intent: ${fixes}` : ''),
    ];

  // A detail-built shot's details follow the director's motion text, each its own labeled part.
  const sheet = shotSheetPromptLines(project, scene);
  const firstLine = [text, ...[...look, ...direction].filter(Boolean).map((item) => item.text)].filter(Boolean).join(', ');
  const body = [firstLine, ...sheet.map((item) => item.text), camera?.text, route?.text, actions?.text].filter(Boolean).join('\n');
  const prompt = [body, ...tail.filter(Boolean).map((item) => item.text)].filter(Boolean).join('. ');
  return { prompt, promptAdditions: [...sheet, ...look, ...direction, camera, route, actions, ...tail].filter(Boolean) };
}

/** A refine edit's wrapper around the director's instruction ("[instruction]" marks where it goes). */
const refineWrapper = (instruction, first = false) => `Edit the ${first ? 'first ' : ''}reference image: ${instruction}. Keep everything else exactly as it is: composition, framing, subject, lighting, color and film look.`;
const REWORK_FRAME = 'Start from the first reference image and rework it to match this prompt.';
const KEEP_REFERENCE = 'Keep the reference image\'s composition, subject and framing; change only what this prompt describes.';
// Sent when a refine or an end frame from a frame carries the shot's character or set references after that frame.
export const MUSIC_VIDEO_OTHER_REFERENCES_NOTE = 'The other reference images show the characters and places in this shot: keep their faces, hair and wardrobe as shown there.';

/**
 * The director's text for a shot's start or end frame. A sheet-built start
 * frame's text is its general prompt alone (its ingredients are composed in),
 * so it never borrows the motion prompt.
 */
export const authoredFramePromptText = (scene, slot = 'start') => (slot === 'end'
  ? scene?.endFramePrompt?.trim() || ''
  : scene?.framePrompt?.trim() || (shotSheetDrivesPrompt(scene) ? '' : scene?.prompt?.trim() || ''));

// Which panel id list names a subject of each kind.
const PANEL_SUBJECT_IDS = { character: 'castIds', place: 'environmentIds', object: 'objectIds' };

/**
 * The subjects a still describes (its production bible and scale lines): those
 * its references show (musicVideoReferenceSubjectIds), its picked set and cast
 * variant, and those its storyboard panel names. A place, object or person the
 * shot neither sends nor names is left out, so its description cannot pull it
 * into the frame. A subject no shot can attach (a director's text-only subject
 * with no catalog link or Cast & Sets asset) stays, as nothing else picks it.
 * `references` defaults to the shot's own conditioning set when the caller
 * does not know what it sends.
 */
function shotSubjects(project, scene, { panel = null, references } = {}) {
  const subjects = project?.concept?.subjects;
  if (!Array.isArray(subjects)) return subjects;
  const refs = Array.isArray(references) ? references : musicVideoConditioningReferences(project, scene);
  const ids = new Set(refs.flatMap((ref) => musicVideoReferenceSubjectIds(project, ref)));
  if (scene?.setReference?.subjectId) ids.add(scene.setReference.subjectId);
  const variant = scene?.characterVariant?.ingredientId;
  const checkedIn = new Set((project?.castAndSets?.catalogCheckin?.items || []).map((item) => item.subjectId));
  const attachable = (subject) => Boolean(subject?.ingredientId) || String(subject?.id || '').startsWith('cs-') || checkedIn.has(subject?.id);
  const inShot = (subject) => ids.has(subject.id) || (Boolean(subject.ingredientId)
    && (subject.ingredientId === variant || (panel?.[PANEL_SUBJECT_IDS[subject.kind]] || []).includes(subject.ingredientId)));
  return subjects.filter((subject) => !attachable(subject) || inShot(subject));
}

/**
 * Which reference image is whom, in send order. A still conditioned on
 * two people's sheets, a set plate and a prop sheet is otherwise left to guess
 * which face belongs to which person, and the character notes in the
 * production bible are abbreviated before they reach face and hair.
 * `references` are visual-spec references in the order the render sends them;
 * a null entry (a picked frame, an upload) keeps its position but says nothing.
 * The storyboard panel has its own note. Returns '' when no character, set or
 * prop or wardrobe reference is sent.
 */
function musicVideoReferenceMapText(references = []) {
  const lines = (Array.isArray(references) ? references : []).flatMap((ref, i) => {
    const n = i + 1;
    if (!ref || ref.panelArt) return [];
    const label = typeof ref.label === 'string' && ref.label.trim() ? ref.label : 'a reference';
    const note = typeof ref.note === 'string' ? ref.note : '';
    if (ref.role === 'character') {
      return [`Reference image ${n} is ${label}: this exact person. Match their face, hair, skin, build and age exactly${note ? ` (${note})` : ''}; never blend their face with anyone else's.`];
    }
    if (ref.role === 'subject') {
      return [`Reference image ${n} is a real photo of ${label}: the subject in the shot looks exactly like it (shape, proportions, coat or surface, colours and markings). Take only the subject, never its background, framing or light.`];
    }
    if (ref.role === 'set') return [`Reference image ${n} is the set reference "${label}": use its place, period and light.`];
    if (ref.role === 'prop') return [`Reference image ${n} is the prop sheet: every object from it that appears in the shot looks exactly as shown there${note ? ` (${note})` : ''}. Never show the sheet itself, its captions or its backdrop.`];
    if (ref.role === 'wardrobe') return [`Reference image ${n} is the wardrobe sheet "${label}": dress the people exactly as shown there.`];
    return [];
  });
  return lines.join(' ');
}

const storyboardSketchNote = (position) => `Reference image ${position} is the storyboard sketch for this shot: copy its camera angle, framing and where each person is, and add no one it does not show. Take only its layout, not its sketch style.`;

/**
 * `{ prompt, promptAdditions }` for a shot's still: its start frame (`slot`
 * 'start') or style-break end frame ('end'). `fromFrame` is a render that
 * reworks a picked frame (the first reference image); `refine` makes `authored`
 * an edit instruction for that frame, wrapped and sent with nothing else.
 * `repairs` (plate mismatches) and `fixes` (a stills review's notes) are an
 * autonomous run's repair notes. The frame text keeps the project look the
 * mood board's own style block joins later (imageGen/prepareParams.js).
 *
 * `panel` is the shot's live storyboard panel (a start frame from its prompt
 * only): its action stands in for an empty frame prompt, its shot picks and
 * the place of its sketch among the references (`panelReference`, 1-based,
 * 0 when not sent) lead the prompt, and the bible also names the subjects it
 * puts in frame.
 *
 * `references` are the sent references in send order (the reference map); the
 * bible and scale lines describe only the subjects they show (shotSubjects).
 * `subjectReferences` stands in for them there when send positions are unknown
 * (a peer-routed render). Neither given: the shot's own conditioning set.
 *
 * `sizes` is `{ [subjectId]: text }` (loadMusicVideoSubjectSizes): the real-world
 * heights and sizes of the shot's subjects, stated as their own addition.
 */
function composeFrameModelInput(project, scene, {
  slot = 'start', authored = authoredFramePromptText(scene, slot), fromFrame = false, refine = false,
  repairs = [], fixes = '', otherReferences = 0, panel = null, panelReference = 0, references, subjectReferences, sizes = null,
} = {}) {
  const others = otherReferences > 0 ? addition('other-references', 'Character references', MUSIC_VIDEO_OTHER_REFERENCES_NOTE) : null;
  const text = typeof authored === 'string' ? authored.trim() : '';
  // A refine or an end frame from the start frame says only what changes, so it needs text;
  // a planned shot with no seeded text still gets its look, frame clause and actions.
  if (!text && (refine || slot === 'end')) return { prompt: '', promptAdditions: [] };
  if (refine) {
    return { prompt: [refineWrapper(text, !!others), others?.text].filter(Boolean).join(' '),
      promptAdditions: [addition('edit-instructions', 'Edit instructions', refineWrapper('[instruction]', !!others)), others].filter(Boolean) };
  }
  if (slot === 'end' && fromFrame) {
    return { prompt: [`${text}. ${KEEP_REFERENCE}`, others?.text].filter(Boolean).join(' '),
      promptAdditions: [addition('keep-reference', 'Keep the start frame', KEEP_REFERENCE), others].filter(Boolean) };
  }
  // A sheet-built still's ingredients follow its general prompt, each its own labeled part.
  const sheet = slot === 'start' ? shotSheetPromptLines(project, scene) : [];
  const shotText = [text, ...sheet.map((item) => item.text)].filter(Boolean).join('\n');
  const board = slot === 'start' && !fromFrame ? panel : null;
  const storyboard = board ? [
    shotText ? null : addition('storyboard-action', 'Storyboard action', board.action),
    addition('storyboard-shot', 'Storyboard shot', storyboardPanelShotText(board)),
    panelReference > 0 ? addition('storyboard-sketch', 'Storyboard sketch', storyboardSketchNote(panelReference)) : null,
  ].filter(Boolean) : [];
  const concept = project?.concept ? { ...project.concept, subjects: shotSubjects(project, scene, { panel: board, references: subjectReferences ?? references }) } : project?.concept;
  const look = [
    addition('reference-map', 'Reference images', musicVideoReferenceMapText(references)),
    addition('project-style', 'Project style', project?.concept?.style),
    addition('creative-context', 'Production bible', musicVideoCreativeContext(concept, { look: musicVideoDirectorLook(project) })),
    addition('real-world-scale', 'Real-world scale', musicVideoSubjectScaleText(concept, sizes)),
    addition('route-map', 'Route', routeMapShotText(project, scene)),
    addition('visual-direction', 'Palette and camera rules', visualDirection(project?.visualSpec)),
    ...(slot === 'end' ? [] : [addition('frame-direction', 'Frame direction', scene?.direction?.frameClause)]),
    productionMediumAddition(project),
    addition('people-light', 'Lighting on people', peopleLightLine([project?.concept?.style, musicVideoDirectorLook(project)])),
  ].filter(Boolean);
  const lookText = look.map((item) => item.text).join(', ');
  // The storyboard leads on its own lines, ahead of the long look blocks.
  const firstLine = storyboard.length || sheet.length
    ? [shotText, ...storyboard.map((item) => item.text), lookText].filter(Boolean).join('\n')
    : [text, lookText].filter(Boolean).join(', ');
  if (slot === 'end') return { prompt: firstLine, promptAdditions: look };
  const unmet = [...new Set(repairs)];
  const tail = [
    addition('shot-actions', 'Shot actions', project ? shotActionPrompt(project, scene, { frame: true }) : ''),
    fromFrame ? addition('rework-frame', 'Rework the picked frame', REWORK_FRAME) : null,
    addition('plate-repairs', 'Plate repairs', unmet.length ? `Repair these visible plate mismatches while preserving the shot intent:\n${unmet.join('\n')}` : ''),
    addition('repair-notes', 'Repair notes', fixes ? `Fix these visible problems from the previous still while preserving the shot intent:\n${fixes}` : ''),
  ].filter(Boolean);
  return { prompt: [firstLine, ...tail.map((item) => item.text)].filter(Boolean).join('\n'), promptAdditions: [...sheet, ...storyboard, ...look, ...tail] };
}

const withGreybox = (input, greybox) => {
  const additions = greybox?.promptAdditions || [];
  return additions.length ? { prompt: [input.prompt, ...additions.map((a) => a.text)].filter(Boolean).join('\n'),
    promptAdditions: [...input.promptAdditions, ...additions] } : input;
};

export function musicVideoShotModelInput(project, scene, options = {}) {
  return withGreybox(composeShotModelInput(project, scene, options), options.greybox);
}

export function musicVideoFrameModelInput(project, scene, options = {}) {
  return withGreybox(composeFrameModelInput(project, scene, options), options.greybox);
}
