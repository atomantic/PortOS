import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finalApprovalPatch } from '../../lib/musicVideo/musicVideoFinalApproval.js';

const state = { project: null };
const updateScene = vi.fn();
const appendSceneTakes = vi.fn();
const selectSceneTake = vi.fn();
const renderSceneClips = vi.fn();
const upscaleHistoryItem = vi.fn();
const enqueueRealesrganUpscale = vi.fn();
const describeRealesrganRuntime = vi.fn();
vi.mock('./projects.js', () => ({ updateScene: (...a) => updateScene(...a), appendSceneTakes: (...a) => appendSceneTakes(...a), selectSceneTake: (...a) => selectSceneTake(...a) }));
vi.mock('./requireProject.js', () => ({ requireProject: async () => state.project }));
vi.mock('./sceneCardRender.js', () => ({ renderSceneClips: (...a) => renderSceneClips(...a) }));
vi.mock('../videoGen/upscaleVideo.js', () => ({ upscaleHistoryItem: (...a) => upscaleHistoryItem(...a) }));
vi.mock('../videoGen/realesrganUpscaleJob.js', () => ({ enqueueRealesrganUpscale: (...a) => enqueueRealesrganUpscale(...a) }));
vi.mock('../videoGen/realesrganRuntime.js', () => ({ describeRealesrganRuntime: (...a) => describeRealesrganRuntime(...a) }));

const { approveFinal, upgradeApproved } = await import('./finalUpgrade.js');

const draftShot = (sceneId, approved) => {
  const scene = { sceneId, prompt: `prompt ${sceneId}`, referenceImageId: `img-${sceneId}`, videoHistoryId: `vid-${sceneId}`, takes: [{ takeId: `t-${sceneId}`, kind: 'video', assetId: `vid-${sceneId}`, tier: 'draft' }] };
  return approved ? { ...scene, ...finalApprovalPatch(scene, true).patch } : scene;
};

beforeEach(() => {
  vi.clearAllMocks();
  state.project = { id: 'p1', videoSettings: { backend: 'local' }, scenes: [draftShot('a', true), draftShot('b', false)] };
});

describe('final upgrade', () => {
  it('approves a shot through the scene patch and reports counts', async () => {
    updateScene.mockResolvedValue({ sceneId: 'b' });
    const out = await approveFinal('p1', { sceneIds: ['b'], approved: true });
    expect(updateScene).toHaveBeenCalledWith('p1', 'b', { finalApproval: { takeId: 't-b', revision: expect.any(String) } });
    expect(out.counts).toMatchObject({ draft: 2, approved: 1 });
  });

  it('dry-run plans only approved shots and renders nothing', async () => {
    const out = await upgradeApproved('p1', { method: 'upscale', dryRun: true });
    expect(out.shots).toEqual([{ sceneId: 'a', status: 'ready', method: 'upscale', upscaleMethod: 'lanczos', costUsd: 0 }]);
    expect(out.totalCostUsd).toBe(0);
    expect(upscaleHistoryItem).not.toHaveBeenCalled();
    expect(renderSceneClips).not.toHaveBeenCalled();
  });

  it('refuses an unapproved shot named explicitly', async () => {
    const out = await upgradeApproved('p1', { sceneIds: ['b'], method: 'upscale' });
    expect(out.results).toEqual([{ sceneId: 'b', ok: false, status: 'not-approved' }]);
    expect(upscaleHistoryItem).not.toHaveBeenCalled();
  });

  it('upscale records a final take and selects it', async () => {
    upscaleHistoryItem.mockResolvedValue({ id: 'vid-up' });
    appendSceneTakes.mockResolvedValue({ appended: [{ takeId: 't-up' }] });
    const out = await upgradeApproved('p1', { method: 'upscale' });
    expect(appendSceneTakes).toHaveBeenCalledWith('p1', 'a', [expect.objectContaining({ kind: 'video', assetId: 'vid-up', tier: 'final' })]);
    expect(selectSceneTake).toHaveBeenCalledWith('p1', 'a', 't-up');
    expect(out.results[0]).toMatchObject({ ok: true, takeId: 't-up' });
  });

  it('re-render submits a final-tier clip and leaves the selection alone', async () => {
    state.project.videoSettings = { backend: 'fal' };
    renderSceneClips.mockResolvedValue({ jobId: 'j1' });
    const plan = await upgradeApproved('p1', { method: 'rerender', dryRun: true });
    expect(plan.shots[0]).toMatchObject({ status: 'ready', method: 'rerender' });
    const out = await upgradeApproved('p1', { method: 'rerender' });
    expect(renderSceneClips).toHaveBeenCalledWith(expect.anything(), { sceneId: 'a', tier: 'final' });
    expect(selectSceneTake).not.toHaveBeenCalled();
    expect(out.results[0].ok).toBe(true);
  });

  // #19985: the opt-in Real-ESRGAN upscaler is planned from its read-only readiness and queued,
  // landing through the scene-video hook as a final take selected over the draft it came from.
  it('plans Real-ESRGAN from its install readiness and refuses it until installed', async () => {
    describeRealesrganRuntime.mockResolvedValue({
      supported: true, installed: false, reason: 'Real-ESRGAN (ncnn Vulkan) is not installed on this machine.',
      installTarget: { version: 'v0.2.5.0', sizeBytes: 51_817_124 },
    });
    const plan = await upgradeApproved('p1', { method: 'upscale', upscaleMethod: 'realesrgan', dryRun: true });
    expect(plan).toMatchObject({
      upscaleMethod: 'realesrgan', upscalerSupported: true, upscalerReason: expect.stringMatching(/not installed/),
      upscalerInstallTarget: { version: 'v0.2.5.0', sizeBytes: 51_817_124 }, totalCostUsd: 0,
    });
    expect(plan.shots).toEqual([{ sceneId: 'a', status: 'upscaler-not-ready', upscaleMethod: 'realesrgan' }]);
    const out = await upgradeApproved('p1', { method: 'upscale', upscaleMethod: 'realesrgan' });
    expect(out.results).toEqual([{ sceneId: 'a', ok: false, status: 'upscaler-not-ready' }]);
    expect(enqueueRealesrganUpscale).not.toHaveBeenCalled();
  });

  it('queues a Real-ESRGAN upscale attributed to the shot instead of selecting inline', async () => {
    describeRealesrganRuntime.mockResolvedValue({ installed: true, reason: null });
    enqueueRealesrganUpscale.mockResolvedValue({ jobId: 'job-up', status: 'queued' });
    const plan = await upgradeApproved('p1', { method: 'upscale', upscaleMethod: 'realesrgan', dryRun: true });
    expect(plan.shots).toEqual([{ sceneId: 'a', status: 'ready', method: 'upscale', upscaleMethod: 'realesrgan', costUsd: 0 }]);
    const out = await upgradeApproved('p1', { method: 'upscale', upscaleMethod: 'realesrgan' });
    expect(enqueueRealesrganUpscale).toHaveBeenCalledWith('vid-a', { musicVideoProjectId: 'p1', sceneId: 'a', selectOverSource: true });
    expect(out.results).toEqual([{ sceneId: 'a', ok: true, method: 'upscale', jobId: 'job-up', queued: true }]);
    expect(upscaleHistoryItem).not.toHaveBeenCalled();
    expect(appendSceneTakes).not.toHaveBeenCalled();
    expect(selectSceneTake).not.toHaveBeenCalled();
  });
});
