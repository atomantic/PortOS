/** Versioned Music Video provenance. Only pointers/checksums live on project rows. */
import { canonicalSnapshotChecksum } from './snapshotChecksum.js';

export const MUSIC_VIDEO_DEPENDENCY_VERSION = 1;
const slots = { plate: 'referenceImageId', clip: 'videoHistoryId' };
const checksum = (value) => canonicalSnapshotChecksum(value);
const selectedTake = (scene, role, assetId = scene?.[slots[role]]) => (scene?.takes || [])
  .find((take) => take.kind === (role === 'plate' ? 'image' : 'video') && take.assetId === assetId);
const assetRef = (scene, role, assetId = scene?.[slots[role]]) => ({
  role, sceneId: scene.sceneId, assetId: assetId || null,
  revision: checksum({ assetId: assetId || null, inputs: selectedTake(scene, role, assetId)?.inputAssets || [] }),
});
const layerRef = (scene) => ({ role: 'layer', sceneId: scene.sceneId, assetId: scene.sceneId,
  revision: checksum(Object.fromEntries(['startSec', 'endSec', 'visualLayer', 'stillMove', 'cardText', 'cardColor', 'shotMode', 'performanceSpeaker', 'loop']
    .map((key) => [key, scene[key] ?? null]).concat([['actionContract', scene.direction?.actionContract || null]]))) });
const snapshot = (references) => ({ version: MUSIC_VIDEO_DEPENDENCY_VERSION, references });

/** Capture the actual submitted plate, including optional crop/mask provenance. */
export function captureTakeDependencies(scene, sourceImageId = scene?.referenceImageId) {
  return snapshot(sourceImageId ? [assetRef(scene, 'plate', sourceImageId)] : []);
}

const intersects = (scene, startSec, endSec) => !(typeof scene.startSec === 'number' && typeof scene.endSec === 'number')
  || (scene.startSec < endSec && scene.endSec > startSec);
const compositionRef = (project, startSec, endSec) => {
  const composition = project.composition || null;
  const value = composition ? { ...composition,
    cues: (composition.cues || []).filter((cue) => intersects(cue, startSec, endSec)),
  } : null;
  return { role: 'composition', assetId: 'composition', revision: checksum({ mediaMode: project.mediaMode || null, composition: value }), startSec, endSec };
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
    const role = scene.visualLayer === 'still' ? 'plate' : scene.visualLayer === 'card' ? null : 'clip';
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

/** Absent legacy evidence is unknown, never an affirmative current verdict. */
export function musicVideoDependencyChanges(project, dependencies) {
  if (!dependencies || dependencies.version !== MUSIC_VIDEO_DEPENDENCY_VERSION || !Array.isArray(dependencies.references)) {
    return [{ role: 'unknown', reason: 'Dependency evidence was not recorded; review again' }];
  }
  const changes = dependencies.references.some((ref) => ref.role === 'window') && !dependencies.references.some((ref) => ref.role === 'song')
    ? [{ role: 'song', reason: 'Song dependency evidence was not recorded; review again' }] : [];
  for (const ref of dependencies.references) {
    let current;
    const scene = (project.scenes || []).find((entry) => entry.sceneId === ref.sceneId);
    if (ref.role === 'song') current = songRef(project);
    else if (ref.role === 'window') current = { assetId: 'scene-set', revision: checksum((project.scenes || []).filter((scene) => intersects(scene, ref.startSec, ref.endSec)).map((scene) => scene.sceneId).sort()) };
    else if (ref.role === 'composition') current = compositionRef(project, ref.startSec, ref.endSec);
    else if (!scene) current = null;
    else if (slots[ref.role]) current = assetRef(scene, ref.role);
    else if (ref.role === 'layer') current = layerRef(scene);
    if (!current || current.assetId !== ref.assetId || current.revision !== ref.revision) {
      changes.push({ ...ref, reason: `${ref.role === 'song' ? 'Master audio, lyrics or alignment' : ref.role === 'plate' ? 'Selected plate or its crop/mask inputs' : ref.role === 'clip' ? 'Selected clip' : ref.role === 'layer' ? 'Shot timing or composition layer' : 'Composition'} changed` });
    }
  }
  return changes;
}

export function musicVideoTakeChanges(project, scene, take) {
  if (take?.dependencies) return musicVideoDependencyChanges(project, take.dependencies);
  // Pre-provenance generated clips still recorded their actual source basename.
  if (take?.sourceImageId && take.sourceImageId !== scene.referenceImageId) {
    return [{ role: 'plate', sceneId: scene.sceneId, reason: 'Selected plate changed' }];
  }
  return [];
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
  const shots = [];
  for (const scene of project.scenes || []) {
    const take = selectedTake(scene, 'clip') || (!scene.videoHistoryId
      ? (scene.takes || []).findLast((entry) => entry.kind === 'video' && entry.status === 'rejected') : null);
    const changes = take ? musicVideoTakeChanges(project, scene, take) : [];
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
    const changes = musicVideoDependencyChanges(project, dependencies);
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
  const state = (dependencies) => {
    const changes = musicVideoDependencyChanges(project, dependencies);
    return { status: changes.length ? (changes[0].role === 'unknown' ? 'unknown' : 'stale') : 'current',
      reasons: [...new Set(changes.map((change) => change.reason))] };
  };
  return { ...project,
    ...(project.renderHistoryId && project.renderDependencies ? { renderDependencyState: state(project.renderDependencies) } : {}),
    scenes: (project.scenes || []).map((scene) => ({ ...scene, takes: (scene.takes || []).map((take) => ({ ...take,
      ...(take.dependencies ? { dependencyState: state(take.dependencies) } : {}),
    })) })),
    ...(project.excerpts ? { excerpts: project.excerpts.map((excerpt) => ({ ...excerpt, dependencyState: state(excerpt.dependencies) })) } : {}),
    ...(project.treatment ? { treatment: { ...project.treatment, proofs: (project.treatment.proofs || []).map((proof) => ({ ...proof,
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
    return { ...ref, ...(ref.sceneId ? { sceneId } : {}), ...(ref.role === 'layer' ? { assetId: sceneId } : {}) };
  }) };
}
