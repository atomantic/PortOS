import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  cleanupOrphanedAgents: vi.fn(async () => 2),
  handleOrphanedTask: vi.fn(async () => ({})),
  cleanupMerged: vi.fn(async () => ({ cleaned: ['b'], skipped: [] })),
  recoverRenders: vi.fn(async () => undefined),
  recoverExcerpts: vi.fn(async () => undefined),
  restoreCredentialLock: vi.fn(async operation => operation()),
  importTopaz: vi.fn(),
  importBlenderHook: vi.fn(),
  initBlenderHook: vi.fn(),
  initCharacterSheetHook: vi.fn(),
  readJSONFile: vi.fn(),
  atomicWrite: vi.fn(),
}));
vi.mock('./apps.js', () => ({ getAppById: vi.fn() }));
vi.mock('../lib/fileUtils.js', async importOriginal => ({
  ...(await importOriginal()),
  ensureDir: vi.fn(),
  readJSONFile: calls.readJSONFile,
  atomicWrite: calls.atomicWrite,
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
vi.mock('./universeCharacterSheet.js', () => ({ initCharacterSheetCompletionHook: calls.initCharacterSheetHook }));
vi.mock('./videoGen/falUpscaleJob.js', () => ({ runVideoUpscale: () => 'fal-seedvr2' }));
vi.mock('./videoGen/realesrganUpscaleJob.js', () => ({ runVideoUpscale: () => 'realesrgan' }));
vi.mock('./videoGen/upscaleJob.js', () => ({ runVideoUpscale: () => 'ltx' }));
vi.mock('./videoGen/stitchJob.js', () => ({ runVideoStitch: () => 'stitch' }));
vi.mock('./videoGen/verticalJob.js', () => ({ runVideoVertical: () => 'vertical' }));
vi.mock('./videoGen/local.js', () => ({ generateVideo: () => 'videoLocal' }));
vi.mock('./imageGen/local.js', () => ({ generateImage: () => 'imageLocal' }));
vi.mock('./audioGen/local.js', () => ({ generateAudio: () => 'audioLocal' }));
vi.mock('./creativeDirector/videoExecution.js', () => ({ settleVideoAttempt: () => 'settle' }));
vi.mock('./musicVideo/projects.js', () => ({ getProject: () => 'project' }));
vi.mock('./musicVideo/render.js', () => ({ recoverStuckMusicVideoRenders: () => calls.recoverRenders() }));
vi.mock('./musicVideo/excerptRender.js', () => ({ recoverStuckMusicVideoExcerpts: () => calls.recoverExcerpts() }));
vi.mock('./managedVisitors.js', () => ({
  getManagedVisitorBroker: () => ({ withLiveCredentialRestore: operation => calls.restoreCredentialLock(operation) }),
}));

// The entry point the queue's runtime table invokes for each registered name.
const ENTRY = {
  topazUpscale: 'runVideoUpscale', falUpscale: 'runVideoUpscale', realesrganUpscale: 'runVideoUpscale', ltxUpscale: 'runVideoUpscale', stitch: 'runVideoStitch', vertical: 'runVideoVertical',
  videoLocal: 'generateVideo', imageLocal: 'generateImage', audioLocal: 'generateAudio',
  creativeDirectorVideoExecution: 'settleVideoAttempt', musicVideoProjects: 'getProject',
};

import { CLOUD_VIDEO_GEN_MODES } from '../lib/generationModes.js';
import { getGenModuleForJob } from './mediaJobQueue/execution.js';
import { videoBackendJobParams } from './videoGen/backendPin.js';
import { HOSTED_VIDEO_SUBMISSIONS } from './videoGen/hostedSubmission.js';
import { registerBootHooks, warmMediaBootHooks } from './bootHooks.js';
import { cosEvents } from './cos/cosEvents.js';
import { createMediaJobHookLoader } from './mediaJobQueue/hookRegistry.js';
import {
  MEDIA_RUNTIME_MODULES, QUEUE_IMPORTING_RUNTIMES, loadMediaRuntimeModule,
  registerMediaJobTerminalHooks, registerMediaRuntimeModules,
  requireCosOrphanRecoveryHandlers, requireManagedVisitorCredentialRestore,
  requireMediaJobTerminalHooks, requireMergedBranchCleanup, requireMusicVideoRecovery,
} from './bootHookRegistry.js';

describe('boot hook registration (#17499, #18217)', () => {
  // One ordered test: the registries are process-wide, so "before boot" must be observed first.
  it('fails visibly before boot and routes every consumer to its owning module after', async () => {
    expect(() => requireCosOrphanRecoveryHandlers()).toThrow(/not registered/);
    expect(() => requireMergedBranchCleanup()).toThrow(/not registered/);
    expect(() => requireMusicVideoRecovery()).toThrow(/not registered/);
    expect(() => requireManagedVisitorCredentialRestore()).toThrow(/not registered/);
    expect(() => requireMediaJobTerminalHooks()).toThrow(/not registered/);
    await expect(loadMediaRuntimeModule('videoLocal')).rejects.toThrow(/not registered/);
    await expect(loadMediaRuntimeModule('creativeDirectorVideoExecution')).rejects.toThrow(/not registered/);

    registerBootHooks();

    expect(calls.importTopaz).not.toHaveBeenCalled();
    expect(calls.importBlenderHook).not.toHaveBeenCalled();
    await warmMediaBootHooks();
    expect(calls.importTopaz).toHaveBeenCalledOnce();
    expect(calls.importBlenderHook).toHaveBeenCalledOnce();
    expect(calls.initBlenderHook).not.toHaveBeenCalled();
    expect(calls.initCharacterSheetHook).not.toHaveBeenCalled();

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

    const restored = await requireManagedVisitorCredentialRestore()(() => Promise.resolve('restored'));
    expect(restored).toBe('restored');
    expect(calls.restoreCredentialLock).toHaveBeenCalledOnce();

    const checkedNames = [...QUEUE_IMPORTING_RUNTIMES, 'videoLocal', 'imageLocal', 'audioLocal', 'creativeDirectorVideoExecution', 'musicVideoProjects'];
    const runtimes = await Promise.all(checkedNames.map(async name => [name, (await loadMediaRuntimeModule(name))[ENTRY[name]]()]));
    expect(Object.fromEntries(runtimes)).toEqual({
      topazUpscale: 'topaz', falUpscale: 'fal-seedvr2', realesrganUpscale: 'realesrgan', ltxUpscale: 'ltx', stitch: 'stitch', vertical: 'vertical',
      videoLocal: 'videoLocal', imageLocal: 'imageLocal', audioLocal: 'audioLocal',
      creativeDirectorVideoExecution: 'settle', musicVideoProjects: 'project',
    });

    const hooks = requireMediaJobTerminalHooks();
    expect(hooks).toHaveLength(28);
    expect(hooks.filter(([matches]) => matches({ params: { blenderModelReference: { modelId: 'm1' } } }))).toHaveLength(1);
    expect(hooks.filter(([matches]) => matches({ params: { deckCard: { deckId: 'd1' } } }))).toHaveLength(2);
    expect(hooks.filter(([matches]) => matches({ owner: 'pipeline:issue-1:comicPages:page1:proof', params: {} }))).toHaveLength(1);
    expect(MEDIA_RUNTIME_MODULES).not.toContain('training');
    await expect(loadMediaRuntimeModule('training')).rejects.toThrow(/not registered/);

    const ensureHooks = createMediaJobHookLoader();
    const job = { params: { blenderModelReference: { modelId: 'm1' } } };
    await Promise.all([ensureHooks(job), ensureHooks(job)]);
    expect(calls.importBlenderHook).toHaveBeenCalledOnce();
    expect(calls.initBlenderHook).toHaveBeenCalledOnce();
  });

  it.each(CLOUD_VIDEO_GEN_MODES)('wires %s through creative pins, hosted submissions and queue dispatch', async (mode) => {
    registerBootHooks();
    const params = videoBackendJobParams({}, { mode }, { prompt: 'A lighthouse', mode: 'text' });
    expect(params).toMatchObject({ mode, videoMode: 'text' });
    expect(HOSTED_VIDEO_SUBMISSIONS).toHaveProperty(mode);
    const runtime = await getGenModuleForJob({ kind: 'video', params });
    const expectedRuntime = await loadMediaRuntimeModule(`video${mode[0].toUpperCase()}${mode.slice(1)}`);
    expect(runtime).toBe(expectedRuntime);
    expect(runtime.generateVideo).toBeTypeOf('function');
  });

  it('clears a restored feature-agent run without a route import or scheduled dequeue', async () => {
    const agent = { id: 'fa-example', name: 'Example feature', currentAgentId: 'restored-agent', runCount: 1 };
    calls.readJSONFile.mockResolvedValue({ version: 1, agents: [agent] });
    registerBootHooks();

    const recorded = once(cosEvents, 'feature-agent:run-complete');
    expect(cosEvents.emit('agent:completed', {
      id: agent.currentAgentId,
      metadata: { featureAgentId: agent.id, featureAgentRun: true },
      result: { success: true },
    })).toBe(true);

    expect(await recorded).toEqual([expect.objectContaining({ id: agent.id })]);
    expect(calls.atomicWrite).toHaveBeenCalledWith(expect.stringMatching(/feature-agents\.json$/), expect.objectContaining({
      agents: [expect.objectContaining({ currentAgentId: null, runCount: 2 })],
    }));
  });

  it('refuses a runtime loader set that omits a kind the queue dispatches and rejects malformed terminal hooks', () => {
    expect(() => registerMediaRuntimeModules({ topazUpscale: () => null })).toThrow(/ltxUpscale, stitch, vertical/);
    expect(() => registerMediaJobTerminalHooks('not-an-array')).toThrow(/array of \[matcher, loader\] pairs/);
  });
});
