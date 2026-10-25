import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { markLegacyRetirements, applyLegacyRetirementResolutions } from '../lib/legacyRetirementTransition.js';
import { _planLegacyRetirementReconciliation } from './legacyRetirementReconciliation.js';
import migration from '../../scripts/migrations/443-legacy-retirement-record-transition.js';

let root, repo;
const git = async (...args) => (await execGit(args, repo)).stdout.trim();
const save = async (path, value) => writeFile(path, `${JSON.stringify(value)}\n`);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'portos-legacy-retirement-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'fixture@example.test');
  await git('config', 'user.name', 'Fixture');
  await writeFile(join(repo, 'initial.txt'), 'base\n');
  await git('add', '.'); await git('commit', '-m', 'base');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function delivered({ rebased = false, changed = false } = {}) {
  const branch = 'feature/delivered';
  await git('checkout', '-b', branch);
  await writeFile(join(repo, 'feature.txt'), 'delivered feature\n');
  await git('add', '.'); await git('commit', '-m', 'feature');
  const head = await git('rev-parse', 'HEAD');
  await git('checkout', 'main');
  if (rebased) {
    await writeFile(join(repo, 'unrelated.txt'), 'new base\n');
    await git('add', '.'); await git('commit', '-m', 'advance base');
    await git('checkout', '-b', 'feature/reviewed');
    await writeFile(join(repo, 'feature.txt'), changed ? 'different work\n' : 'delivered feature\n');
    await git('add', '.'); await git('commit', '-m', 'reviewed delivery');
    await git('checkout', 'main');
  }
  const prHead = await git('rev-parse', rebased ? 'feature/reviewed' : branch);
  await git('merge', '--squash', rebased ? 'feature/reviewed' : branch);
  await git('commit', '-m', 'merged reviewed feature');
  const mergeCommit = await git('rev-parse', 'HEAD');
  await git('update-ref', '-d', `refs/heads/${branch}`, head);
  if (rebased) await git('update-ref', '-d', 'refs/heads/feature/reviewed', prHead);
  return { row: { path: join(root, 'old-checkout'), branch, head, reason: 'retirement-provenance-unverified',
    createdAt: '2026-01-02T00:00:00.000Z' }, forge: { publishedBranch: branch, prHead, mergeCommit,
    prUrl: 'https://github.com/example/project/pull/42' } };
}

describe('legacy retirement transition at the persisted reconciliation boundary', () => {
  it.each(['squash', 'rebased', 'changed-patch', 'active-owner', 'human-handoff', 'foreign-owner', 'live-checkout', 'new-incident'])(
    'reconciles historical delivery without asserting unrecorded removal: %s', async scenario => {
      const { row, forge } = await delivered({ rebased: ['rebased', 'changed-patch'].includes(scenario), changed: scenario === 'changed-patch' });
      const outcome = { status: 'incomplete', retirementObligations: [row], remaining: [row], retired: [] };
      if (scenario !== 'new-incident') markLegacyRetirements(outcome);
      const owners = scenario === 'active-owner' ? [{ id: 'current-owner', status: 'running', metadata: { claimBranches: [row.branch] } }] : [];
      if (scenario === 'human-handoff') owners.push({ id: 'human-owner', status: 'completed', metadata: {
        branchCompletionPolicy: { branch: row.branch, completion: 'leave-open' },
      } });
      if (scenario === 'foreign-owner') {
        const other = join(root, 'independent-clone');
        await mkdir(other); await execGit(['init'], other);
        owners.push({ id: 'foreign-owner', status: 'running', metadata: { sourceWorkspace: other, claimBranches: [row.branch] } });
      }
      if (scenario === 'live-checkout') { await mkdir(row.path); await writeFile(join(row.path, 'unfinished.txt'), 'new owner work\n'); }
      const input = { repoPath: repo, outcome, agents: owners, trees: [], defaultHead: forge.mergeCommit };
      const plans = await _planLegacyRetirementReconciliation(input, { readMergedDelivery: async () => forge });
      const expected = ['squash', 'rebased', 'foreign-owner'].includes(scenario);
      expect(plans).toHaveLength(expected ? 1 : 0);
      if (!expected) return;
      expect(plans[0].removalVerified).toBe(false);
      expect(plans[0].evidence.kind).toBe(scenario === 'rebased' ? 'merged-patch-equivalence' : 'reviewed-merged-continuation');
      const path = join(root, 'outcome.json');
      await save(path, applyLegacyRetirementResolutions(outcome, plans, '2026-01-03T00:00:00.000Z'));
      const restarted = JSON.parse(await readFile(path, 'utf8'));
      expect(restarted.retirementObligations).toEqual([]);
      expect(restarted.remaining).toEqual([]);
      expect(restarted.retired).toEqual([]); // No manufactured service receipt.
      expect(restarted.legacyRetirementTransition.resolutions[0].observation).toEqual(row);
      expect(await _planLegacyRetirementReconciliation({ ...input, outcome: restarted })).toEqual([]);
      expect(await git('rev-parse', 'main')).toBe(forge.mergeCommit);
    });

  it('uses a unique real receipt to identify a malformed late row, retaining audit history', async () => {
    const { row, forge } = await delivered();
    const malformed = { branch: row.branch, head: row.branch, reason: row.reason, createdAt: row.createdAt };
    const receipt = { ...row, checkoutIdentity: 'a'.repeat(64), branchDeleted: true, archiveDir: null, retiredAt: '2026-01-01T00:00:00.000Z' };
    const outcome = { retirementObligations: [malformed], remaining: [malformed], retired: [receipt] };
    markLegacyRetirements(outcome);
    const plans = await _planLegacyRetirementReconciliation({ repoPath: repo, outcome, agents: [], trees: [], defaultHead: forge.mergeCommit });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ removalVerified: true, evidence: { kind: 'existing-service-receipt', receipt } });
    // A newer reviewed head retired the same physical checkout after this
    // observation. Old intermediate heads are not separate lost checkouts.
    const intermediate = { ...row, head: 'c'.repeat(40), checkoutIdentity: receipt.checkoutIdentity,
      createdAt: '2025-12-31T00:00:00.000Z' };
    const progressed = { retirementObligations: [intermediate], remaining: [intermediate], retired: [receipt] };
    markLegacyRetirements(progressed);
    expect(await _planLegacyRetirementReconciliation({ repoPath: repo, outcome: progressed, agents: [], trees: [], defaultHead: forge.mergeCommit }))
      .toMatchObject([{ removalVerified: true, target: { head: receipt.head }, observation: intermediate }]);
    const changed = { ...malformed, checkoutIdentity: 'b'.repeat(64) };
    const different = { retirementObligations: [changed], remaining: [changed], retired: [receipt] };
    markLegacyRetirements(different);
    expect(await _planLegacyRetirementReconciliation({ repoPath: repo, outcome: different, agents: [], trees: [], defaultHead: forge.mergeCommit })).toEqual([]);
  });

  it('migration freezes only existing records, survives replay, and changes no task policy or worktree', async () => {
    const { row } = await delivered();
    const path = join(root, 'data/cos/task-schedule.json');
    await mkdir(join(root, 'data/cos'), { recursive: true });
    const schedule = { tasks: { 'claim-issue': { enabled: true, failureCount: 3 } }, executions: {
      'task:branch-reconcile': { perApp: { example: { branchReconcileOutcome: { retirementObligations: [row], remaining: [row] } } } },
    } };
    await save(path, schedule);
    expect(await migration.up({ rootDir: root })).toEqual({ marked: 1 });
    const first = await readFile(path, 'utf8');
    expect(await migration.up({ rootDir: root })).toEqual({ marked: 0 });
    expect(await readFile(path, 'utf8')).toBe(first);
    const current = JSON.parse(first);
    expect(current.tasks).toEqual(schedule.tasks);
    expect(current.executions['task:branch-reconcile'].perApp.example.branchReconcileOutcome.remaining).toEqual([row]);
    expect(await git('status', '--porcelain')).toBe('');
  });
});
