import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ cleanupOrphanedAgents: vi.fn(async () => 2), handleOrphanedTask: vi.fn(async () => ({})), cleanupMerged: vi.fn(async () => ({ cleaned: ['b'], skipped: [] })) }));
vi.mock('./agent/agentManagement.js', () => ({
  cleanupOrphanedAgents: (...args) => calls.cleanupOrphanedAgents(...args),
  handleOrphanedTask: (...args) => calls.handleOrphanedTask(...args),
}));
vi.mock('./branchReconcile.js', () => ({ cleanupMerged: (...args) => calls.cleanupMerged(...args) }));
vi.mock('./videoGen/topazJob.js', () => ({ runVideoUpscale: () => 'topaz' }));
vi.mock('./videoGen/upscaleJob.js', () => ({ runVideoUpscale: () => 'ltx' }));
vi.mock('./videoGen/stitchJob.js', () => ({ runVideoStitch: () => 'stitch' }));
vi.mock('./videoGen/verticalJob.js', () => ({ runVideoVertical: () => 'vertical' }));
vi.mock('./loraTraining/index.js', () => ({ runTraining: () => 'training' }));

// The entry point the queue's runtime table invokes for each registered name.
const ENTRY = { topazUpscale: 'runVideoUpscale', ltxUpscale: 'runVideoUpscale', stitch: 'runVideoStitch', vertical: 'runVideoVertical', training: 'runTraining' };

import { registerBootHooks } from './bootHooks.js';
import {
  QUEUE_IMPORTING_RUNTIMES, loadMediaRuntimeModule, registerMediaRuntimeModules, requireCosOrphanRecoveryHandlers, requireMergedBranchCleanup,
} from './bootHookRegistry.js';

describe('boot hook registration (#17499)', () => {
  // One ordered test: the registries are process-wide, so "before boot" must be observed first.
  it('fails visibly before boot and routes every consumer to its owning module after', async () => {
    expect(() => requireCosOrphanRecoveryHandlers()).toThrow(/not registered/);
    expect(() => requireMergedBranchCleanup()).toThrow(/not registered/);
    await expect(loadMediaRuntimeModule('training')).rejects.toThrow(/not registered/);

    registerBootHooks();

    const recovery = requireCosOrphanRecoveryHandlers();
    await expect(recovery.cleanupOrphanedAgents()).resolves.toBe(2);
    await recovery.handleOrphanedTask('task-1', 'agent-1', null, { agentMetadata: null });
    expect(calls.handleOrphanedTask).toHaveBeenCalledWith('task-1', 'agent-1', null, { agentMetadata: null });

    await expect(requireMergedBranchCleanup()('/repo', 'sha', [{ branch: 'b' }], { appId: 'app-1' }))
      .resolves.toEqual({ cleaned: ['b'], skipped: [] });
    expect(calls.cleanupMerged).toHaveBeenCalledWith('/repo', 'sha', [{ branch: 'b' }], { appId: 'app-1' });

    const runtimes = await Promise.all(QUEUE_IMPORTING_RUNTIMES.map(async name => [name, (await loadMediaRuntimeModule(name))[ENTRY[name]]()]));
    expect(Object.fromEntries(runtimes)).toEqual({ topazUpscale: 'topaz', ltxUpscale: 'ltx', stitch: 'stitch', vertical: 'vertical', training: 'training' });
  });

  it('refuses a runtime loader set that omits a kind the queue dispatches', () => {
    expect(() => registerMediaRuntimeModules({ topazUpscale: () => null })).toThrow(/ltxUpscale, stitch, vertical, training/);
  });
});
