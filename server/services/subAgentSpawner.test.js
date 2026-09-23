// vi.mock() calls are hoisted by Vitest before import evaluation, but are placed
// at the top for clarity and to match the convention in other test files.

// ── Listener-guard suite support (see "CoS event listener rejection guards").
// `initSpawner()` wires the real `task:ready` / `agent:terminate` listeners onto
// the shared `cosEvents` emitter; these mocks keep that wiring off the network,
// the runner socket and the agent store, and let a single test force the one
// rejection it is about.
const listenerGuardState = vi.hoisted(() => ({ loadStateError: null, terminateError: null }));

vi.mock('./providerStatus.js', async (importOriginal) => ({
  ...(await importOriginal()),
  initProviderStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./cosRunnerClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isRunnerAvailable: vi.fn().mockResolvedValue(false),
  isRunnerReachable: vi.fn().mockResolvedValue(false),
  initCosRunnerConnection: vi.fn(),
  onCosRunnerEvent: vi.fn(),
}));

vi.mock('./agentManagement.js', async (importOriginal) => ({
  ...(await importOriginal()),
  cleanupOrphanedAgents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./updateChecker.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isUpdateInProgress: vi.fn().mockReturnValue(false),
}));

vi.mock('./cosForgeSpawnGate.js', async (importOriginal) => ({
  ...(await importOriginal()),
  forgeSpawnHoldReason: vi.fn().mockResolvedValue(null),
}));

vi.mock('./cosState.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadState: vi.fn(async () => {
      if (listenerGuardState.loadStateError) throw listenerGuardState.loadStateError;
      return actual.loadState();
    }),
  };
});

vi.mock('./agentOrchestrator.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnAgentForTask: vi.fn().mockResolvedValue(undefined),
    terminateAgent: vi.fn(async () => {
      if (listenerGuardState.terminateError) throw listenerGuardState.terminateError;
    }),
  };
});

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { isTruthyMeta, isFalsyMeta } from './agentState.js';
import { cosEvents } from './cosEvents.js';
import { initSpawner } from './subAgentSpawner.js';
import { applyAppWorktreeDefault } from './cos.js';

/**
 * Pure decision helpers from the sub-agent spawn path.
 *
 * Kept under this name because it is where these cases were written; each import
 * now names the module that DEFINES the helper. They used to come through
 * `subAgentSpawner.js`'s back-compat barrel, retired in #3450 — a test reaching
 * for a re-export is exactly the kind of consumer that kept that barrel alive.
 *
 * Note: We test the pure functions directly by importing them from production.
 * For functions with complex dependencies (process spawning, file system, etc.)
 * we focus on the decision-making logic that can be unit tested.
 */

// Worktree/PR flag resolution + metadata coercion helpers, exercised through
// the real production helpers (isTruthyMeta/isFalsyMeta/applyAppWorktreeDefault).
describe('Worktree & metadata flag helpers', () => {

  // --- isTruthyMeta helper (imported from production) ---
  describe('isTruthyMeta', () => {
    it('should return true for boolean true', () => {
      expect(isTruthyMeta(true)).toBe(true);
    });

    it('should return true for string "true"', () => {
      expect(isTruthyMeta('true')).toBe(true);
    });

    it('should return false for false', () => {
      expect(isTruthyMeta(false)).toBe(false);
    });

    it('should return false for undefined/null/other values', () => {
      expect(isTruthyMeta(undefined)).toBe(false);
      expect(isTruthyMeta(null)).toBe(false);
      expect(isTruthyMeta('false')).toBe(false);
      expect(isTruthyMeta(1)).toBe(false);
      expect(isTruthyMeta('')).toBe(false);
    });
  });

  // --- isFalsyMeta helper (imported from production) ---
  describe('isFalsyMeta', () => {
    it('should return true for boolean false', () => {
      expect(isFalsyMeta(false)).toBe(true);
    });

    it('should return true for string "false"', () => {
      expect(isFalsyMeta('false')).toBe(true);
    });

    it('should return false for true', () => {
      expect(isFalsyMeta(true)).toBe(false);
    });

    it('should return false for undefined/null/other values', () => {
      expect(isFalsyMeta(undefined)).toBe(false);
      expect(isFalsyMeta(null)).toBe(false);
      expect(isFalsyMeta('true')).toBe(false);
      expect(isFalsyMeta(0)).toBe(false);
      expect(isFalsyMeta('')).toBe(false);
    });
  });

  // --- openPR worktree decision logic (uses imported isTruthyMeta) ---
  describe('openPR/useWorktree decision logic', () => {
    function resolveWorktreeFlags(metadata) {
      const explicitOpenPR = isTruthyMeta(metadata?.openPR);
      const explicitWorktree = isTruthyMeta(metadata?.useWorktree) || explicitOpenPR;
      return { explicitOpenPR, explicitWorktree };
    }

    it('should not use worktree or PR when neither is set', () => {
      const result = resolveWorktreeFlags({});
      expect(result.explicitWorktree).toBe(false);
      expect(result.explicitOpenPR).toBe(false);
    });

    it('should use worktree but not PR when only useWorktree is set', () => {
      const result = resolveWorktreeFlags({ useWorktree: true });
      expect(result.explicitWorktree).toBe(true);
      expect(result.explicitOpenPR).toBe(false);
    });

    it('should imply worktree when openPR is set', () => {
      const result = resolveWorktreeFlags({ openPR: true });
      expect(result.explicitWorktree).toBe(true);
      expect(result.explicitOpenPR).toBe(true);
    });

    it('should use both when both are set', () => {
      const result = resolveWorktreeFlags({ useWorktree: true, openPR: true });
      expect(result.explicitWorktree).toBe(true);
      expect(result.explicitOpenPR).toBe(true);
    });

    it('should handle string "true" values from form/URL params', () => {
      const result = resolveWorktreeFlags({ useWorktree: 'true', openPR: 'true' });
      expect(result.explicitWorktree).toBe(true);
      expect(result.explicitOpenPR).toBe(true);
    });

    it('should not use worktree when useWorktree is false and openPR is false', () => {
      const result = resolveWorktreeFlags({ useWorktree: false, openPR: false });
      expect(result.explicitWorktree).toBe(false);
      expect(result.explicitOpenPR).toBe(false);
    });
  });

  // --- applyAppWorktreeDefault logic (imported from production cos.js) ---
  describe('applyAppWorktreeDefault', () => {
    it('should fill defaults when metadata has no worktree/openPR fields', () => {
      const metadata = {};
      applyAppWorktreeDefault(metadata, { defaultUseWorktree: true, defaultOpenPR: true });
      expect(metadata.useWorktree).toBe(true);
      expect(metadata.openPR).toBe(true);
    });

    it('should not override task-type metadata that is already set', () => {
      const metadata = { useWorktree: false, openPR: false };
      applyAppWorktreeDefault(metadata, { defaultUseWorktree: true, defaultOpenPR: true });
      expect(metadata.useWorktree).toBe(false);
      expect(metadata.openPR).toBe(false);
    });

    it('should enforce openPR=false when useWorktree=false', () => {
      const metadata = { useWorktree: false };
      applyAppWorktreeDefault(metadata, { defaultOpenPR: true });
      expect(metadata.openPR).toBe(false);
    });

    it('should imply useWorktree when defaultOpenPR is true', () => {
      const metadata = {};
      applyAppWorktreeDefault(metadata, { defaultOpenPR: true });
      expect(metadata.useWorktree).toBe(true);
      expect(metadata.openPR).toBe(true);
    });

    it('copies an explicit app PR completion default onto new PR tasks', () => {
      const metadata = {};
      applyAppWorktreeDefault(metadata, { defaultOpenPR: true, defaultPrCompletion: 'leave-open' });
      expect(metadata).toMatchObject({ useWorktree: true, openPR: true, prCompletion: 'leave-open' });
    });

    it('keeps a task-level PR completion pin over the app default', () => {
      // The Schedule tab's "After opening PR" select writes this pin into the
      // interval's taskMetadata — the more specific choice must win.
      const metadata = { prCompletion: 'merge-on-green' };
      applyAppWorktreeDefault(metadata, { defaultOpenPR: true, defaultPrCompletion: 'review-then-merge' });
      expect(metadata.prCompletion).toBe('merge-on-green');
    });

    it('does not invent a disposition for a legacy app default', () => {
      const metadata = {};
      applyAppWorktreeDefault(metadata, { defaultOpenPR: true });
      expect(metadata.prCompletion).toBeUndefined();
    });

    it('should not let defaultUseWorktree:false override explicit openPR:true', () => {
      const metadata = { openPR: true };
      applyAppWorktreeDefault(metadata, { defaultUseWorktree: false });
      // openPR implies useWorktree — app default must not override explicit openPR
      expect(metadata.useWorktree).toBe(true);
      expect(metadata.openPR).toBe(true);
    });

    it('should handle openPR:"true" string the same as boolean true', () => {
      const metadata = { openPR: 'true' };
      applyAppWorktreeDefault(metadata, { defaultUseWorktree: false });
      expect(metadata.useWorktree).toBe(true);
      expect(metadata.openPR).toBe('true');
    });

    it('should leave metadata unchanged when app has no defaults', () => {
      const metadata = { useWorktree: true, openPR: true };
      applyAppWorktreeDefault(metadata, {});
      expect(metadata.useWorktree).toBe(true);
      expect(metadata.openPR).toBe(true);
    });

    it('should default openPR to true when worktree is enabled and defaultOpenPR is not false', () => {
      const metadata = { useWorktree: true };
      applyAppWorktreeDefault(metadata, {});
      expect(metadata.openPR).toBe(true);

      const metadata2 = {};
      applyAppWorktreeDefault(metadata2, { defaultUseWorktree: true });
      expect(metadata2.useWorktree).toBe(true);
      expect(metadata2.openPR).toBe(true);
    });
  });

});


/**
 * `cosEvents` is a plain `EventEmitter` — it neither awaits nor catches what a
 * listener returns, so an `async` listener passed straight to `.on` turns any
 * rejection into a process-level `unhandledRejection`. For `task:ready`, the one
 * chokepoint every spawn emitter funnels through, that also means the queued
 * task is silently never dispatched and the failure carries no task id.
 *
 * These two cases pin the wrapper: they fail if the `.catch` is dropped, or if a
 * new `await` is added ahead of the listener's inner `try`.
 */
describe('CoS event listener rejection guards', () => {
  const flushMicrotasks = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  };

  let logs;
  let unhandled;
  const collectLog = entry => logs.push(entry);
  const collectUnhandled = reason => unhandled.push(reason);

  beforeAll(async () => {
    await initSpawner();
  });

  beforeEach(() => {
    logs = [];
    unhandled = [];
    cosEvents.on('log', collectLog);
    process.on('unhandledRejection', collectUnhandled);
  });

  afterEach(() => {
    cosEvents.off('log', collectLog);
    process.off('unhandledRejection', collectUnhandled);
    listenerGuardState.loadStateError = null;
    listenerGuardState.terminateError = null;
  });

  it('logs a task:ready dispatch failure with the task id instead of leaking a rejection', async () => {
    listenerGuardState.loadStateError = new Error('state read failed');

    cosEvents.emit('task:ready', { id: 'task-x' });
    await flushMicrotasks();

    expect(unhandled).toEqual([]);
    const errors = logs.filter(entry => entry.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('task-x');
    expect(errors[0].message).toContain('state read failed');
    expect(errors[0].taskId).toBe('task-x');
  });

  it('logs an agent:terminate failure with the agent id instead of leaking a rejection', async () => {
    listenerGuardState.terminateError = new Error('Agent not found');

    cosEvents.emit('agent:terminate', 'agent-unknown');
    await flushMicrotasks();

    expect(unhandled).toEqual([]);
    const errors = logs.filter(entry => entry.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('agent-unknown');
    expect(errors[0].message).toContain('Agent not found');
    expect(errors[0].agentId).toBe('agent-unknown');
  });
});
