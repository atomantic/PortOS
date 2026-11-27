import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finalApprovalPatch } from '../../lib/musicVideo/musicVideoFinalApproval.js';

const state = { project: null };
const updateScene = vi.fn();
const appendSceneTakes = vi.fn();
const planUpscaleHistoryItem = vi.fn();
const enqueueFalSeedvr2Upscale = vi.fn();
const enqueueTopazUpscale = vi.fn();
const listInFlightSceneJobs = vi.fn(() => []);
vi.mock('./sceneJobs.js', () => ({ listInFlightSceneJobs }));
vi.mock('../videoGen/falUpscaleJob.js', () => ({ enqueueFalSeedvr2Upscale }));
vi.mock('../videoGen/topazJob.js', () => ({ enqueueTopazUpscale }));
const renderSceneClips = vi.fn();
const upscaleHistoryItem = vi.fn();
vi.mock('./projects.js', () => ({ updateScene: (...a) => updateScene(...a), appendSceneTakes: (...a) => appendSceneTakes(...a) }));
vi.mock('./requireProject.js', () => ({ requireProject: async () => state.project }));
vi.mock('./sceneCardRender.js', () => ({ renderSceneClips: (...a) => renderSceneClips(...a) }));
vi.mock('../videoGen/upscaleVideo.js', () => ({ upscaleHistoryItem, planUpscaleHistoryItem }));

const { approveFinal, upgradeApproved } = await import('./finalUpgrade.js');

const draftShot = (sceneId, approved) => {
  const scene = { sceneId, prompt: `prompt ${sceneId}`, referenceImageId: `img-${sceneId}`, videoHistoryId: `vid-${sceneId}`, takes: [{ takeId: `t-${sceneId}`, kind: 'video', assetId: `vid-${sceneId}`, tier: 'draft' }] };
  return approved ? { ...scene, ...finalApprovalPatch(scene, true).patch } : scene;
};

beforeEach(() => {
  vi.clearAllMocks();
  state.project = { id: 'p1', videoSettings: { backend: 'local', upscaleMethod: 'lanczos' }, scenes: [draftShot('a', true), draftShot('b', false)] };
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
    expect(out.shots).toEqual([{ sceneId: 'a', status: 'ready', method: 'upscale', upscaleMethod: 'lanczos', upscaleTargetResolution: '1080p', costUsd: 0 }]);
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
    appendSceneTakes.mockResolvedValue({ scene: { videoHistoryId: 'vid-up', takes: [] }, appended: [{ takeId: 't-up' }] });
    const out = await upgradeApproved('p1', { method: 'upscale' });
    expect(appendSceneTakes).toHaveBeenCalledWith('p1', 'a', [expect.objectContaining({ kind: 'video', assetId: 'vid-up', tier: 'final' })]);
    expect(appendSceneTakes.mock.calls[0][2][0].upscaledFrom).toBe('vid-a');
    expect(out.results[0]).toMatchObject({ ok: true, takeId: 't-up' });
  });

  it('prices SeedVR2 per source and forwards the configured target and scene when queued', async () => {
    state.project.videoSettings = { upscaleMethod: 'fal-seedvr2', upscaleTargetResolution: '1440p' };
    planUpscaleHistoryItem.mockResolvedValue({ runtime: { installed: true }, estimatedCostUsd: 0.4128 });
    enqueueFalSeedvr2Upscale.mockResolvedValue({ jobId: 'upscale-a', status: 'queued' });
    const plan = await upgradeApproved('p1', { method: 'upscale', dryRun: true });
    expect(plan).toMatchObject({ upscaleMethod: 'fal-seedvr2', upscaleTargetResolution: '1440p', totalCostUsd: 0.4128 });
    expect(planUpscaleHistoryItem).toHaveBeenCalledWith('vid-a', { method: 'fal-seedvr2', targetResolution: '1440p' });
    expect(enqueueFalSeedvr2Upscale).not.toHaveBeenCalled();

    const result = await upgradeApproved('p1', { method: 'upscale', upscaleTargetResolution: '1080p' });
    expect(result.results).toEqual([{ sceneId: 'a', ok: true, method: 'upscale', jobId: 'upscale-a', status: 'queued' }]);
    expect(enqueueFalSeedvr2Upscale).toHaveBeenCalledWith('vid-a', {
      targetResolution: '1080p',
      musicVideo: { projectId: 'p1', sceneId: 'a', tier: 'final', selectOnComplete: true },
    });
    expect(appendSceneTakes).not.toHaveBeenCalled();
  });

  it('requires a Topaz quote per shot before submitting a paid upgrade', async () => {
    state.project.videoSettings.upscaleMethod = 'fal-topaz';
    const plan = await upgradeApproved('p1', { method: 'upscale', dryRun: true });
    expect(plan).toMatchObject({ totalCostUsd: null, shots: [{ sceneId: 'a', historyId: 'vid-a', status: 'ready' }] });
    const refused = await upgradeApproved('p1', { method: 'upscale' });
    expect(refused.results[0]).toMatchObject({ ok: false, code: 'TOPAZ_QUOTE_REQUIRED' });
    expect(enqueueTopazUpscale).not.toHaveBeenCalled();
    enqueueTopazUpscale.mockResolvedValue({ jobId: 'topaz-upscale', status: 'queued' });
    const queued = await upgradeApproved('p1', { method: 'upscale', topazQuotes: { a: 'confirmed-quote' } });
    expect(queued.results[0]).toMatchObject({ ok: true, jobId: 'topaz-upscale', status: 'queued' });
    expect(enqueueTopazUpscale).toHaveBeenCalledWith('vid-a', 'confirmed-quote', {
      musicVideo: { projectId: 'p1', sceneId: 'a', tier: 'final', selectOnComplete: true },
    });
  });

  it('re-render submits a final-tier clip and leaves the selection alone', async () => {
    state.project.videoSettings = { backend: 'fal' };
    renderSceneClips.mockResolvedValue({ jobId: 'j1' });
    const plan = await upgradeApproved('p1', { method: 'rerender', dryRun: true });
    expect(plan.shots[0]).toMatchObject({ status: 'ready', method: 'rerender' });
    const out = await upgradeApproved('p1', { method: 'rerender' });
    expect(renderSceneClips).toHaveBeenCalledWith(expect.anything(), { sceneId: 'a', tier: 'final' });
    expect(appendSceneTakes).not.toHaveBeenCalled();
    expect(out.results[0].ok).toBe(true);
  });
});
