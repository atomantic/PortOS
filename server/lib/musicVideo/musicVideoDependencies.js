/**
 *  Versioned Music Video provenance. Only pointers/checksums live on project rows.
 *
 * Versioned take/evidence provenance, dependency comparisons and bounded selective-repair previews.
 */
import { canonicalSnapshotChecksum } from '../snapshotChecksum.js';
import { isFilmLookNeutral } from '../filmLook.js';
import { musicVideoOverscan } from './musicVideoFilmLook.js';
import { activeShotColorMatch } from '../shotColorMatch.js';
import { isEndFrameImageEffect } from './musicVideoImageEffects.js';
import { isCatalogMediaReferenceId, isLegacyCatalogReference, musicVideoClipConditioningReferences, musicVideoClipReferenceChoices, musicVideoPanelArtReferences, musicVideoSceneCastIds, musicVideoShotSheetCastIds } from './musicVideoConditioning.js';
import { presentCharacterReferenceStates } from './musicVideoCharacterReferenceAge.js';

export const MUSIC_VIDEO_DEPENDENCY_VERSION = 1;
// `endPlate` (#11173): the style-break end frame a fal clip was generated to end on.
const slots = { plate: 'referenceImageId', clip: 'videoHistoryId', endPlate: 'endImageId' };
const takeKinds = { plate: 'image', clip: 'video', endPlate: 'endImage' };
const checksum = (value) => canonicalSnapshotChecksum(value);
const selectedTake = (scene, role, assetId = scene?.[slots[role]]) => (scene?.takes || [])
  .find((take) => take.kind === takeKinds[role] && take.assetId === assetId);
const assetRef = (scene, role, assetId = scene?.[slots[role]]) => ({
  role, sceneId: scene.sceneId, assetId: assetId || null,
  revision: checksum({ assetId: assetId || null, inputs: selectedTake(scene, role, assetId)?.inputAssets || [] }),
});
// #16418 entered main at this instant. A final export on a record last touched
// before it could not have captured the four new keys. Do not infer age from
// the absence of a version marker: newer v1 records used the same version.
const LAYER_TREATMENT_CUTOFF = Date.parse('2026-11-16T15:53:22Z');
const predatesLayerTreatment = (project) => Date.parse(project.updatedAt) < LAYER_TREATMENT_CUTOFF;
const layerTreatmentEntries = (scene) => ['lyricSize', 'textZone', 'lyricText']
  .filter((key) => scene[key]).map((key) => [key, scene[key]])
  .concat(scene.shotSheet?.cameraId ? [['shotSheetCameraId', scene.shotSheet.cameraId]] : []);
const layerRef = (scene, { legacy = false } = {}) => ({ role: 'layer', sceneId: scene.sceneId, assetId: scene.sceneId,
  revision: checksum(Object.fromEntries(['startSec', 'endSec', 'visualLayer', 'stillMove', 'cardText', 'cardColor', 'shotMode', 'performanceSpeaker', 'loop']
    .map((key) => [key, scene[key] ?? null]).concat([['actionContract', scene.direction?.actionContract || null]])
    // #10589: only a planned camera joins the revision, so pre-camera evidence stays current.
    .concat(scene.camera ? [['camera', scene.camera]] : [])
    // A chosen frame fit changes the render; a shot left to fill keeps its evidence.
    .concat(scene.frameFit && scene.frameFit !== 'fill' ? [['frameFit', scene.frameFit]] : [])
    // A hand-set clip speed or offset changes the render; a shot left as rendered keeps its evidence.
    .concat(['speedFps', 'offsetFrames', 'reverse', 'holdLastFrame'].filter((key) => scene[key]).map((key) => [key, scene[key]]))
    // A glitch over its cuts changes the render; a shot without one keeps its evidence.
    .concat(['transitionIn', 'transitionOut'].filter((key) => scene[key]).map((key) => [key, scene[key]]))
    // So does a wipe on them.
    .concat(['wipeIn', 'wipeOut'].filter((key) => scene[key]).map((key) => [key, scene[key]]))
    .concat(scene.glitches?.length ? [['glitches', scene.glitches]] : [])
    // A shot's own film look changes the render; a shot following the video's keeps its evidence.
    .concat(scene.filmLook ? [['filmLook', scene.filmLook]] : [])
    .concat(scene.templateEffects ? [['templateEffects', scene.templateEffects]] : [])
    .concat(scene.cutEffect && scene.cutEffect.enabled !== false ? [['cutEffect', scene.cutEffect]] : [])
    // An image effect over a still changes the render; a still without one keeps its evidence.
    .concat(scene.imageEffect ? [['imageEffect', scene.imageEffect], ['imageEffectSec', scene.imageEffectSec ?? null]] : [])
    .concat(scene.photoSequence && scene.photoSequence.enabled !== false ? [['photoSequence', scene.photoSequence]] : [])
    // An effect from the start frame to the end frame renders the end frame too.
    // Use end frame off plays the start frame only, so it changes the render.
    .concat(scene.imageEffect && isEndFrameImageEffect(scene.imageEffect) ? [['endImageId', scene.endImageId ?? null]] : [])
    .concat(scene.endFrameOff === true ? [['endFrameOff', true]] : [])
    // Only a music-driven performance joins it, so lip-sync evidence stays current.
    .concat(scene.performanceStyle === 'music' ? [['performanceStyle', 'music']] : [])
    // Per-shot lyric treatment and camera assignment (documentRender, applyCameraCutDefaults) change the render; unset keeps evidence.
    .concat(legacy ? [] : layerTreatmentEntries(scene))
    // A shot moved before the song (its length and sound) changes the render; a song shot keeps its evidence.
    .concat(scene.preMusic ? [['preMusic', scene.preMusic]] : [])
    // A song shot's clip sound over the music changes the mix; a silent shot keeps its evidence.
    .concat(scene.clipSound ? [['clipSound', scene.clipSound]] : []))) });
const snapshot = (references) => ({ version: MUSIC_VIDEO_DEPENDENCY_VERSION, references });

// Keep the project's selected clip guides with the take, so an in-flight clip
// cannot fill an empty slot after the director changes those selections.
function clipReferenceDependency(project, scene, catalogUnavailable = false) {
  const ids = Array.isArray(scene?.clipReferenceIds) ? scene.clipReferenceIds : null;
  const characterVariant = scene.characterVariant || null;
  const choices = musicVideoClipReferenceChoices(project, scene);
  const selected = ids ? ids.map((id) => choices.find((ref) => ref.id === id) || { id })
    : musicVideoClipConditioningReferences(project, scene, null, { limit: 8 });
  // Catalog cast guides are loaded outside the project record. A synchronous
  // project snapshot cannot tell if those external guide files later changed.
  // Such a take must be explicitly reviewed before filling an empty slot.
  const untrackedCastGuides = ids ? ids.some((id) => !choices.some((ref) => ref.id === id)) : !!scene.characterVariant;
  // A saved local image can be a legacy sheet that only becomes selectable
  // when the catalog offers the same file. Exclude that case from local proof.
  const { catalogCheckin: _resolved, ...storedStage } = project?.castAndSets || {};
  const stored = { castAndSets: storedStage, visualSpec: project?.visualSpec };
  const isLocal = (ref) => ref.imageId && !String(ref.id).startsWith('mvr-catalog-')
    && !isCatalogMediaReferenceId(ref.id) && !isLegacyCatalogReference(stored, ref);
  const dependency = { role: 'clipReferences', sceneId: scene.sceneId, assetId: scene.sceneId, untrackedCastGuides,
    revision: checksum({ ids, selected, characterVariant }),
    // Keep the original hash and role readable by older installs.
    localSelectionRevision: checksum({ ids, characterVariant, selected: ids ? selected.filter(isLocal) : [] }),
  };
  if (!catalogUnavailable) return dependency;
  // Auto can inherit an explicit frame list. With no such list, the catalog
  // can supply or displace references in the automatic set.
  const picks = ids ?? scene.frameReferenceIds;
  const candidates = ids ? selected : [...choices, ...musicVideoPanelArtReferences(scene)];
  if (Array.isArray(picks) && picks.every((id) => candidates.some((ref) => ref.id === id && isLocal(ref)))) return dependency;
  return { ...dependency, catalogUnavailable: true,
    legacyEmptyRevision: checksum({ ids: [], selected: [], characterVariant }) };
}

export function captureClipReferenceDependency(project, scene) {
  return clipReferenceDependency(project, scene);
}

// Frame provenance stays BESIDE `dependencies`. New roles inside
// `dependencies.references` are unknown to render evidence and mark every
// render stale (`captureMusicVideoEvidence` spreads the selected take's
// references). Same snapshot shape, different field, like `castInputs`.
const FRAME_ROLES = Object.freeze({
  framePrompt: 'Frame prompt changed',
  frameCamera: 'Camera changed',
  frameLocation: 'Location changed',
  frameCast: 'Cast changed',
  frameReferences: 'Reference image replaced',
});
const FRAME_UNKNOWN = 'Frame evidence was not recorded; review again';
const textOf = (value) => (typeof value === 'string' ? value.trim() : '');
const frameSlot = (slot) => (slot === 'end' ? 'end' : 'start');
const framePromptText = (scene, slot) => textOf(frameSlot(slot) === 'end' ? scene?.endFramePrompt : scene?.framePrompt);
const frameCameraValue = (scene) => ({
  cameraId: scene?.shotSheet?.cameraId || null,
  move: scene?.camera || null,
});
const frameLocationValue = (scene) => textOf(scene?.shotSheet?.location) || null;
const frameCastNames = (scene) => (Array.isArray(scene?.shotSheet?.characters) ? scene.shotSheet.characters : []).map(textOf).filter(Boolean).sort();
// Stored data only, so capture and check agree whether or not the record carries its catalog check-in (#16274).
const frameCastValue = (project, scene) => ({
  names: frameCastNames(scene),
  ids: musicVideoShotSheetCastIds(project, scene).slice().sort(),
});

/**
 * Compatibility for `frameCast` stamps made before #16274, which hashed musicVideoSceneCastIds:
 * narrowed by the catalog check-in when the capturing record carried one, else every linked cast id.
 * Such a stamp still matches when it equals either form computed from the current data. The names
 * stay in both, so a shot-sheet cast change is still reported. Any new capture (confirm, render)
 * stamps the canonical frameCastValue; drop this once stamps from before it no longer matter.
 */
function isLegacyFrameCastRevision(project, scene, revision) {
  const names = frameCastNames(scene);
  const legacy = (record) => checksum({ names, ids: musicVideoSceneCastIds(record, scene).slice().sort() });
  if (legacy(project) === revision) return true;
  const stage = project?.castAndSets;
  if (!stage?.catalogCheckin) return false;
  const { catalogCheckin: _presented, ...stored } = stage;
  return legacy({ ...project, castAndSets: stored }) === revision;
}
/**
 * Write-time re-stamp (#16375): a legacy `frameCast` stamp that currently reads as accepted is
 * rewritten to the canonical value, so a later unrelated subject change (a place or prop added to
 * the concept) cannot invalidate it. The legacy unnarrowed form hashed every linked subject id of
 * any kind (musicVideoLinkedCastIds covers characters, sets and props), so it cannot be recognised
 * from characters alone; every form ever written stays recognised. A stamp that already matches the
 * canonical value, or no longer reads current, is left alone. Returns the same project when nothing
 * changes so the stores' no-op detection by identity holds.
 */
export function restampLegacyFrameCasts(project) {
  if (!Array.isArray(project?.scenes)) return project;
  let changed = false;
  const scenes = project.scenes.map((scene) => {
    if (!Array.isArray(scene?.takes)) return scene;
    let sceneChanged = false;
    const takes = scene.takes.map((take) => {
      const references = take?.frameDependencies?.references;
      if (!Array.isArray(references)) return take;
      const canonical = checksum(frameCastValue(project, scene));
      let takeChanged = false;
      const next = references.map((ref) => {
        if (ref?.role !== 'frameCast' || ref.revision === canonical || !isLegacyFrameCastRevision(project, scene, ref.revision)) return ref;
        takeChanged = true;
        return { ...ref, revision: canonical };
      });
      if (!takeChanged) return take;
      sceneChanged = true;
      return { ...take, frameDependencies: { ...take.frameDependencies, references: next } };
    });
    if (!sceneChanged) return scene;
    changed = true;
    return { ...scene, takes };
  });
  return changed ? { ...project, scenes } : project;
}
const frameReferenceValue = (scene) => (Array.isArray(scene?.frameReferenceIds) ? scene.frameReferenceIds.slice().sort() : null);
const frameRef = (scene, slot, role, value) => ({
  role, sceneId: scene.sceneId, assetId: frameSlot(slot), revision: checksum(value),
});

/** What an image take was rendered for: prompt, camera, place, cast, and explicit references. */
export function captureImageFrameDependencies(project, scene, { slot = 'start' } = {}) {
  const references = [
    frameRef(scene, slot, 'framePrompt', framePromptText(scene, slot)),
    frameRef(scene, slot, 'frameCamera', frameCameraValue(scene)),
    frameRef(scene, slot, 'frameLocation', frameLocationValue(scene)),
    frameRef(scene, slot, 'frameCast', frameCastValue(project, scene)),
  ];
  references.push(frameRef(scene, slot, 'frameReferences', frameReferenceValue(scene)));
  return snapshot(references);
}

function readFrameReference(project, scene, ref) {
  if (!scene || !FRAME_ROLES[ref.role]) return null;
  const value = ref.role === 'framePrompt' ? framePromptText(scene, ref.assetId)
    : ref.role === 'frameCamera' ? frameCameraValue(scene)
      : ref.role === 'frameLocation' ? frameLocationValue(scene)
        : ref.role === 'frameCast' ? frameCastValue(project, scene)
          : frameReferenceValue(scene);
  return { assetId: frameSlot(ref.assetId), revision: checksum(value) };
}

function frameDependencyChanges(project, scene, dependencies) {
  if (!dependencies || dependencies.version !== MUSIC_VIDEO_DEPENDENCY_VERSION || !Array.isArray(dependencies.references)) {
    return [{ role: 'unknown', reason: FRAME_UNKNOWN }];
  }
  const changes = [];
  // Earlier v1 captures omitted this role only when no explicit references
  // were chosen. Preserve that absence when checking stored takes after upgrade.
  if (!dependencies.references.some((ref) => ref.role === 'frameReferences') && frameReferenceValue(scene) !== null) {
    changes.push({ role: 'frameReferences', reason: FRAME_ROLES.frameReferences });
  }
  for (const ref of dependencies.references) {
    const current = readFrameReference(project, scene, ref);
    const matches = current && current.assetId === ref.assetId && (current.revision === ref.revision
      || (ref.role === 'frameCast' && isLegacyFrameCastRevision(project, scene, ref.revision)));
    if (!matches) {
      changes.push({ ...ref, role: FRAME_ROLES[ref.role] ? ref.role : 'unknown', reason: FRAME_ROLES[ref.role] || FRAME_UNKNOWN });
    }
  }
  return changes;
}

function dependencyStateFromChanges(changes) {
  if (!changes.length) return { status: 'current', reasons: [] };
  const reasons = [...new Set(changes.map((change) => change.reason))];
  return { status: changes.some((change) => change.role !== 'unknown') ? 'stale' : 'unknown', reasons };
}

/**
 * Legacy stills recorded only the composed prompt. An exact match is current;
 * absence of the frame text is stale. Inclusion alone cannot distinguish a
 * composed prompt from a shortened shot, so that evidence stays unknown.
 */
function legacyFrameState(scene, take) {
  const prompt = textOf(take?.prompt);
  const framePrompt = framePromptText(scene, take?.kind === 'endImage' ? 'end' : 'start');
  if (!prompt || !framePrompt) return { status: 'unknown', reasons: [FRAME_UNKNOWN] };
  if (!prompt.includes(framePrompt)) return { status: 'stale', reasons: ['Frame prompt changed'] };
  return prompt === framePrompt ? { status: 'current', reasons: [] } : { status: 'unknown', reasons: [FRAME_UNKNOWN] };
}

/** Selected-frame validity for one image or end-frame take. Null for any other kind. */
function imageFrameDependencyState(project, scene, take) {
  if (take?.kind !== 'image' && take?.kind !== 'endImage') return null;
  if (take.frameDependencies) return dependencyStateFromChanges(frameDependencyChanges(project, scene, take.frameDependencies));
  return legacyFrameState(scene, take);
}

const takeByAsset = (scene, kind, assetId) => (assetId ? (scene?.takes || []).find((entry) => entry?.kind === kind && entry.assetId === assetId) : null);

function recordedPlateAsset(scene, take, role) {
  const recorded = take?.dependencies?.references?.find((ref) => ref.role === role)?.assetId || null;
  if (role === 'plate') {
    if (take?.sourceImageId) return take.sourceImageId;
    if (recorded) return recorded;
    if (!take?.dependencies && !take?.sourceImageId) return scene?.referenceImageId || null;
    return null;
  }
  if (recorded) return recorded;
  if (!take?.dependencies) return scene?.endImageId || null;
  return null;
}

/** Stale reasons from the still a clip was actually built on. Unknown stills do not carry over. */
function inheritedFrameReasons(project, scene, take) {
  if (take?.kind !== 'video') return [];
  const reasons = [];
  for (const [role, kind] of [['plate', 'image'], ['endPlate', 'endImage']]) {
    const assetId = recordedPlateAsset(scene, take, role);
    const frame = imageFrameDependencyState(project, scene, takeByAsset(scene, kind, assetId));
    if (frame?.status === 'stale') reasons.push(...frame.reasons);
  }
  return [...new Set(reasons)];
}

/** Capture the actual submitted plate (and end frame), including optional crop/mask provenance. */
export function captureTakeDependencies(scene, sourceImageId = scene?.referenceImageId, endImageId = null) {
  return snapshot([
    ...(sourceImageId ? [assetRef(scene, 'plate', sourceImageId)] : []),
    ...(endImageId ? [assetRef(scene, 'endPlate', endImageId)] : []),
  ]);
}

const intersects = (scene, startSec, endSec) => !(typeof scene.startSec === 'number' && typeof scene.endSec === 'number')
  || (scene.startSec < endSec && scene.endSec > startSec);
// A chosen production medium changes the render; a project without one keeps its evidence.
const compositionRevision = (project, composition) => checksum({ mediaMode: project.mediaMode || null, composition,
  ...(project.templateEffects ? { templateEffects: project.templateEffects } : {}),
  ...(project.productionMedium ? { productionMedium: project.productionMedium } : {}) });
// Only the text cues inside the window join the revision. `legacyRevision` is what evidence captured before
// #16397 stored (the whole cue list under a phantom empty `cues` key); it is compared, never stored.
const compositionRef = (project, startSec, endSec) => {
  const composition = project.composition || null;
  const value = composition && Array.isArray(composition.textCues)
    ? { ...composition, textCues: composition.textCues.filter((cue) => intersects(cue, startSec, endSec)) } : composition;
  return { role: 'composition', assetId: 'composition', revision: compositionRevision(project, value),
    legacyRevision: compositionRevision(project, composition ? { ...composition, cues: [] } : null), startSec, endSec };
};

// Video-level inputs the final render reads (filmLookFinish, shotSegments title card, ending parts, cameras,
// overscan, sound bed, lyric overlay). Each joins only when set so a project without them keeps its evidence.
// Left out on purpose: `videoSettings` (read only when generating takes, not by the render) and a shot's
// `colorMatch` field (the render reads the selected take's correction, tracked by `colorMatchRef`).
const finishInputs = (project) => Object.fromEntries([
  ['filmLook', project.filmLook && !isFilmLookNeutral(project.filmLook) ? project.filmLook : null],
  ['titleCard', project.titleCard || null],
  ['creditsOutro', project.creditsOutro || null],
  ['statsOutro', project.statsOutro || null],
  ['cameras', project.cameras?.length ? project.cameras : null],
  ['overscan', musicVideoOverscan(project) || null],
  ['lyricOverlayEnabled', project.lyricOverlayEnabled === false ? false : null],
  ['soundBed', project.soundBed || null],
].filter(([, value]) => value !== null));
// The correction the render applies to a shot (selected take's match, camera doNotMatch, flash stills) is its own
// reference, not part of `layerRef`: it is recorded on every shot, so a later match or a disable flips the render,
// and evidence captured before this reference existed simply has none and is not compared, staying current.
const colorMatchRef = (project, scene) => ({ role: 'colorMatch', sceneId: scene.sceneId, assetId: scene.sceneId,
  revision: checksum(activeShotColorMatch(project, scene)) });
const finishRef = (project) => ({ role: 'finish', assetId: 'project', revision: checksum(finishInputs(project)) });

const songRef = (project) => ({ role: 'song', assetId: 'master', revision: checksum({
  trackId: project.trackId ?? null, uploadedAudioFilename: project.uploadedAudioFilename ?? null,
  audioAnalysis: project.audioAnalysis ?? null, lyricCues: project.lyricCues || [],
  lyricMarkers: project.lyricMarkers || [], phrases: project.phrases || [],
}) });

/** Evidence tracks its rendered window, selected layers and transitive take inputs. */
export function captureMusicVideoEvidence(project, { sceneIds = null, startSec = 0, endSec = 36000, composition = true, clipFrames = true } = {}) {
  const references = [songRef(project)];
  for (const scene of project.scenes || []) {
    if (sceneIds ? !sceneIds.includes(scene.sceneId) : !intersects(scene, startSec, endSec)) continue;
    references.push(layerRef(scene), colorMatchRef(project, scene));
    const role = scene.visualLayer === 'still' ? 'plate' : ['card', 'code'].includes(scene.visualLayer) ? null : 'clip';
    if (!role) continue;
    references.push(assetRef(scene, role));
    // `clipFrames: false` (the final render) does not hold a selected clip to the frames it was made from:
    // the user may override or pick any clip, so a render never goes out of date because the shot's plate moved on.
    if (role === 'clip' && !clipFrames) continue;
    const take = selectedTake(scene, role);
    if (take?.dependencies) references.push(...take.dependencies.references);
    else if (role === 'clip' && take?.sourceImageId) references.push(...captureTakeDependencies(scene, take.sourceImageId).references);
  }
  if (composition) {
    const sceneSet = (project.scenes || []).filter((scene) => intersects(scene, startSec, endSec)).map((scene) => scene.sceneId).sort();
    references.push({ role: 'window', assetId: 'scene-set', startSec, endSec, sceneIds: sceneSet, revision: checksum(sceneSet) });
    const { legacyRevision, ...composed } = compositionRef(project, startSec, endSec);
    references.push(composed, finishRef(project));
  }
  return snapshot(references);
}

// A presentation/impact read checks many historical snapshots against the same
// project. Share current references only within that synchronous read: project
// objects can be mutated in place between reads, including before a save.
function createDependencyReader(project) {
  const catalogUnavailable = project.castAndSets?.catalogCheckin?.problems?.some((problem) => problem.code === 'CATALOG_UNAVAILABLE');
  let song;
  let finish;
  let scenesById;
  const sceneReferences = new Map();
  const windows = new Map();
  return (ref) => {
    if (ref.role === 'song') return song ??= songRef(project);
    if (ref.role === 'finish') return finish ??= finishRef(project);
    if (ref.role === 'window' || ref.role === 'composition') {
      let byEnd = windows.get(ref.startSec);
      if (!byEnd) windows.set(ref.startSec, byEnd = new Map());
      let references = byEnd.get(ref.endSec);
      if (!references) byEnd.set(ref.endSec, references = {});
      if (!references[ref.role]) references[ref.role] = ref.role === 'composition'
        ? compositionRef(project, ref.startSec, ref.endSec)
        : { assetId: 'scene-set', revision: checksum((project.scenes || []).filter((scene) => intersects(scene, ref.startSec, ref.endSec)).map((scene) => scene.sceneId).sort()) };
      return references[ref.role];
    }
    if (!scenesById) {
      scenesById = new Map();
      for (const scene of project.scenes || []) {
        if (!scenesById.has(scene.sceneId)) scenesById.set(scene.sceneId, scene);
      }
    }
    const scene = scenesById.get(ref.sceneId);
    if (!scene) return null;
    let references = sceneReferences.get(scene);
    if (!references) sceneReferences.set(scene, references = new Map());
    if (!references.has(ref.role)) references.set(ref.role, slots[ref.role] ? assetRef(scene, ref.role)
      : ref.role === 'layer' ? layerRef(scene)
        : ref.role === 'colorMatch' ? colorMatchRef(project, scene)
        : ref.role === 'clipReferences' ? clipReferenceDependency(project, scene, catalogUnavailable) : null);
    return references.get(ref.role);
  };
}

function dependencyChanges(dependencies, readCurrent, matchFinalLayer = null) {
  if (!dependencies || dependencies.version !== MUSIC_VIDEO_DEPENDENCY_VERSION || !Array.isArray(dependencies.references)) {
    return [{ role: 'unknown', reason: 'Dependency evidence was not recorded; review again' }];
  }
  const changes = dependencies.references.some((ref) => ref.role === 'window') && !dependencies.references.some((ref) => ref.role === 'song')
    ? [{ role: 'song', reason: 'Song dependency evidence was not recorded; review again' }] : [];
  for (const ref of dependencies.references) {
    const current = readCurrent(ref);
    const sameAsset = current?.assetId === ref.assetId;
    if (sameAsset && current?.catalogUnavailable) {
      // A legacy hash can prove an empty selection with the same stored variant,
      // but cannot isolate local changes in an old mixed selection.
      const localChanged = ref.localSelectionRevision
        ? ref.localSelectionRevision !== current.localSelectionRevision : ref.revision === current.legacyEmptyRevision;
      if (!localChanged) {
        changes.push({ role: 'unknown', catalogUnavailable: true, reason: 'Catalog references could not be read; review again' });
        continue;
      }
    }
    const sameRevision = matchFinalLayer && ref.role === 'layer' && ref.legacyLayerTreatmentBaseline
      ? matchFinalLayer(ref)
      : current?.revision === ref.revision || current?.legacyRevision === ref.revision || matchFinalLayer?.(ref);
    if (!current || !sameAsset || current.catalogUnavailable || !sameRevision) {
      changes.push({ ...ref, reason: `${ref.role === 'song' ? 'Master audio, lyrics or alignment' : ref.role === 'plate' ? 'Selected plate or its crop/mask inputs' : ref.role === 'endPlate' ? 'Selected end frame' : ref.role === 'clip' ? 'Selected clip' : ref.role === 'clipReferences' ? 'Selected clip references' : ref.role === 'layer' ? 'Shot timing or composition layer' : ref.role === 'colorMatch' ? 'Shot color match' : ref.role === 'finish' ? 'Video finish settings (film look, title card, credits, cameras, overscan, sound bed or lyric overlay)' : 'Composition'} changed` });
    }
  }
  return changes;
}

// Scope the fallback to the stored final, never a proof, pilot, or review.
function finalLayerMatcher(project) {
  let scenes;
  const legacy = predatesLayerTreatment(project);
  return (ref) => {
    if (ref.role !== 'layer' || (!legacy && !ref.legacyLayerTreatmentBaseline)) return false;
    scenes ??= new Map((project.scenes || []).map((scene) => [scene.sceneId, scene]));
    const scene = scenes.get(ref.sceneId);
    if (!scene || layerRef(scene, { legacy: true }).revision !== ref.revision) return false;
    return !ref.legacyLayerTreatmentBaseline
      || checksum(layerTreatmentEntries(scene)) === ref.legacyLayerTreatmentBaseline;
  };
}

/** Absent legacy evidence is unknown, never an affirmative current verdict. */
export function musicVideoDependencyChanges(project, dependencies) {
  return dependencyChanges(dependencies, createDependencyReader(project),
    dependencies && project.renderHistoryId && dependencies === project.renderDependencies ? finalLayerMatcher(project) : null);
}

function takeChanges(project, scene, take, readCurrent) {
  const changes = [];
  if (take?.dependencies) changes.push(...dependencyChanges(take.dependencies, readCurrent));
  // Pre-provenance generated clips still recorded their actual source basename.
  else if (take?.sourceImageId && take.kind !== 'image' && take.kind !== 'endImage' && take.sourceImageId !== scene.referenceImageId) {
    changes.push({ role: 'plate', sceneId: scene.sceneId, reason: 'Selected plate changed' });
  }
  // Unknown frame evidence must not block selecting an import. An explicit
  // mismatch must, so a late job rendered for an old shot cannot fill the slot.
  const frame = imageFrameDependencyState(project, scene, take);
  if (frame?.status === 'stale') changes.push(...frame.reasons.map((reason) => ({ role: 'frame', sceneId: scene.sceneId, reason })));
  else if (take?.kind === 'video') changes.push(...inheritedFrameReasons(project, scene, take).map((reason) => ({ role: 'frame', sceneId: scene.sceneId, reason })));
  return changes;
}

export function musicVideoTakeChanges(project, scene, take) {
  return takeChanges(project, scene, take, createDependencyReader(project));
}

// The old render checksum cannot attest to the newly tracked fields. Preserve
// that checksum verbatim; record separately the verified pre-write project
// baseline so the very first edit to one of those fields is still visible.
function retainLegacyFinalLayerBaseline(before, after) {
  const old = before.renderDependencies;
  const next = after.renderDependencies;
  if (!before.renderHistoryId || before.renderHistoryId !== after.renderHistoryId
    || next !== old || old?.version !== MUSIC_VIDEO_DEPENDENCY_VERSION
    || !Array.isArray(old.references) || !predatesLayerTreatment(before)) return after;
  const scenes = new Map((before.scenes || []).map((scene) => [scene.sceneId, scene]));
  let changed = false;
  const references = old.references.map((ref) => {
    const scene = ref.role === 'layer' && scenes.get(ref.sceneId);
    if (!scene || ref.assetId !== ref.sceneId || ref.legacyLayerTreatmentBaseline
      || layerRef(scene).revision === ref.revision || layerRef(scene, { legacy: true }).revision !== ref.revision) return ref;
    changed = true;
    return { ...ref, legacyLayerTreatmentBaseline: checksum(layerTreatmentEntries(scene)) };
  });
  return changed ? { ...after, renderDependencies: { ...old, references } } : after;
}

/** Before a write, materialize legacy provenance from the PRE-image, never new inputs. */
export function retainMusicVideoDependencies(before, after) {
  const previousScenes = new Map((before.scenes || []).map((scene) => [scene.sceneId, scene]));
  const scenes = (after.scenes || []).map((scene) => {
    const previous = previousScenes.get(scene.sceneId);
    if (!previous) return scene;
    const takes = (scene.takes || []).map((take) => {
      if (take.dependencies || take.kind !== 'video') return take;
      const old = (previous.takes || []).find((entry) => entry.takeId === take.takeId);
      const source = old?.sourceImageId || (old ? (['legacy', 'manual'].includes(old.source) ? previous.referenceImageId : null)
        : previous.videoHistoryId === take.assetId ? previous.referenceImageId : null);
      return source ? { ...take, dependencies: captureTakeDependencies(previous, source) } : take;
    });
    return { ...scene, takes };
  });
  // Existing evidence without a trustworthy snapshot remains unknown. Do not
  // bless historical passes by taking a snapshot of today's selections.
  const next = before === after ? after : retainLegacyFinalLayerBaseline(before, after);
  return presentMusicVideoDependencies({ ...next, scenes });
}

/** Read-only downstream preview. Generation count is an upper bound, not a price quote. */
export function musicVideoDependencyImpact(project, performanceChanges = []) {
  const readCurrent = createDependencyReader(project);
  const shots = [];
  for (const scene of project.scenes || []) {
    const take = selectedTake(scene, 'clip') || (!scene.videoHistoryId
      ? (scene.takes || []).findLast((entry) => entry.kind === 'video' && entry.status === 'rejected') : null);
    // A transient outage cannot justify rejecting a selected take for regeneration.
    const changes = take ? takeChanges(project, scene, take, readCurrent).filter((change) => !change.catalogUnavailable) : [];
    const audio = performanceChanges.filter((entry) => entry.sceneId === scene.sceneId);
    const unfinished = !scene.videoHistoryId && (project.revisions || []).some((revision) => revision.type === 'dependencies'
      && revision.sections?.some((section) => section.sceneId === scene.sceneId && section.verdict === 'rejected'));
    const reasons = [...new Set([...changes.map((entry) => entry.reason), ...audio.map((entry) => entry.reason), ...(unfinished ? ['Replacement clip is still missing'] : [])])];
    if (reasons.length) shots.push({ sceneId: scene.sceneId, kind: 'video', assetId: take?.assetId || scene.videoHistoryId,
      reasons, durationSec: Math.max(0, (scene.endSec || 0) - (scene.startSec || 0)) });
  }
  const affected = new Set(shots.map((shot) => shot.sceneId));
  const evidence = [];
  const check = (kind, id, dependencies, scope = {}) => {
    const changes = dependencyChanges(dependencies, readCurrent, kind === 'render' ? finalLayerMatcher(project) : null)
      .filter((change) => !change.catalogUnavailable);
    const transitive = (dependencies?.references || []).some((ref) => affected.has(ref.sceneId));
    if (changes.length || transitive) evidence.push({ kind, id, reasons: [...new Set([
      ...changes.map((entry) => entry.reason), ...(transitive ? ['Derived clip is stale'] : []),
    ])], ...scope });
  };
  if (project.renderHistoryId) check('render', project.renderHistoryId, project.renderDependencies);
  for (const excerpt of project.excerpts || []) {
    if (excerpt.status === 'complete') check('excerpt', excerpt.id, excerpt.dependencies, { startSec: excerpt.startSec, endSec: excerpt.endSec });
  }
  for (const proof of project.treatment?.proofs || []) {
    if (proof.status === 'passed') check('proof', proof.id, proof.evidence?.dependencies);
  }
  for (const run of project.autoReviews || []) {
    for (const attempt of run.attempts || []) {
      if (attempt.review?.verdict === 'pass') check('review', run.id, attempt.review.dependencies);
    }
  }
  const estimate = { maxGenerations: shots.length, outputSeconds: shots.reduce((sum, shot) => sum + shot.durationSec, 0),
    evidenceRebuilds: evidence.length };
  return { version: MUSIC_VIDEO_DEPENDENCY_VERSION, basis: checksum({ shots, evidence,
    current: captureMusicVideoEvidence(project) }), shots, evidence, estimate };
}

/** The final render's validity without projecting every historical take and review. */
export function musicVideoRenderDependencyState(project) {
  if (!project?.renderHistoryId || !project.renderDependencies) return project?.renderDependencyState;
  return dependencyStateFromChanges(dependencyChanges(project.renderDependencies, createDependencyReader(project), finalLayerMatcher(project)));
}

/**
 * Bounded projection for readers: retain verdicts/assets, expose their validity separately.
 * A selected take's `characterReferenceState` (#16473) is advice beside `dependencyState`, never part of it,
 * so an older character reference never refuses a render, an approval or a selection.
 */
export function presentMusicVideoDependencies(project) {
  if (!project) return project;
  const readCurrent = createDependencyReader(project);
  const state = (dependencies) => dependencyStateFromChanges(dependencyChanges(dependencies, readCurrent));
  return presentCharacterReferenceStates({ ...project,
    // Legacy renders recorded no evidence; leave them unflagged rather than calling them stale.
    ...(project.renderHistoryId && project.renderDependencies ? { renderDependencyState: dependencyStateFromChanges(dependencyChanges(project.renderDependencies, readCurrent, finalLayerMatcher(project))) } : {}),
    scenes: (project.scenes || []).map((scene) => ({ ...scene, takes: (scene.takes || []).map((take) => {
      const frame = take.kind === 'image' || take.kind === 'endImage' ? imageFrameDependencyState(project, scene, take) : null;
      const inherited = inheritedFrameReasons(project, scene, take);
      const base = take.dependencies ? state(take.dependencies) : null;
      const dependencyState = frame
        || (inherited.length ? { status: 'stale', reasons: [...new Set([...(base?.reasons || []), ...inherited])] } : base);
      return { ...take, ...(dependencyState ? { dependencyState } : {}) };
    }) })),
    ...(project.excerpts ? { excerpts: project.excerpts.map((excerpt) => ({ ...excerpt, dependencyState: state(excerpt.dependencies) })) } : {}),
    ...(Array.isArray(project.treatment?.proofs) ? { treatment: { ...project.treatment, proofs: (project.treatment.proofs || []).map((proof) => ({ ...proof,
      ...(proof.evidence ? { evidence: { ...proof.evidence, dependencyState: state(proof.evidence.dependencies) } } : {}),
    })) } } : {}),
    ...(project.autoReviews ? { autoReviews: project.autoReviews.map((run) => ({ ...run, attempts: (run.attempts || []).map((attempt) => ({ ...attempt,
      ...(attempt.review ? { review: { ...attempt.review, dependencyState: state(attempt.review.dependencies) } } : {}),
    })) })) } : {}),
  });
}


/** Clones reuse immutable bytes while remapping their scene-scoped provenance. */
export function remapMusicVideoDependencies(dependencies, sceneIdMap) {
  if (!dependencies?.references) return dependencies;
  return { ...dependencies, references: dependencies.references.map((ref) => {
    const sceneId = sceneIdMap.get(ref.sceneId) || ref.sceneId;
    if (ref.role === 'window' && ref.sceneIds) {
      const sceneIds = ref.sceneIds.map((id) => sceneIdMap.get(id) || id).sort();
      return { ...ref, sceneIds, revision: checksum(sceneIds) };
    }
    return { ...ref, ...(ref.sceneId ? { sceneId } : {}), ...(['layer', 'clipReferences'].includes(ref.role) ? { assetId: sceneId } : {}) };
  }) };
}
