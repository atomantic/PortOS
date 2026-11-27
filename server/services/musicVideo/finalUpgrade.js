/**
 * Per-shot approval and upgrade of draft clips to the final tier (#16136).
 *
 * `approveFinal` ticks or clears shots; `upgradeApproved` plans (always) and, unless `dryRun`, runs the
 * upgrade by one of two methods per shot: `upscale` processes the approved draft with the configured
 * upscaler and selects the resulting take when it lands; `rerender`
 * submits a final-tier clip from the same prompt and references. A re-render has no seed to repeat, so
 * it lands beside the draft as an unselected take for the director to compare and pick.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { finalApprovalPatch, finalTierCounts, sceneClipIsFinal, sceneFinalApproved, selectedVideoTake } from '../../lib/musicVideo/musicVideoFinalApproval.js';
import { sceneRenderTierChoices } from '../../lib/musicVideo/musicVideoRenderTier.js';
import { musicVideoUpscaleSettings } from '../../lib/musicVideo/musicVideoUpscale.js';
import { resolveFalApiKey } from '../falQueue.js';
import { getSettings } from '../settings.js';
import { updateScene } from './projects.js';
import { submitShotUpscale } from './shotUpscale.js';
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
async function planShot(project, scene, method, upscale) {
  if (!selectedVideoTake(scene)) return { sceneId: scene.sceneId, status: 'no-clip' };
  if (sceneClipIsFinal(scene)) return { sceneId: scene.sceneId, status: 'already-final' };
  if (!sceneFinalApproved(scene)) return { sceneId: scene.sceneId, status: 'not-approved' };
  if (method === 'upscale') {
    const shot = { sceneId: scene.sceneId, status: 'ready', method, ...upscale };
    if (upscale.upscaleMethod === 'realesrgan') {
      const { planUpscaleHistoryItem } = await import('../videoGen/upscaleVideo.js');
      const plan = await planUpscaleHistoryItem(scene.videoHistoryId, { method: 'realesrgan' })
        .catch((error) => ({ error: error.message }));
      if (plan.error || plan.alreadyUpscaled || !plan.runtime.installed) {
        const reason = plan.error || (plan.alreadyUpscaled ? 'The selected clip is already upscaled.' : plan.runtime.reason);
        return {
          ...shot,
          status: 'upscale-blocked',
          reason,
          ...(plan.runtime ? { upscalerSupported: plan.runtime.supported, upscalerInstallTarget: plan.runtime.installTarget ?? null } : {}),
        };
      }
      return { ...shot, costUsd: 0 };
    }
    if (upscale.upscaleMethod === 'fal-topaz') return { ...shot, historyId: scene.videoHistoryId, costUsd: null };
    if (upscale.upscaleMethod !== 'fal-seedvr2') return { ...shot, costUsd: 0 };
    const { planUpscaleHistoryItem } = await import('../videoGen/upscaleVideo.js');
    const plan = await planUpscaleHistoryItem(scene.videoHistoryId, {
      method: upscale.upscaleMethod, targetResolution: upscale.upscaleTargetResolution,
    }).catch((error) => ({ error: error.message }));
    if (plan.error || plan.alreadyUpscaled || !plan.runtime.installed || plan.estimatedCostUsd == null) {
      const reason = plan.error || (plan.alreadyUpscaled ? 'The selected clip is already upscaled.'
        : plan.runtime.reason || 'The selected clip could not be measured for a cost estimate.');
      return { ...shot, status: 'upscale-blocked', reason };
    }
    return { ...shot, costUsd: plan.estimatedCostUsd };
  }
  const choices = sceneRenderTierChoices(project.videoSettings?.backend, { scene, scenes: project.scenes, videoSettings: project.videoSettings, songDurationSec: project.audioAnalysis?.durationSec ?? null });
  const final = choices?.find((choice) => choice.tier === 'final');
  if (!final) return { sceneId: scene.sceneId, status: 'no-final-tier' };
  return { sceneId: scene.sceneId, status: 'ready', method, resolution: final.resolution, costUsd: final.costUsd };
}

async function planUpgrade(project, { sceneIds, method, ...overrides }) {
  const settings = { ...project.videoSettings, ...overrides };
  const falConfigured = method === 'upscale' && !settings.upscaleMethod && Boolean(resolveFalApiKey(await getSettings()));
  const upscale = method === 'upscale' ? musicVideoUpscaleSettings(settings, falConfigured) : null;
  const scenes = sceneIds ? sceneIds.map((id) => findScene(project, id)) : (project.scenes || []).filter(sceneFinalApproved);
  const shots = [];
  for (const scene of scenes) shots.push(await planShot(project, scene, method, upscale));
  const priced = shots.filter((shot) => shot.status === 'ready');
  // A lane PortOS cannot price leaves the total unknown rather than understated.
  const totalCostUsd = priced.some((shot) => shot.costUsd == null) ? null : priced.reduce((sum, shot) => sum + shot.costUsd, 0);
  return { method, ...upscale, shots, totalCostUsd };
}

/** Plan the upgrade and, unless `dryRun`, run it; each shot reports its own `ok` or error. */
export async function upgradeApproved(projectId, { sceneIds, method, dryRun = false, topazQuotes, ...overrides }) {
  const project = await requireProject(projectId);
  const plan = await planUpgrade(project, { sceneIds, method, ...overrides });
  if (dryRun) return { dryRun: true, ...plan, counts: finalTierCounts(project.scenes) };
  const results = [];
  for (const shot of plan.shots) {
    if (shot.status !== 'ready') {
      results.push({ sceneId: shot.sceneId, ok: false, status: shot.status, ...(shot.reason ? { error: shot.reason } : {}) });
      continue;
    }
    try {
      const scene = findScene(project, shot.sceneId);
      const outcome = method === 'upscale'
        ? await submitShotUpscale(projectId, shot.sceneId, scene.videoHistoryId, {
          method: shot.upscaleMethod, targetResolution: shot.upscaleTargetResolution,
          topazToken: topazQuotes?.[shot.sceneId], requireApproval: true,
        }).then(({ job, takeId }) => job ? { jobId: job.jobId, status: job.status } : { takeId })
        : await renderSceneClips(project, { sceneId: shot.sceneId, tier: 'final' });
      results.push({ sceneId: shot.sceneId, ok: true, method, ...outcome });
    } catch (error) {
      results.push({ sceneId: shot.sceneId, ok: false, error: error.message, code: error.code || null });
    }
  }
  const latest = await requireProject(projectId);
  return { dryRun: false, ...plan, results, counts: finalTierCounts(latest.scenes) };
}
