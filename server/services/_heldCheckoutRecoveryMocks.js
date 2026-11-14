/**
 * Mock factories and their mutable state for the real-Git held-checkout
 * retirement suite (heldCheckoutRecovery.test.js). Not a test file itself.
 *
 * The suite writes its own one-line `vi.mock(...)` calls so Vitest's hoister
 * sees the literal module paths; the factories delegate here. This module must
 * not import any module the suite mocks: a factory imports it while that mocked
 * module is still being resolved.
 */
import { lazyTempDataRoot, makePathsProxy, ownFixtureWork } from '../lib/mockPathsDataRoot.js';

export const owned = ownFixtureWork();

export const SYMLINKS = process.platform !== 'win32';
export const retirementFaults = { onRemove: null, onBranchDelete: null, scheduleWrites: 0, failScheduleWrite: null };
export const injected = { policies: [], schedule: null, app: null, onUnlockedStatus: null, statusReads: 0 };

// Local branch deletion uses PATHS.cos, independently of any checkout path.
export const mockPaths = actual => makePathsProxy(actual, { dataRoot: () => lazyTempDataRoot('portos-held-branch-archives-') });

export const mockExecGit = actual => ({ ...actual,
  execGitSafe: (args, cwd, options) => owned.run('git', () => actual.execGitSafe(args, cwd, options)),
  execGit: async (args, cwd, options) => {
    // Runs before every content read after the first, so a test can change
    // the checkout between admission and the final removal recheck.
    if (injected.onUnlockedStatus && args[0] === 'status' && args[1] === '--porcelain') {
      injected.statusReads = (injected.statusReads || 0) + 1;
      if (injected.statusReads > 1) await injected.onUnlockedStatus();
    }
    if (retirementFaults.onRemove && args[0] === 'worktree' && args[1] === 'remove') await retirementFaults.onRemove();
    if (retirementFaults.onBranchDelete && args[0] === 'push' && args.some(arg => arg.startsWith(':refs/heads/'))) await retirementFaults.onBranchDelete();
    return owned.run('git', () => actual.execGit(args, cwd, options));
  } });

export const mockBranchCompletionPolicy = actual => ({
  ...actual, readBranchCompletionPolicies: async () => injected.policies,
  readBranchCompletionHold: input => actual.readBranchCompletionHold(input, {
    readPolicies: async () => injected.policies,
  }),
});

export const mockTaskScheduleStore = actual => ({
  ...actual,
  loadSchedule: async () => injected.schedule,
  updateSchedule: async mutate => {
    if (++retirementFaults.scheduleWrites === retirementFaults.failScheduleWrite) throw new Error('synthetic receipt persistence failure');
    return (await mutate(injected.schedule)).result;
  },
});
