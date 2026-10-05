/** Asset pilots use the existing review gate, never a second grading rubric. */
import { canonicalSnapshotChecksum } from '../../lib/snapshotChecksum.js';
import { captureMusicVideoEvidence, captureTakeDependencies, musicVideoDependencyChanges } from '../../lib/musicVideoDependencies.js';
import { codeFirstProductionAssets } from '../../lib/musicVideoMediumPlan.js';
import { isLayeredComposition, sceneVisualLayer } from '../../lib/musicVideoLayers.js';

export function pilotClass(scene, project) {
  const medium = project.treatment?.shotDirections?.find((d) => d.sceneId === scene.sceneId)?.medium;
  if (medium === 'still' || sceneVisualLayer(scene, { layered: isLayeredComposition(project) }) === 'still') return 'still';
  if (scene.shotMode === 'performance') return 'performance';
  const contract = scene.direction?.actionContract;
  if (contract?.reactions?.length || new Set((contract?.actions || []).map((a) => a.subject)).size > 1) return 'interaction';
  if (contract?.cameraConstraints?.length || scene.direction?.camera) return 'camera';
  return 'cutaway';
}

/** One representative of each operation, hardest shots first. Existing assets count. */
export function selectProductionPilots(project) {
  const assets = codeFirstProductionAssets(project);
  const allowed = assets && new Set(assets.steps.filter((s) => s.action !== 'code').map((s) => s.sceneId));
  const seen = new Set();
  const rank = { performance: 5, interaction: 4, camera: 3, cutaway: 2, still: 1 };
  return (project.scenes || [])
    .filter((scene) => allowed ? allowed.has(scene.sceneId) : !['card', 'code'].includes(sceneVisualLayer(scene, { layered: isLayeredComposition(project) })))
    .map((scene) => ({ sceneId: scene.sceneId, operation: pilotClass(scene, project),
      missing: Number(!scene.referenceImageId) + Number(pilotClass(scene, project) !== 'still' && !scene.videoHistoryId),
      complexity: (scene.direction?.actionContract?.actions?.length || 0)
        + (scene.direction?.actionContract?.reactions?.length || 0)
        + (scene.direction?.actionContract?.cameraConstraints?.length || 0) }))
    .sort((a, b) => rank[b.operation] - rank[a.operation] || b.missing - a.missing || b.complexity - a.complexity)
    .filter(({ operation }) => !seen.has(operation) && seen.add(operation))
    .map(({ sceneId, operation }) => ({ sceneId, operation }));
}

export function pilotDependencies(project, sceneId) {
  const scene = project.scenes?.find((s) => s.sceneId === sceneId);
  const evidence = captureMusicVideoEvidence(project, { sceneIds: [sceneId], composition: false });
  return { ...evidence,
    references: [...evidence.references,
      ...captureTakeDependencies(scene).references] };
}

export const pilotInputBasis = (project, sceneId) => {
  const scene = project.scenes?.find((s) => s.sceneId === sceneId);
  return canonicalSnapshotChecksum({ scene: scene && Object.fromEntries(Object.entries(scene)
    .filter(([key]) => !['takes', 'referenceImageId', 'videoHistoryId', 'updatedAt'].includes(key))),
    videoSettings: project.videoSettings, audio: project.audioAnalysis, lyrics: project.lyricCues,
    master: { trackId: project.trackId, uploadedAudioFilename: project.uploadedAudioFilename, vocalStemFilename: project.vocalStemFilename },
    lyricMarkers: project.lyricMarkers, phrases: project.phrases, concept: project.concept,
    style: project.visualSpec, references: project.styleReferences });
};

export function currentPilotPass(project, pilot) {
  const review = project.autoReviews?.find((r) => r.id === pilot.reviewRunId);
  const result = review?.attempts?.at(-1)?.review;
  return review?.status === 'passed' && result?.verdict === 'pass'
    && pilot.inputBasis === pilotInputBasis(project, pilot.sceneId)
    && !musicVideoDependencyChanges(project, result.dependencies).length;
}

/** Prefer an edit/reuse before charging for replacement media. No identical retries. */
export function pilotRepair(review, scene, project) {
  const checks = review?.checks || {};
  const contract = scene?.direction?.actionContract;
  const plateFailed = scene?.takes?.some((take) => take.plateEvidence?.verdict === 'fail');
  const visibleFailure = review?.findings?.find((f) => f.severity === 'blocking'
    && ['plate', 'prompt-action', 'composition'].includes(f.failureCategory))?.failureCategory;
  const category = plateFailed ? 'plate'
    : checks.lipSync === 'fail' || checks.audioSync === 'fail' ? 'temporal-alignment'
      : visibleFailure || (checks.motion === 'fail' && contract ? 'prompt-action'
        : checks.composition === 'fail' || checks.continuity === 'fail' ? 'composition'
          : 'provider-capability');
  const choices = {
    plate: ['select-plate', 'Select a passing existing plate before generating a replacement.'],
    'temporal-alignment': ['timing-edit', 'Preview a timing correction against temporal evidence before replacing footage.'],
    'prompt-action': ['edit-action', 'Correct the authored action or select a take that meets it before paying for another take.'],
    composition: [project.productionPolicy?.strategy === 'code-first' ? 'revise-document' : 'composition-edit',
      'Repair framing, cues or document code while retaining the selected media.'],
    'provider-capability': ['verify-route', 'Verify the reviewer/provider capability and evidence; repeating an unsupported operation is not a repair.'],
  };
  const [action, reason] = choices[category];
  return { category, action, reason, expectedGenerationSpendUsd: 0 };
}

/**
 * A pilot from an incomplete board retains its absolute song position. A
 * prefix card occupies unproduced time; it is trimmed OUT of the excerpt.
 * Document projects test selected assets here, then review their authored
 * document separately. No placeholder can appear inside a pilot's window.
 */
export function productionPilotRenderProject(project, sceneId) {
  const scene = project.scenes?.find((s) => s.sceneId === sceneId);
  if (!scene || !(scene.startSec >= 0) || !(scene.endSec > scene.startSec)) throw new Error('The pilot needs an authored song window');
  const still = pilotClass(scene, project) === 'still';
  if (!(still ? scene.referenceImageId : scene.videoHistoryId)) throw new Error('The pilot selected asset is missing');
  const prefix = scene.startSec > 0 ? [{ sceneId: 'pilot-prefix', order: 0, visualLayer: 'card',
    startSec: 0, endSec: scene.startSec, cardText: '', cardColor: '#000000' }] : [];
  return { ...project, scenes: [...prefix, { ...scene, order: 1, visualLayer: still ? 'still' : 'footage' }],
    composition: { ...project.composition, mode: 'composed', cutting: 'sequential' } };
}
