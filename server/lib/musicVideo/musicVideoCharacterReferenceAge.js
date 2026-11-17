/**
 * Which Music Video frames and clips were rendered without a character's current reference image (#16473): a warning, never a gate.
 *
 * A take records the character references a render actually sent (`castInputs.characters`, captured by
 * musicVideoCastLook `characterInputsFromReferences`). Its state compares them with the character references a render of
 * the shot would send now (the same conditioning the render reads, from the project record alone):
 *
 *   - recorded inputs: a character is flagged when a reference it was sent now holds another image, or
 *     when none of its current references is among the inputs. Takes from before `characters` was
 *     recorded carry only their Cast & Sets sheets (`castInputs.sheets`), so only those are compared.
 *   - no recorded inputs (a frame from before #14154): flagged only when a current reference's own
 *     change time is recorded (a Cast & Sets sheet image's `updatedAt`) and later than the take.
 *   - neither known, a shot with no characters, an imported frame: not flagged.
 *
 * A clip is also flagged when the frame it started from is. "Still matches" stores
 * `take.characterReferenceAcceptance.revision`; the state's revision is a checksum of the flagged
 * characters' current references, so a later reference change raises the warning again.
 * This only reports: nothing here changes what a render sends.
 */

import { canonicalSnapshotChecksum as checksum } from '../snapshotChecksum.js';
import { activeMusicVideoSubjects, musicVideoReferenceSubjectIds } from './musicVideoCastSelection.js';
import { musicVideoClipConditioningReferences, musicVideoConditioningReferences } from './musicVideoConditioning.js';
import { characterInputsFromReferences } from './musicVideoCastLook.js';

/** The stable code agents and the board group this warning by. */
export const CHARACTER_REFERENCE_CHANGED = 'character-reference-changed';

const CAST_SETS_PREFIX = 'mvr-cs-';
const isFrameKind = (kind) => kind === 'image' || kind === 'endImage';
const key = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

/** A clip submit's recorded cast inputs: the shot's known character references among the files it sent. */
export function clipCastInputs(project, scene, sentFiles) {
  const sent = new Set(sentFiles || []);
  if (!sent.size) return null;
  const references = musicVideoClipConditioningReferences(project, scene).filter((ref) => sent.has(ref.imageId));
  return { ingredientId: null, guides: [], sheets: [], characters: characterInputsFromReferences(references) };
}

/**
 * What a take recorded, or null when it recorded nothing usable. `full` is a `characters` list (every
 * character reference sent); otherwise only Cast & Sets sheets were recorded.
 */
function recordedInputs(take) {
  const inputs = take?.castInputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return null;
  const valid = (list) => (Array.isArray(list) ? list : []).filter((entry) => typeof entry?.id === 'string' && typeof entry?.imageId === 'string');
  if (Array.isArray(inputs.characters)) return { full: true, entries: valid(inputs.characters) };
  if (Array.isArray(inputs.sheets)) return { full: false, entries: valid(inputs.sheets) };
  return null;
}

// The shot sheet's cast, when it lists one: by id, catalog id or name, as musicVideoShotSheetCastIds matches them.
function listedCharacterIds(project, scene) {
  if (!Array.isArray(scene?.shotSheet?.characters)) return null;
  const listed = new Set(scene.shotSheet.characters.map(key).filter(Boolean));
  return new Set(activeMusicVideoSubjects(project?.concept)
    .filter((subject) => subject?.kind === 'character' && [subject.id, subject.ingredientId, subject.name].some((value) => listed.has(key(value))))
    .map((subject) => subject.id));
}

/**
 * The shot's characters with the references a render would send them now:
 * `[{ subject, refs }]`. A shot sheet that lists its cast decides who is in the shot; without one,
 * whoever the render sends a reference for. Catalog guides and linked picks need media the project
 * record does not hold, so they are not among `refs`.
 */
function currentCharacters(project, scene, kind) {
  const sent = (kind === 'video' ? musicVideoClipConditioningReferences(project, scene) : musicVideoConditioningReferences(project, scene))
    .filter((ref) => ref?.role === 'character' && ref.imageId);
  const listed = listedCharacterIds(project, scene);
  return activeMusicVideoSubjects(project?.concept)
    .filter((subject) => subject?.kind === 'character' && (!listed || listed.has(subject.id)))
    .map((subject) => ({ subject, refs: sent.filter((ref) => musicVideoReferenceSubjectIds(project, ref).includes(subject.id)) }))
    .filter((entry) => entry.refs.length);
}

// When a Cast & Sets sheet's current image was set: the image slot's last write, made when it finished
// (or earlier, when an image was chosen by hand), so a take older than it cannot have used that image.
function referenceChangedAt(project, ref) {
  if (!String(ref.id).startsWith(CAST_SETS_PREFIX)) return null;
  for (const [slot, image] of Object.entries(project?.castAndSets?.images || {})) {
    if (`${CAST_SETS_PREFIX}${slot.replace(':', '-')}`.slice(0, 64) !== ref.id) continue;
    if (image?.status !== 'done' || image.imageId !== ref.imageId) return null;
    const at = Date.parse(image.updatedAt);
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

// `currentOf()` reads the shot's current references only once a cheap check says they matter.
function flaggedCharacters(project, scene, take, currentOf) {
  const inputs = recordedInputs(take);
  if (inputs) {
    const characters = currentOf();
    const sentImages = new Set(inputs.entries.map((entry) => entry.imageId));
    // A guide-driven shot sends catalog guides this record cannot list, so only a replaced image is provable.
    const absenceProvable = !scene?.characterVariant;
    return characters.flatMap(({ subject, refs }) => {
      const compared = inputs.full ? refs : refs.filter((ref) => String(ref.id).startsWith(CAST_SETS_PREFIX));
      if (!compared.length) return [];
      const replaced = compared.some((ref) => inputs.entries.some((entry) => entry.id === ref.id && entry.imageId !== ref.imageId));
      const absent = absenceProvable && !compared.some((ref) => sentImages.has(ref.imageId));
      return replaced || absent ? [{ subject, refs: compared }] : [];
    });
  }
  // A frame with no recorded inputs falls back to dates, only where a reference's change time is known.
  // An imported frame was not rendered from this project's references.
  if (!isFrameKind(take?.kind) || take.source === 'imported') return [];
  const madeAt = Date.parse(take.createdAt);
  if (!Number.isFinite(madeAt) || !Object.values(project?.castAndSets?.images || {}).some((image) => Date.parse(image?.updatedAt) > madeAt)) return [];
  return currentOf().flatMap(({ subject, refs }) => (refs.some((ref) => (referenceChangedAt(project, ref) ?? -Infinity) > madeAt) ? [{ subject, refs }] : []));
}

const subjectName = (subject) => (typeof subject.name === 'string' && subject.name.trim()) || 'a character';

// The frame takes a clip was built on: its recorded plate (and end frame), else the shot's frame for a legacy clip.
function clipFrameTakes(scene, take) {
  const recorded = (role) => take?.dependencies?.references?.find((ref) => ref.role === role)?.assetId || null;
  const start = take?.sourceImageId || recorded('plate') || (!take?.dependencies ? scene?.referenceImageId : null);
  const end = recorded('endPlate');
  return [['image', start], ['endImage', end]]
    .map(([kind, assetId]) => (assetId ? (scene?.takes || []).find((entry) => entry?.kind === kind && entry.assetId === assetId) : null))
    .filter(Boolean);
}

/**
 * `{ code, reasons, characters, revision, inherited? }` for a frame or clip take rendered without a
 * current character reference, or null (not flagged, unknown, or accepted with "Still matches").
 * `cache` (optional) shares one shot's current references across its takes within one read.
 */
export function musicVideoTakeCharacterReferenceState(project, scene, take, cache = null) {
  if (!take || !(isFrameKind(take.kind) || take.kind === 'video')) return null;
  const lane = take.kind === 'video' ? 'video' : 'image';
  const memo = cache?.get(scene) || {};
  if (cache && !cache.has(scene)) cache.set(scene, memo);
  const own = flaggedCharacters(project, scene, take, () => (memo[lane] ??= currentCharacters(project, scene, lane)));
  const frames = take.kind === 'video'
    ? clipFrameTakes(scene, take).map((frame) => musicVideoTakeCharacterReferenceState(project, scene, frame, cache)).filter(Boolean)
    : [];
  if (!own.length && !frames.length) return null;
  const characters = [...new Map([...own.map(({ subject }) => [subject.id, { subjectId: subject.id, name: subjectName(subject) }]),
    ...frames.flatMap((frame) => frame.characters.map((entry) => [entry.subjectId, entry]))]).values()];
  const revision = checksum({
    own: own.map(({ subject, refs }) => ({ subjectId: subject.id, refs: refs.map((ref) => [ref.id, ref.imageId]).sort() })),
    frames: frames.map((frame) => frame.revision).sort(),
  });
  if (take.characterReferenceAcceptance?.revision === revision) return null;
  const reasons = [
    ...own.map(({ subject }) => `Character reference changed after this render: ${subjectName(subject)}`),
    ...(frames.length ? [`Started from a frame rendered with an older character reference: ${[...new Set(frames.flatMap((frame) => frame.characters.map((entry) => entry.name)))].join(', ')}`] : []),
  ];
  return { code: CHARACTER_REFERENCE_CHANGED, reasons, characters, revision, ...(!own.length ? { inherited: true } : {}) };
}

const SLOT_KINDS = [['image', 'referenceImageId'], ['endImage', 'endImageId'], ['video', 'videoHistoryId']];

/** The shot's selected frame, end frame and clip takes that carry this warning, as `[{ kind, take }]`. */
export function musicVideoSceneCharacterReferenceTakes(scene) {
  return SLOT_KINDS.flatMap(([kind, field]) => {
    const take = scene?.[field] ? (scene.takes || []).find((entry) => entry?.kind === kind && entry.assetId === scene[field]) : null;
    return take?.characterReferenceState ? [{ kind, take }] : [];
  });
}

/**
 * Present the warning on each shot's selected frame, end frame and clip takes, replacing whatever an
 * earlier presentation left on the record. Other takes never carry it.
 */
export function presentCharacterReferenceStates(project) {
  if (!Array.isArray(project?.scenes)) return project;
  const cache = new Map();
  return { ...project, scenes: project.scenes.map((scene) => {
    if (!Array.isArray(scene?.takes) || !scene.takes.length) return scene;
    const selected = new Set(SLOT_KINDS.map(([kind, field]) => (scene[field] ? `${kind}:${scene[field]}` : null)).filter(Boolean));
    return { ...scene, takes: scene.takes.map((take) => {
      const { characterReferenceState: _previous, ...rest } = take || {};
      if (!take || !selected.has(`${take.kind}:${take.assetId}`)) return take && Object.hasOwn(take, 'characterReferenceState') ? rest : take;
      const state = musicVideoTakeCharacterReferenceState(project, scene, rest, cache);
      return state ? { ...rest, characterReferenceState: state } : rest;
    }) };
  }) };
}
