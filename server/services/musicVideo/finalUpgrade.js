/**
 * Per-shot approval and upgrade of draft clips to the final tier (#16136).
 *
 * `approveFinal` ticks or clears shots; `upgradeApproved` plans (always) and, unless `dryRun`, runs the
 * upgrade by one of two methods per shot: `upscale` runs the install's 2x upscaler over the approved
 * draft take and selects the result (same take, higher resolution, no provider spend); `rerender`
 * submits a final-tier clip from the same prompt and references. A re-render has no seed to repeat, so
 * it lands beside the draft as an unselected take for the director to compare and pick.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { finalApprovalPatch, finalTierCounts, sceneClipIsFinal, sceneFinalApproved, selectedVideoTake } from '../../lib/musicVideo/musicVideoFinalApproval.js';
import { sceneRenderTierChoices } from '../../lib/musicVideo/musicVideoRenderTier.js';
import { appendSceneTakes, selectSceneTake, updateScene } from './projects.js';
import { requireProject } from './requireProject.js';
import { renderSceneClips } from './sceneCardRender.js';

const findScene = (project, sceneId) => {
  const scene = project.scenes?.find((entry) => entry.sceneId === sceneId);
  if (!scene) throw new ServerError(`Shot ${sceneId} not found`, { status: 404, code: 'NOT_FOUND' });
  return scene;
};

/**
 * Approve or clear `sceneIds`; returns the project's tier counts and the changed shots, and with
 * `{ edit: true }` the edit result (editResult.js) between the record before and after.
 */
export async function approveFinal(projectId, { sceneIds, approved }, { edit = false } = {}) {
  const project = await requireProject(projectId);
  const patches = sceneIds.map((sceneId) => {
    const outcome = finalApprovalPatch(findScene(project, sceneId), approved);
    if (outcome.problem) throw new ServerError(`${outcome.problem} (${sceneId})`, { status: 422, code: 'MUSIC_VIDEO_FINAL_NEEDS_CLIP' });
    return { sceneId, patch: outcome.patch };
  });
  const scenes = [];
  for (const { sceneId, patch } of patches) scenes.push(await updateScene(projectId, sceneId, patch));
  const latest = await requireProject(projectId);
  if (!edit) return { scenes, counts: finalTierCounts(latest.scenes) };
  const { presentEditResult } = await import('./editResult.js');
  return { scenes, counts: finalTierCounts(latest.scenes), edit: await presentEditResult({ before: project, after: latest }) };
}

/** One shot's upgrade plan: `{ sceneId, status, ... }` where `status` is `ready` or the reason it is skipped. */
function planShot(project, scene, method) {
  if (!selectedVideoTake(scene)) return { sceneId: scene.sceneId, status: 'no-clip' };
  if (sceneClipIsFinal(scene)) return { sceneId: scene.sceneId, status: 'already-final' };
  if (!sceneFinalApproved(scene)) return { sceneId: scene.sceneId, status: 'not-approved' };
  if (method === 'upscale') return { sceneId: scene.sceneId, status: 'ready', method, costUsd: 0 };
  const choices = sceneRenderTierChoices(project.videoSettings?.backend, { scene, scenes: project.scenes, videoSettings: project.videoSettings, songDurationSec: project.audioAnalysis?.durationSec ?? null });
  const final = choices?.find((choice) => choice.tier === 'final');
  if (!final) return { sceneId: scene.sceneId, status: 'no-final-tier' };
  return { sceneId: scene.sceneId, status: 'ready', method, resolution: final.resolution, costUsd: final.costUsd };
}

function planUpgrade(project, { sceneIds, method }) {
  const scenes = sceneIds ? sceneIds.map((id) => findScene(project, id)) : (project.scenes || []).filter(sceneFinalApproved);
  const shots = scenes.map((scene) => planShot(project, scene, method));
  const priced = shots.filter((shot) => shot.status === 'ready');
  // A lane PortOS cannot price leaves the total unknown rather than understated.
  const totalCostUsd = priced.some((shot) => shot.costUsd == null) ? null : priced.reduce((sum, shot) => sum + shot.costUsd, 0);
  return { method, shots, totalCostUsd };
}

async function upscaleShot(projectId, scene) {
  const { upscaleHistoryItem } = await import('../videoGen/upscaleVideo.js');
  const entry = await upscaleHistoryItem(scene.videoHistoryId, { method: 'lanczos' });
  const { appended } = await appendSceneTakes(projectId, scene.sceneId, [{
    kind: 'video', assetId: entry.id, source: 'generated', provider: 'portos', tier: 'final',
  }]);
  await selectSceneTake(projectId, scene.sceneId, appended[0].takeId);
  return { takeId: appended[0].takeId };
}

/** Plan the upgrade and, unless `dryRun`, run it; each shot reports its own `ok` or error. */
export async function upgradeApproved(projectId, { sceneIds, method, dryRun = false }) {
  const project = await requireProject(projectId);
  const plan = planUpgrade(project, { sceneIds, method });
  if (dryRun) return { dryRun: true, ...plan, counts: finalTierCounts(project.scenes) };
  const results = [];
  for (const shot of plan.shots) {
    if (shot.status !== 'ready') {
      results.push({ sceneId: shot.sceneId, ok: false, status: shot.status });
      continue;
    }
    try {
      const scene = findScene(project, shot.sceneId);
      const outcome = method === 'upscale'
        ? await upscaleShot(projectId, scene)
        : await renderSceneClips(project, { sceneId: shot.sceneId, tier: 'final' });
      results.push({ sceneId: shot.sceneId, ok: true, method, ...outcome });
    } catch (error) {
      results.push({ sceneId: shot.sceneId, ok: false, error: error.message, code: error.code || null });
    }
  }
  const latest = await requireProject(projectId);
  return { dryRun: false, ...plan, results, counts: finalTierCounts(latest.scenes) };
}
