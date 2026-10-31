import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { attachBareOrigin, materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-local-reconcile-'),
}));
vi.mock('./cosClaimOwnership.js', () => ({ readClaimOwnershipAgents: async () => [] }));
vi.mock('./agentState.js', async importOriginal => ({ ...await importOriginal(), getActiveAgentIds: () => new Set() }));
vi.mock('./cosState.js', () => ({ readAgentsStateForSafetyCheck: async () => ({ trusted: true, agents: {} }) }));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: async () => 'UTC' }));
vi.mock('./apps.js', () => ({ getAppById: async () => null }));
vi.mock('./supersededLedger.js', async importOriginal => ({ ...await importOriginal(), readVerdictLedger: async () => [] }));

import { PATHS } from '../lib/paths.js';
import { resolveBranchReconcileBlock } from './cosTaskPreStepBlocks.js';
import * as schedule from './taskSchedule.js';
import * as outcomes from './branchReconcileOutcome.js';

describe.skipIf(SKIP_HEAVY_INTEGRATION)('machine-local reconciliation completion (two real clones)', () => {
  let scratch;
  let local;
  let peer;
  let app;
  const outcome = async () => JSON.parse(await readFile(join(PATHS.cos, 'task-schedule.json'), 'utf8'))
    .executions['task:branch-reconcile'].perApp[app.id].branchReconcileOutcome;
  const run = () => resolveBranchReconcileBlock(app, 'branch-reconcile', { cleanupMerged: false }, schedule);

  beforeAll(async () => {
    scratch = realpathSync(await mkdtemp(join(tmpdir(), 'portos-local-reconcile-git-')));
    local = join(scratch, 'local');
    await mkdir(local);
    await materializeGitRepo(local);
    const origin = await attachBareOrigin(scratch, local);
    peer = join(scratch, 'peer');
    await execGit(['clone', origin, peer], scratch);
    await execGit(['config', 'user.email', 'test@example.com'], peer);
    await execGit(['config', 'user.name', 'Test'], peer);
    await execGit(['checkout', '-b', 'feature/peer-only'], peer);
    await writeFile(join(peer, 'peer.txt'), 'unpublished-on-local-machine\n');
    await execGit(['add', 'peer.txt'], peer);
    await execGit(['commit', '-m', 'peer work'], peer);
    await execGit(['push', '-u', 'origin', 'feature/peer-only'], peer);
    await execGit(['fetch', 'origin'], local);
    app = { id: 'local-example', name: 'Local example', repoPath: local };
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await cleanupTempDataRoots();
  });

  it('persists a drained local outcome with visible peer-only inventory, but retains a real local checkout hold', async () => {
    const remoteBefore = (await execGit(['ls-remote', '--heads', 'origin'], local)).stdout;
    const peerBefore = (await execGit(['rev-parse', 'HEAD'], peer)).stdout;
    // Upgrade the prior reporting format only after a fresh local/remote scan.
    await outcomes.recordBranchReconcileOutcome(app.id, { status: 'incomplete',
      remaining: [{ branch: 'feature/peer-only', reason: 'remote-branch-held' }] });
    expect(await run()).toEqual({ skip: true });
    expect(await outcome()).toMatchObject({
      status: 'drained', remaining: [], nextAction: null,
      remoteInventory: { reported: [{ branch: 'feature/peer-only', reason: 'unmerged-remote-only' }], reaped: [] },
    });
    expect(await outcomes.getBranchReconcileOutcome(app.id)).toMatchObject(await outcome());
    expect(await run()).toEqual({ skip: true });
    expect(await outcome()).toMatchObject({ status: 'drained', remaining: [],
      remoteInventory: { reported: [{ branch: 'feature/peer-only', reason: 'unmerged-remote-only' }] } });

    const held = join(scratch, 'held-local');
    await execGit(['worktree', 'add', '--detach', held, 'main'], local);
    await execGit(['worktree', 'lock', '--reason', 'explicit local owner handoff', held], local);
    expect(await run()).toEqual({ skip: true });
    expect(await outcome()).toMatchObject({
      status: 'incomplete',
      remaining: expect.arrayContaining([expect.objectContaining({ locked: true, reason: 'worktree-locked' })]),
      remoteInventory: { reported: [{ branch: 'feature/peer-only', reason: 'unmerged-remote-only' }] },
    });
    expect((await execGit(['ls-remote', '--heads', 'origin'], local)).stdout).toBe(remoteBefore);
    expect((await execGit(['rev-parse', 'HEAD'], peer)).stdout).toBe(peerBefore);
    expect((await execGit(['worktree', 'list', '--porcelain'], local)).stdout).toContain('explicit local owner handoff');
  });
});
