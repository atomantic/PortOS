/**
 * Cross-module wiring guard: `generateManagedAppImprovementTaskForType`
 * (cosTaskGenerator.js) still COMPOSES the pre-step resolvers that now live in
 * cosTaskPreStepBlocks.js.
 *
 * The extraction moved eight resolvers out of the generator and left the call
 * sites behind. A resolver that is exported from the new module but never
 * re-imported into the generator is a free identifier: the module still LOADS,
 * every source-level guard still passes, and the failure is a ReferenceError on
 * a scheduled task nobody runs in CI. (That exact shape was already latent here
 * — `isTruthyMeta` was destructured in one resolver and used in another.) So the
 * guard has to be a real dispatch through the composed path.
 *
 * branch-reconcile is the case that walks the most of it: the drain cap, the
 * reconcile scan, the convergence gate, and the token renderer that folds the
 * resulting block into the prompt.
 *
 * Isolated file so the mocked leaf graph (taskSchedule / branchReconcile /
 * appActivity) can't leak into the shared cosTaskGenerator suites.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const BRANCH_RECONCILE_TEMPLATE = [
  '# Branch reconcile for {appName}',
  '',
  'Repository: {repoPath}',
  '',
  '## In-flight branches',
  '',
  '{inFlightBranches}',
].join('\n');

vi.mock('./taskPromptService.js', () => ({
  getTaskPrompt: vi.fn(async () => BRANCH_RECONCILE_TEMPLATE),
  getStagePrompt: vi.fn(async () => BRANCH_RECONCILE_TEMPLATE),
}));

const getPerpetualDrainState = vi.fn(async () => ({ signature: null, dispatchCount: 0 }));
const parkPerpetual = vi.fn(async () => {});
const recordPerpetualDispatch = vi.fn(async () => 1);
vi.mock('./taskSchedule.js', () => ({
  INTERVAL_TYPES: { PERPETUAL: 'perpetual', ON_DEMAND: 'on-demand', WEEKLY: 'weekly' },
  getTaskInterval: vi.fn(async () => ({ type: 'perpetual', taskMetadata: {} })),
  stripManagedAgentOptionsFromOverride: vi.fn((_type, meta) => meta),
  recordExecution: vi.fn(async () => {}),
  parkPerpetual: (...a) => parkPerpetual(...a),
  getPerpetualDrainState: (...a) => getPerpetualDrainState(...a),
  recordPerpetualDispatch: (...a) => recordPerpetualDispatch(...a),
}));

vi.mock('./appActivity.js', async (importActual) => ({
  ...(await importActual()),
  updateAppActivity: vi.fn(async () => {}),
}));

vi.mock('./apps.js', async (importActual) => ({
  ...(await importActual()),
  getAppTaskTypeOverrides: vi.fn(async () => ({})),
}));

vi.mock('./codeReview.js', async (importActual) => ({
  ...(await importActual()),
  getCodeReviewDefaults: vi.fn(async () => ({ reviewers: ['codex'], usernames: [], optionalReviewers: [] })),
}));

vi.mock('./taskLearning.js', async (importActual) => ({
  ...(await importActual()),
  getTaskTypeConfidence: vi.fn(async () => ({ autoApprove: true, tier: 'high', reason: 'test' })),
}));

// The reconcile scan is the git/gh-touching half; the classification helpers it
// feeds stay REAL so the block the prompt receives is the real rendering.
const reconcileMock = vi.fn();
vi.mock('./branchReconcile.js', async (importActual) => ({
  ...(await importActual()),
  reconcile: vi.fn((...args) => reconcileMock(...args)),
}));

vi.mock('./agentState.js', async (importActual) => ({
  ...(await importActual()),
  getActiveAgentIds: vi.fn(() => []),
}));

import { generateManagedAppImprovementTaskForType } from './cosTaskGenerator.js';

const APP = { id: 'app-1', name: 'Example App', repoPath: '/tmp/example-repo' };
const STATE = { config: { confidenceAutoApproval: { enabled: false }, idleReviewPriority: 'MEDIUM' } };

const scan = (over = {}) => ({
  defaultBranch: 'main',
  cleaned: [],
  skipped: [],
  wip: [],
  superseded: [],
  inFlight: [{ branch: 'claim/issue-42', state: 'NEEDS_PR', openPr: null, ahead: 3, behind: 0 }],
  ...over,
});

const generate = () =>
  generateManagedAppImprovementTaskForType('branch-reconcile', APP, STATE, { skipPreconditions: true });

describe('generateManagedAppImprovementTaskForType composes the extracted pre-step layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPerpetualDrainState.mockResolvedValue({ signature: null, dispatchCount: 0 });
    reconcileMock.mockResolvedValue(scan());
  });

  it('folds the reconcile pre-step block into the prompt via {inFlightBranches}', async () => {
    const task = await generate();
    expect(task).not.toBeNull();
    // The resolver ran (a missing import would ReferenceError before this) …
    expect(reconcileMock).toHaveBeenCalledWith(APP.repoPath, expect.any(Object));
    // … the convergence gate ran and spent a dispatch …
    expect(recordPerpetualDispatch).toHaveBeenCalled();
    expect(parkPerpetual).not.toHaveBeenCalled();
    // … and the renderer folded its block in, leaving no literal token behind.
    expect(task.description).not.toContain('{inFlightBranches}');
    expect(task.description).toContain('claim/issue-42');
    expect(task.metadata.perpetual).toBe(true);
  });

  it('returns null when the reconcile pre-step parks instead of dispatching', async () => {
    reconcileMock.mockResolvedValue(scan({ inFlight: [] }));
    expect(await generate()).toBeNull();
    expect(parkPerpetual).toHaveBeenCalled();
  });
});
