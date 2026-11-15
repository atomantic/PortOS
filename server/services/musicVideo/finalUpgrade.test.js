import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finalApprovalPatch } from '../../lib/musicVideoFinalApproval.js';

const state = { project: null };
const updateScene = vi.fn();
const appendSceneTakes = vi.fn();
const selectSceneTake = vi.fn();
const renderSceneClips = vi.fn();
const upscaleHistoryItem = vi.fn();
vi.mock('./projects.js', () => ({ updateScene: (...a) => updateScene(...a), appendSceneTakes: (...a) => appendSceneTakes(...a), selectSceneTake: (...a) => selectSceneTake(...a) }));
vi.mock('./requireProject.js', () => ({ requireProject: async () => state.project }));
vi.mock('./sceneCardRender.js', () => ({ renderSceneClips: (...a) => renderSceneClips(...a) }));
vi.mock('../videoGen/upscaleVideo.js', () => ({ upscaleHistoryItem: (...a) => upscaleHistoryItem(...a) }));

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
    expect(out.shots).toEqual([{ sceneId: 'a', status: 'ready', method: 'upscale', costUsd: 0 }]);
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
});
