/** Versioned Music Video provenance. Only pointers/checksums live on project rows. */
import { canonicalSnapshotChecksum } from './snapshotChecksum.js';
import { isEndFrameImageEffect } from './musicVideoImageEffects.js';
import { musicVideoClipConditioningReferences, musicVideoClipReferenceChoices, musicVideoSceneCastIds } from './musicVideoConditioning.js';

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
const layerRef = (scene) => ({ role: 'layer', sceneId: scene.sceneId, assetId: scene.sceneId,
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
    // A shot moved before the song (its length and sound) changes the render; a song shot keeps its evidence.
    .concat(scene.preMusic ? [['preMusic', scene.preMusic]] : []))) });
const snapshot = (references) => ({ version: MUSIC_VIDEO_DEPENDENCY_VERSION, references });

// Keep the project's selected clip guides with the take, so an in-flight clip
// cannot fill an empty slot after the director changes those selections.
export function captureClipReferenceDependency(project, scene) {
  const ids = Array.isArray(scene?.clipReferenceIds) ? scene.clipReferenceIds : null;
  const choices = musicVideoClipReferenceChoices(project, scene);
  const selected = ids ? ids.map((id) => choices.find((ref) => ref.id === id) || { id })
    : musicVideoClipConditioningReferences(project, scene, null, { limit: 8 });
  // Catalog cast guides are loaded outside the project record. A synchronous
  // project snapshot cannot tell if those external guide files later changed.
  // Such a take must be explicitly reviewed before filling an empty slot.
  const untrackedCastGuides = ids ? ids.some((id) => !choices.some((ref) => ref.id === id)) : !!scene.characterVariant;
  return { role: 'clipReferences', sceneId: scene.sceneId, assetId: scene.sceneId,
    untrackedCastGuides, revision: checksum({ ids, selected, characterVariant: scene.characterVariant || null }) };
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
const frameCastValue = (project, scene) => ({
  names: (Array.isArray(scene?.shotSheet?.characters) ? scene.shotSheet.characters : []).map(textOf).filter(Boolean).sort(),
  ids: musicVideoSceneCastIds(project, scene).slice().sort(),
});
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
    if (!current || current.assetId !== ref.assetId || current.revision !== ref.revision) {
      changes.push({ ...ref, role: FRAME_ROLES[ref.role] ? ref.role : 'unknown', reason: FRAME_ROLES[ref.role] || FRAME_UNKNOWN });
    }
  }
  return changes;
}

function frameStatus(changes) {
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
  if (take.frameDependencies) return frameStatus(frameDependencyChanges(project, scene, take.frameDependencies));
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
const compositionRef = (project, startSec, endSec) => {
  const composition = project.composition || null;
  const value = composition ? { ...composition,
    cues: (composition.cues || []).filter((cue) => intersects(cue, startSec, endSec)),
  } : null;
  return { role: 'composition', assetId: 'composition', // A chosen production medium changes the render; a project without one keeps its evidence.
  revision: checksum({ mediaMode: project.mediaMode || null, composition: value, ...(project.templateEffects ? { templateEffects: project.templateEffects } : {}), ...(project.productionMedium ? { productionMedium: project.productionMedium } : {}) }), startSec, endSec };
};

const songRef = (project) => ({ role: 'song', assetId: 'master', revision: checksum({
  trackId: project.trackId ?? null, uploadedAudioFilename: project.uploadedAudioFilename ?? null,
  audioAnalysis: project.audioAnalysis ?? null, lyricCues: project.lyricCues || [],
  lyricMarkers: project.lyricMarkers || [], phrases: project.phrases || [],
}) });

/** Evidence tracks its rendered window, selected layers and transitive take inputs. */
export function captureMusicVideoEvidence(project, { sceneIds = null, startSec = 0, endSec = 36000, composition = true } = {}) {
  const references = [songRef(project)];
  for (const scene of project.scenes || []) {
    if (sceneIds ? !sceneIds.includes(scene.sceneId) : !intersects(scene, startSec, endSec)) continue;
    references.push(layerRef(scene));
    const role = scene.visualLayer === 'still' ? 'plate' : ['card', 'code'].includes(scene.visualLayer) ? null : 'clip';
    if (!role) continue;
    references.push(assetRef(scene, role));
    const take = selectedTake(scene, role);
    if (take?.dependencies) references.push(...take.dependencies.references);
    else if (role === 'clip' && take?.sourceImageId) references.push(...captureTakeDependencies(scene, take.sourceImageId).references);
  }
  if (composition) {
    const sceneSet = (project.scenes || []).filter((scene) => intersects(scene, startSec, endSec)).map((scene) => scene.sceneId).sort();
    references.push({ role: 'window', assetId: 'scene-set', startSec, endSec, sceneIds: sceneSet, revision: checksum(sceneSet) });
    references.push(compositionRef(project, startSec, endSec));
  }
  return snapshot(references);
}

// A presentation/impact read checks many historical snapshots against the same
// project. Share current references only within that synchronous read: project
// objects can be mutated in place between reads, including before a save.
function createDependencyReader(project) {
  let song;
  let scenesById;
  const sceneReferences = new Map();
  const windows = new Map();
  return (ref) => {
    if (ref.role === 'song') return song ??= songRef(project);
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
        : ref.role === 'clipReferences' ? captureClipReferenceDependency(project, scene) : null);
    return references.get(ref.role);
  };
}

function dependencyChanges(dependencies, readCurrent) {
  if (!dependencies || dependencies.version !== MUSIC_VIDEO_DEPENDENCY_VERSION || !Array.isArray(dependencies.references)) {
    return [{ role: 'unknown', reason: 'Dependency evidence was not recorded; review again' }];
  }
  const changes = dependencies.references.some((ref) => ref.role === 'window') && !dependencies.references.some((ref) => ref.role === 'song')
    ? [{ role: 'song', reason: 'Song dependency evidence was not recorded; review again' }] : [];
  for (const ref of dependencies.references) {
    const current = readCurrent(ref);
    if (!current || current.assetId !== ref.assetId || current.revision !== ref.revision) {
      changes.push({ ...ref, reason: `${ref.role === 'song' ? 'Master audio, lyrics or alignment' : ref.role === 'plate' ? 'Selected plate or its crop/mask inputs' : ref.role === 'endPlate' ? 'Selected end frame' : ref.role === 'clip' ? 'Selected clip' : ref.role === 'clipReferences' ? 'Selected clip references' : ref.role === 'layer' ? 'Shot timing or composition layer' : 'Composition'} changed` });
    }
  }
  return changes;
}

/** Absent legacy evidence is unknown, never an affirmative current verdict. */
export function musicVideoDependencyChanges(project, dependencies) {
  return dependencyChanges(dependencies, createDependencyReader(project));
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
  return presentMusicVideoDependencies({ ...after, scenes });
}

/** Read-only downstream preview. Generation count is an upper bound, not a price quote. */
export function musicVideoDependencyImpact(project, performanceChanges = []) {
  const readCurrent = createDependencyReader(project);
  const shots = [];
  for (const scene of project.scenes || []) {
    const take = selectedTake(scene, 'clip') || (!scene.videoHistoryId
      ? (scene.takes || []).findLast((entry) => entry.kind === 'video' && entry.status === 'rejected') : null);
    const changes = take ? takeChanges(project, scene, take, readCurrent) : [];
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
    const changes = dependencyChanges(dependencies, readCurrent);
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

/** Bounded projection for readers: retain verdicts/assets, expose their validity separately. */
export function presentMusicVideoDependencies(project) {
  if (!project) return project;
  const readCurrent = createDependencyReader(project);
  const state = (dependencies) => {
    const changes = dependencyChanges(dependencies, readCurrent);
    return { status: changes.length ? (changes[0].role === 'unknown' ? 'unknown' : 'stale') : 'current',
      reasons: [...new Set(changes.map((change) => change.reason))] };
  };
  return { ...project,
    // Legacy renders recorded no evidence; leave them unflagged rather than calling them stale.
    ...(project.renderHistoryId && project.renderDependencies ? { renderDependencyState: state(project.renderDependencies) } : {}),
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
  };
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
