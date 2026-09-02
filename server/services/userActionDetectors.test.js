import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectIdleLeftoverBranches,
  formatLeftoverBranchSnippet,
  __resetLeftoverBranchCache,
} from './userActionDetectors.js';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'userActionDetectors.js'), 'utf-8');

const leftoverInput = (overrides = {}) => ({
  branch: 'claim/issue-1',
  liveOwnerReason: null,
  ...overrides,
});

const deps = (overrides = {}) => ({
  now: Date.parse('2026-09-02T12:00:00.000Z'),
  getActiveAgentIds: () => [],
  getActiveApps: async () => [
    { id: 'portos-default', repoPath: '/tmp/portos' },
    { id: 'app-acme', repoPath: '/tmp/acme' },
  ],
  getDefaultBranch: async () => 'main',
  gatherBranchState: async (repoPath) => (repoPath === '/tmp/acme' ? [leftoverInput()] : []),
  classifyBranches: (inputs) => inputs.map((input) => ({ ...input, state: 'NEEDS_PR' })),
  listUserActions: async () => [{
    type: 'cos.schedule.trigger',
    actor: 'user',
    target: 'branch-reconcile',
    payload: { appId: 'app-acme' },
    happenedAt: '2026-08-28T10:00:00.000Z',
  }],
  portosRoot: '/tmp/portos',
  ...overrides,
});

describe('detectIdleLeftoverBranches', () => {
  beforeEach(() => __resetLeftoverBranchCache());

  it('never imports or calls reconcile / triggerOnDemandTask', () => {
    expect(SRC).not.toMatch(/\btriggerOnDemandTask\b/);
    expect(SRC).not.toMatch(/\breconcile\s*\(/);
    expect(SRC).not.toMatch(/import\s*\{[^}]*\breconcile\b/);
  });

  it('returns a finding when agents are idle and leftover branches exist', async () => {
    const findings = await detectIdleLeftoverBranches(deps());
    expect(findings).toEqual([{
      appId: 'app-acme',
      leftoverCount: 1,
      lastUserReconcileAt: '2026-08-28T10:00:00.000Z',
      agentsIdle: true,
    }]);
  });

  it('returns nothing while any agent is still running', async () => {
    const gatherBranchState = async () => { throw new Error('must not gather while agents run'); };
    await expect(detectIdleLeftoverBranches(deps({
      getActiveAgentIds: () => ['agent-1'],
      gatherBranchState,
    }))).resolves.toEqual([]);
  });

  it('returns nothing when every leftover branch has a live owner', async () => {
    await expect(detectIdleLeftoverBranches(deps({
      gatherBranchState: async () => [leftoverInput({ liveOwnerReason: 'active-agent' })],
    }))).resolves.toEqual([]);
  });

  it('skips an app whose gather fails rather than throwing', async () => {
    const findings = await detectIdleLeftoverBranches(deps({
      gatherBranchState: async () => { throw new Error('git lock'); },
    }));
    expect(findings).toEqual([]);
  });
});

describe('formatLeftoverBranchSnippet', () => {
  it('renders a compact per-app line, using never when there is no prior reconcile', () => {
    expect(formatLeftoverBranchSnippet([{
      appId: 'app-acme', leftoverCount: 3, lastUserReconcileAt: null, agentsIdle: true,
    }])).toBe('leftover-branches: app app-acme has 3 local branches, agents idle, last manual reconcile never');
  });
});
