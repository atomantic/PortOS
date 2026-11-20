/** Summarizes recorded generation spend and estimates the remaining shot generation jobs. */
import { isLayeredComposition, isSelfDrawnLayer, sceneVisualLayer } from './musicVideoLayers.js';
import { meteredModelLabel, meteredSceneTake } from './musicVideoShotTiming.js';
import { currentProductionRun } from './musicVideoStageProgress.js';
import { projectSpend as sharedProjectSpend } from '../../../server/lib/musicVideo/musicVideoSpend.js';

export { SPEND_ADJUSTMENT_LANES, spendLaneLabel } from '../../../server/lib/musicVideo/musicVideoSpend.js';

/**
 * What the project has spent on paid generation (server/lib/musicVideo/musicVideoSpend.js): production runs,
 * shot takes and, once the server attaches its render ledger (`renderSpend`), every paid render
 * for the project by lane with its unpriced renders counted (#16506). Capped by the live/latest
 * run's cap, else the autopilot brief's budget; `capUsd` is null when nothing caps it.
 */
export const projectSpend = (project) => sharedProjectSpend(project, currentProductionRun(project));

/**
 * What the project has spent on fal.ai, by model, from the estimates its paid
 * takes and production-run steps recorded: `{ totalUsd, models: [{ modelId,
 * label, usd, count }] }`, dearest first. `modelId` is null for spend recorded
 * before takes named their model. Estimates, not fal's invoice; a take pruned
 * from a full scene no longer counts.
 */
export function projectFalSpend(project) {
  const byModel = new Map();
  const add = (modelId, usd) => {
    if (!(Number.isFinite(usd) && usd > 0)) return;
    const key = modelId || null;
    const row = byModel.get(key) || { modelId: key, label: key ? meteredModelLabel(key) || key : 'Model not recorded', usd: 0, count: 0 };
    row.usd += usd;
    row.count += 1;
    byModel.set(key, row);
  };
  for (const scene of Array.isArray(project?.scenes) ? project.scenes : []) {
    for (const take of Array.isArray(scene?.takes) ? scene.takes : []) {
      if (take?.spendKind) add(take.costModelId, Number(take.costUsd));
    }
  }
  for (const run of Array.isArray(project?.productionRuns) ? project.productionRuns : []) {
    for (const step of Array.isArray(run?.steps) ? run.steps : []) {
      if ((step?.route?.mode === 'fal' || step?.route?.mode === 'runway') && step.status !== 'refused') add(step.costModelId || step.route.model, Number(step.costUsd));
    }
  }
  const models = [...byModel.values()].map((row) => ({ ...row, usd: Math.round(row.usd * 1e4) / 1e4 })).sort((a, b) => b.usd - a.usd);
  return { totalUsd: Math.round(models.reduce((sum, row) => sum + row.usd, 0) * 1e4) / 1e4, models };
}

/**
 * What generating the rest of the board takes (#10157): scenes still missing a
 * frame or a clip, the generation limit that covers them plus a 25% review
 * allowance, and the known fal.ai price of the missing clips. A frame, or a
 * clip on a route with no quote, counts as unpriced. Card and code shots in a
 * layered composition are drawn, not generated (#10297), so they need neither.
 */
export function boardJobEstimate(project) {
  const layered = isLayeredComposition(project);
  const scenes = (Array.isArray(project?.scenes) ? project.scenes : [])
    .filter((scene) => !isSelfDrawnLayer(sceneVisualLayer(scene, { layered })));
  const settings = project?.videoSettings || {};
  const missingFrames = scenes.filter((scene) => !scene?.referenceImageId).length;
  const missingClips = scenes.filter((scene) => !scene?.videoHistoryId);
  let knownUsd = 0;
  let unpriced = missingFrames;
  for (const scene of missingClips) {
    const cost = meteredSceneTake(settings.backend, { scene, videoSettings: settings, songDurationSec: project?.audioAnalysis?.durationSec ?? null })?.costUsd ?? null;
    if (Number.isFinite(cost)) knownUsd += cost;
    else unpriced += 1;
  }
  const jobs = missingFrames + missingClips.length;
  return { jobs, knownUsd, unpriced, suggestedMaxGenerations: Math.min(500, Math.max(1, Math.ceil(jobs * 1.25))) };
}
