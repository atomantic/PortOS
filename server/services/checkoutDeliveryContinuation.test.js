/** Regression: a resumed checkout moves while retaining its private Git
 * generation, then acquires appended commits delivered by the same PR. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { readCompletedCheckoutIdentity } from './completedCheckoutEvidence.js';
import { readCheckoutDeliveryContinuations } from './checkoutDeliveryContinuation.js';
import { reviewedRetirementPolicy } from './branchCompletionPolicy.js';
let root, repo, oldPath, path, head, tip, unrelated, incarnation;
const branch = 'feature/resumed-delivery';
const prUrl = 'https://github.com/example/repo/pull/7';
const started = '2026-01-01T00:00:00.000Z';
const ended = '2026-01-02T00:00:00.000Z';
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'portos-moved-delivery-'));
  repo = join(root, 'repo'); oldPath = join(root, 'previous'); path = join(root, 'current');
  await execGit(['init', '--initial-branch=main', repo], root);
  await execGit(['config', 'user.name', 'Fixture'], repo);
  await execGit(['config', 'user.email', 'fixture@example.com'], repo);
  await execGit(['commit', '--allow-empty', '-m', 'captured work'], repo);
  head = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
  await execGit(['worktree', 'add', '-b', branch, oldPath], repo);
  incarnation = (await readCompletedCheckoutIdentity({ repoPath: repo, branch, path: oldPath, head })).incarnation;
  await execGit(['worktree', 'move', oldPath, path], repo);
  expect((await readCompletedCheckoutIdentity({ repoPath: repo, branch, path, head })).incarnation).toEqual(incarnation);
  await execGit(['commit', '--allow-empty', '-m', 'appended delivered correction'], path);
  tip = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
  const tree = (await execGit(['rev-parse', 'HEAD^{tree}'], repo)).stdout.trim();
  unrelated = (await execGit(['commit-tree', tree, '-m', 'undelivered unrelated history'], repo)).stdout.trim();
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
function fixture() {
  const owner = { id: 'agent-original', taskId: 'task-one', status: 'completed', startedAt: started, completedAt: ended,
    result: { success: false, executionSuccess: true, validationPassed: null }, metadata: {
      instanceId: 'local', sourceWorkspace: repo, workspacePath: oldPath, worktreeBranch: branch,
      prCompletionPolicy: 'merge-on-green', failureCount: 3, completedCheckouts: [] } };
  const successor = { ...structuredClone(owner), id: 'agent-successor', startedAt: '2026-01-03T00:00:00.000Z',
    completedAt: '2026-01-04T00:00:00.000Z', metadata: { ...structuredClone(owner.metadata),
      workspacePath: path, resumedFromAgentId: owner.id } };
  for (const agent of [owner, successor]) agent.metadata.completedCheckouts = [{ version: 1, agentId: agent.id,
    startedAt: agent.startedAt, capturedAt: agent.completedAt, repoPath: repo, path: agent.metadata.workspacePath,
    branch, head, incarnation: structuredClone(incarnation) }];
  const agents = [owner, successor];
  const input = { repoPath: repo, branch, checkoutPath: path, tip, prUrl, verifiedPrHead: tip,
    checkoutIncarnation: structuredClone(incarnation), retirementForge: {
      prUrl, prHead: tip, mergeCommit: tip, defaultHead: tip, defaultBranch: 'main', scopeProof: 'exact-delivered-head' } };
  return { agents, input, owner, successor };
}
describe('moved same-generation completed-owner retirement policy (real Git)', () => {
  it.each(['failed-successor', 'successful-successor', 'new-generation', 'foreign-lineage', 'unrelated-task',
    'ambiguous-lineage', 'undelivered-tip', 'active-owner', 'unproven-capture', 'manual-handoff'])('admits only the proven resumed delivery: %s', async mode => {
    const { agents, input, owner, successor } = fixture();
    if (mode === 'successful-successor') successor.result.success = true;
    if (mode === 'new-generation') owner.metadata.completedCheckouts[0].incarnation.pointer.ino = '999999';
    if (mode === 'foreign-lineage') owner.metadata.instanceId = 'foreign';
    if (mode === 'unrelated-task') owner.taskId = 'another-task';
    if (mode === 'ambiguous-lineage') {
      const duplicate = structuredClone(successor); duplicate.id = 'agent-unrelated';
      duplicate.metadata.completedCheckouts[0].agentId = duplicate.id; agents.push(duplicate);
    }
    if (mode === 'undelivered-tip') {
      input.tip = input.verifiedPrHead = unrelated;
      input.retirementForge.prHead = input.retirementForge.mergeCommit = input.retirementForge.defaultHead = unrelated;
    }
    if (mode === 'active-owner') owner.status = 'running';
    if (mode === 'unproven-capture') owner.metadata.completedCheckouts[0].agentId = 'unbound-agent';
    if (mode === 'manual-handoff') owner.metadata.prCompletionPolicy = 'leave-open';
    const original = structuredClone(agents);
    const deliveryContinuations = await readCheckoutDeliveryContinuations(input, agents);
    const decision = reviewedRetirementPolicy({ ...input, agents, deliveryContinuations });
    const admitted = ['failed-successor', 'successful-successor'].includes(mode);
    if (admitted) {
      expect(deliveryContinuations.find(row => row.agentId === owner.id)).toMatchObject({ capturedHead: head,
        tip, resumeChain: [successor.id, owner.id] });
      expect(decision.reason).toBeNull();
    } else expect(decision.reason).not.toBeNull();
    expect(agents).toEqual(original); // Never rewrite failed execution or refund its budgets.
  });
});
