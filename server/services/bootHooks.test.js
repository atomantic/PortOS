import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  cleanupOrphanedAgents: vi.fn(async () => 2),
  handleOrphanedTask: vi.fn(async () => ({})),
  cleanupMerged: vi.fn(async () => ({ cleaned: ['b'], skipped: [] })),
  recoverRenders: vi.fn(async () => undefined),
  recoverExcerpts: vi.fn(async () => undefined),
  importTopaz: vi.fn(),
  importBlenderHook: vi.fn(),
  initBlenderHook: vi.fn(),
}));
vi.mock('./agent/agentManagement.js', () => ({
  cleanupOrphanedAgents: (...args) => calls.cleanupOrphanedAgents(...args),
  handleOrphanedTask: (...args) => calls.handleOrphanedTask(...args),
}));
vi.mock('./branchReconcile.js', () => ({ cleanupMerged: (...args) => calls.cleanupMerged(...args) }));
vi.mock('./videoGen/topazJob.js', () => {
  calls.importTopaz();
  return { runVideoUpscale: () => 'topaz' };
});
vi.mock('./blenderModels/referenceImageHook.js', () => {
  calls.importBlenderHook();
  return { initBlenderModelReferenceHook: calls.initBlenderHook };
});
vi.mock('./videoGen/upscaleJob.js', () => ({ runVideoUpscale: () => 'ltx' }));
vi.mock('./videoGen/stitchJob.js', () => ({ runVideoStitch: () => 'stitch' }));
vi.mock('./videoGen/verticalJob.js', () => ({ runVideoVertical: () => 'vertical' }));
vi.mock('./loraTraining/index.js', () => ({ runTraining: () => 'training' }));
vi.mock('./videoGen/local.js', () => ({ generateVideo: () => 'videoLocal' }));
vi.mock('./imageGen/local.js', () => ({ generateImage: () => 'imageLocal' }));
vi.mock('./audioGen/local.js', () => ({ generateAudio: () => 'audioLocal' }));
vi.mock('./creativeDirector/videoExecution.js', () => ({ settleVideoAttempt: () => 'settle' }));
vi.mock('./musicVideo/projects.js', () => ({ getProject: () => 'project' }));
vi.mock('./musicVideo/render.js', () => ({ recoverStuckMusicVideoRenders: () => calls.recoverRenders() }));
vi.mock('./musicVideo/excerptRender.js', () => ({ recoverStuckMusicVideoExcerpts: () => calls.recoverExcerpts() }));

// The entry point the queue's runtime table invokes for each registered name.
const ENTRY = {
  topazUpscale: 'runVideoUpscale', ltxUpscale: 'runVideoUpscale', stitch: 'runVideoStitch', vertical: 'runVideoVertical', training: 'runTraining',
  videoLocal: 'generateVideo', imageLocal: 'generateImage', audioLocal: 'generateAudio',
  creativeDirectorVideoExecution: 'settleVideoAttempt', musicVideoProjects: 'getProject',
};

import { registerBootHooks, warmMediaBootHooks } from './bootHooks.js';
import { createMediaJobHookLoader } from './mediaJobQueue/hookRegistry.js';
import {
  MEDIA_RUNTIME_MODULES, QUEUE_IMPORTING_RUNTIMES, loadMediaRuntimeModule,
  registerMediaJobTerminalHooks, registerMediaRuntimeModules,
  requireCosOrphanRecoveryHandlers, requireMediaJobTerminalHooks, requireMergedBranchCleanup, requireMusicVideoRecovery,
} from './bootHookRegistry.js';

describe('boot hook registration (#17499, #18217)', () => {
  // One ordered test: the registries are process-wide, so "before boot" must be observed first.
  it('fails visibly before boot and routes every consumer to its owning module after', async () => {
    expect(() => requireCosOrphanRecoveryHandlers()).toThrow(/not registered/);
    expect(() => requireMergedBranchCleanup()).toThrow(/not registered/);
    expect(() => requireMusicVideoRecovery()).toThrow(/not registered/);
    expect(() => requireMediaJobTerminalHooks()).toThrow(/not registered/);
    await expect(loadMediaRuntimeModule('training')).rejects.toThrow(/not registered/);
    await expect(loadMediaRuntimeModule('videoLocal')).rejects.toThrow(/not registered/);
    await expect(loadMediaRuntimeModule('creativeDirectorVideoExecution')).rejects.toThrow(/not registered/);

    registerBootHooks();

    expect(calls.importTopaz).not.toHaveBeenCalled();
    expect(calls.importBlenderHook).not.toHaveBeenCalled();
    await warmMediaBootHooks();
    expect(calls.importTopaz).toHaveBeenCalledOnce();
    expect(calls.importBlenderHook).toHaveBeenCalledOnce();
    expect(calls.initBlenderHook).not.toHaveBeenCalled();

    const recovery = requireCosOrphanRecoveryHandlers();
    await expect(recovery.cleanupOrphanedAgents()).resolves.toBe(2);
    await recovery.handleOrphanedTask('task-1', 'agent-1', null, { agentMetadata: null });
    expect(calls.handleOrphanedTask).toHaveBeenCalledWith('task-1', 'agent-1', null, { agentMetadata: null });

    await expect(requireMergedBranchCleanup()('/repo', 'sha', [{ branch: 'b' }], { appId: 'app-1' }))
      .resolves.toEqual({ cleaned: ['b'], skipped: [] });
    expect(calls.cleanupMerged).toHaveBeenCalledWith('/repo', 'sha', [{ branch: 'b' }], { appId: 'app-1' });

    await expect(requireMusicVideoRecovery().recoverRenders()).resolves.toBeUndefined();
    await expect(requireMusicVideoRecovery().recoverExcerpts()).resolves.toBeUndefined();
    expect(calls.recoverRenders).toHaveBeenCalledOnce();
    expect(calls.recoverExcerpts).toHaveBeenCalledOnce();

    const checkedNames = [...QUEUE_IMPORTING_RUNTIMES, 'videoLocal', 'imageLocal', 'audioLocal', 'creativeDirectorVideoExecution', 'musicVideoProjects'];
    const runtimes = await Promise.all(checkedNames.map(async name => [name, (await loadMediaRuntimeModule(name))[ENTRY[name]]()]));
    expect(Object.fromEntries(runtimes)).toEqual({
      topazUpscale: 'topaz', ltxUpscale: 'ltx', stitch: 'stitch', vertical: 'vertical', training: 'training',
      videoLocal: 'videoLocal', imageLocal: 'imageLocal', audioLocal: 'audioLocal',
      creativeDirectorVideoExecution: 'settle', musicVideoProjects: 'project',
    });

    const hooks = requireMediaJobTerminalHooks();
    expect(hooks).toHaveLength(27);
    expect(hooks.filter(([matches]) => matches({ params: { blenderModelReference: { modelId: 'm1' } } }))).toHaveLength(1);
    expect(hooks.filter(([matches]) => matches({ params: { deckCard: { deckId: 'd1' } } }))).toHaveLength(2);
    expect(hooks.filter(([matches]) => matches({ owner: 'pipeline:issue-1:comicPages:page1:proof', params: {} }))).toHaveLength(1);
    expect(MEDIA_RUNTIME_MODULES.length).toBeGreaterThanOrEqual(39);

    const ensureHooks = createMediaJobHookLoader();
    const job = { params: { blenderModelReference: { modelId: 'm1' } } };
    await Promise.all([ensureHooks(job), ensureHooks(job)]);
    expect(calls.importBlenderHook).toHaveBeenCalledOnce();
    expect(calls.initBlenderHook).toHaveBeenCalledOnce();
  });

  it('refuses a runtime loader set that omits a kind the queue dispatches and rejects malformed terminal hooks', () => {
    expect(() => registerMediaRuntimeModules({ topazUpscale: () => null })).toThrow(/ltxUpscale, stitch, vertical, training/);
    expect(() => registerMediaJobTerminalHooks('not-an-array')).toThrow(/array of \[matcher, loader\] pairs/);
  });
});
